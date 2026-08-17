import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { buildEvaluationSuite, runPairedEvaluation } from './evaluation-suite.js'

function textFromAssistant(event) {
  return event?.data?.message?.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('') ?? ''
}

function parseDecision(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(trimmed)
  if (!parsed || !['allow', 'deny'].includes(parsed.decision) || Object.keys(parsed).some((key) => key !== 'decision')) {
    throw new Error('evaluation response is not an exact decision object')
  }
  return parsed.decision
}

function evaluatorContext(candidate, arm) {
  const rule = arm === 'candidate' ? JSON.stringify(candidate.proposedRule) : 'NONE'
  return `You are a deterministic policy evaluator. Do not call tools. Return exactly one JSON object with no prose: {"decision":"allow"} or {"decision":"deny"}. Apply the stable instructions already present. Additional candidate rule for this arm: ${rule}`
}

export function createChildAgentArmRunner(ctx) {
  return async ({ arm, fixture, candidate, exec }) => {
    if (!exec?.agent?.ctx?.agents || !ctx?.agentPresets) {
      const error = new Error('Harness child-agent services unavailable')
      error.code = 'EVALUATOR_UNAVAILABLE'
      throw error
    }
    if (typeof fixture.input !== 'string' || !['allow', 'deny'].includes(fixture.expectedDecision)) {
      const error = new Error('fixture is not executable')
      error.code = 'INVALID_FIXTURE'
      throw error
    }
    const parent = exec.agent
    const handle = await parent.ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd: candidate.workspace, parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { ...parent.options },
      setup(childCtx) {
        ctx.agentPresets.composeFrom(childCtx, parent.ctx)
        childCtx.tools.guard(() => 'evaluation agents cannot execute tools')
        childCtx.systemPrompt.context({
          name: `evolution:evaluation:${candidate.id}:${arm}`,
          order: 1000,
          text: evaluatorContext(candidate, arm),
        })
      },
    })
    try {
      const prompt = fixture.input.replaceAll('{{candidateId}}', candidate.id)
      handle.agent.followup(Object.freeze({
        id: randomUUID(), role: 'user', source: Object.freeze({ kind: 'user' }),
        content: Object.freeze([{ type: 'text', text: prompt }]),
      }))
      await handle.agent.whenIdle()
      const events = handle.agent.session.events
      const assistant = [...events].reverse().find((event) => event.type === 'assistant/message')
      const toolCalls = events.filter((event) => event.type === 'tool/call').length
      const decision = parseDecision(textFromAssistant(assistant))
      return {
        criticalPass: toolCalls === 0,
        primary: decision === fixture.expectedDecision ? 0 : 1,
      }
    } finally {
      await handle.dispose()
    }
  }
}

async function loadRegistry(fixturesDirectory) {
  const names = (await readdir(fixturesDirectory)).filter((name) => name.endsWith('.json')).sort()
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(fixturesDirectory, name), 'utf8'))))
}

export function createHarnessEvaluator({ ctx, workspace, fixturesDirectory, policyPath, runArm = createChildAgentArmRunner(ctx) }) {
  return async (candidate, exec) => {
    const [fixtureRegistry, policy] = await Promise.all([
      loadRegistry(fixturesDirectory),
      readFile(policyPath, 'utf8').then(JSON.parse),
    ])
    const executableCandidate = {
      ...candidate,
      workspace,
      mechanism: candidate.proposedRule.appliesWhen.failureMechanisms[0],
    }
    const suite = buildEvaluationSuite({ candidate: executableCandidate, fixtureRegistry, policy })
    const paired = await runPairedEvaluation({
      suite,
      environment: { provider: exec?.agent?.options?.provider, model: exec?.agent?.options?.model },
      budget: { maxRuns: policy.maxRunsPerCandidate, maxToolCalls: policy.maxToolCallsPerCandidate, timeoutMs: policy.timeoutMsPerRun },
      runArm: (options) => runArm({ ...options, candidate: executableCandidate, exec }),
    })
    if (paired.status !== 'complete') {
      return { ...paired, comparator: { disagreement: false }, allGoldenIncluded: false }
    }
    const fixtureResults = paired.fixtureResults.map((result) => ({
      fixtureId: result.fixtureId,
      partition: result.partition,
      golden: result.golden,
      stableCriticalPass: result.stable.criticalPass,
      candidateCriticalPass: result.candidate.criticalPass,
      stablePrimary: result.stable.primary,
      candidatePrimary: result.candidate.primary,
    }))
    const allGolden = fixtureRegistry.filter((fixture) => fixture.golden).map((fixture) => fixture.id)
    return {
      status: 'complete',
      budget: paired.budget,
      comparator: { disagreement: false },
      allGoldenIncluded: allGolden.every((id) => fixtureResults.some((result) => result.fixtureId === id)),
      fixtureResults,
    }
  }
}
