import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildEvaluationSuite, runPairedEvaluation } from './evaluation-suite.js'
import { assertContainedRegularFile } from './paths.js'
import { hashCanonical } from './integrity.js'
import { createIsolatedRun } from './shadow-runner.js'

const EVALUATOR_VERSION = 'golden-label-v1'

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
  return `You are a policy evaluation arm. Do not call tools. Return exactly one JSON object with no prose: {"decision":"allow"} or {"decision":"deny"}.

Stable Skill instructions:
${candidate.stableSkill}

Stable strategy catalog:
${candidate.stableStrategies}

Additional candidate rule for this arm: ${rule}`
}

export function createChildAgentArmRunner(ctx) {
  return async ({ arm, fixture, candidate, exec, budget }) => {
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
      meta: { cwd: candidate.armRoots[arm], parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
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
      const timeoutMs = Number.isFinite(budget?.timeoutMs) && budget.timeoutMs > 0 ? budget.timeoutMs : 120000
      let timer
      try {
        await Promise.race([
          handle.agent.whenIdle(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new Error('evaluation arm timed out')
              error.code = 'EVALUATION_TIMEOUT'
              reject(error)
            }, timeoutMs)
          }),
        ])
      } catch (error) {
        if (error?.code === 'EVALUATION_TIMEOUT') {
          handle.agent.cancel({ kind: 'hook', reason: 'evolution evaluation timeout' })
          await handle.agent.whenIdle()
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
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
    const stableSkillPath = await assertContainedRegularFile(workspace, join(workspace, '.dsh', 'skills', 'optimize-work-strategy', 'SKILL.md'))
    const stableStrategiesPath = await assertContainedRegularFile(workspace, join(workspace, '.dsh', 'skills', 'optimize-work-strategy', 'references', 'strategies.yaml'))
    const [fixtureRegistry, policy, stableSkill, stableStrategies] = await Promise.all([
      loadRegistry(fixturesDirectory),
      readFile(policyPath, 'utf8').then(JSON.parse),
      readFile(stableSkillPath, 'utf8'),
      readFile(stableStrategiesPath, 'utf8'),
    ])
    const fixtureManifestHash = hashCanonical(fixtureRegistry)
    const binding = { candidateHash: candidate.candidateHash, baselineHash: candidate.baselineHash, fixtureManifestHash, evaluatorVersion: EVALUATOR_VERSION }
    const isolated = await createIsolatedRun({ candidateId: candidate.id, runId: `run-${randomUUID()}`, workspace })
    await Promise.all([
      writeFile(join(isolated.stableRoot, 'evaluation-context.json'), `${JSON.stringify({ stableSkill, stableStrategies, binding }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }),
      writeFile(join(isolated.candidateRoot, 'evaluation-context.json'), `${JSON.stringify({ stableSkill, stableStrategies, proposedRule: candidate.proposedRule, binding }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }),
    ])
    const executableCandidate = {
      ...candidate,
      workspace,
      armRoots: { stable: isolated.stableRoot, candidate: isolated.candidateRoot },
      mechanism: candidate.proposedRule.appliesWhen.failureMechanisms[0],
      stableSkill,
      stableStrategies,
    }
    try {
      const suite = buildEvaluationSuite({ candidate: executableCandidate, fixtureRegistry, policy })
      const paired = await runPairedEvaluation({
        suite,
        environment: { provider: exec?.agent?.options?.provider, model: exec?.agent?.options?.model },
        budget: { maxRuns: policy.maxRunsPerCandidate, maxToolCalls: policy.maxToolCallsPerCandidate, timeoutMs: policy.timeoutMsPerRun },
        runArm: (options) => runArm({ ...options, candidate: executableCandidate, exec }),
      })
      if (paired.status !== 'complete') {
        return { ...paired, binding, comparator: { disagreement: false, mode: 'golden-label' }, allGoldenIncluded: false }
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
        status: 'complete', binding,
        budget: paired.budget,
        comparator: { disagreement: false, mode: 'golden-label' },
        allGoldenIncluded: allGolden.every((id) => fixtureResults.some((result) => result.fixtureId === id)),
        fixtureResults,
      }
    } finally {
      await isolated.cleanup()
    }
  }
}
