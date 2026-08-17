import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEvaluationSuite, runPairedEvaluation } from './evaluation-suite.js'
import { assertContainedRegularFile, resolveWorkbenchPaths } from './paths.js'
import { hashCanonical } from './integrity.js'
import { createIsolatedRun } from './shadow-runner.js'
import { compareBlind, createBlindPair, revealBlindVerdict } from './blind-comparator.js'

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
  const policySupplement = arm === 'candidate'
    ? JSON.stringify(candidate.proposedRule)
    : 'No policy supplement applies.'
  return `You are a policy evaluation arm. Do not call tools. Return exactly one JSON object with no prose: {"decision":"allow"} or {"decision":"deny"}.

Stable Skill instructions:
${candidate.stableSkill}

Stable strategy catalog:
${candidate.stableStrategies}

Policy supplement for this isolated run: ${policySupplement}`
}

function objectiveWinner(stable, candidate) {
  if (stable.criticalPass !== candidate.criticalPass) return candidate.criticalPass ? 'candidate' : 'stable'
  if (stable.primary === candidate.primary) return 'tie'
  return candidate.primary < stable.primary ? 'candidate' : 'stable'
}

async function blindCompareResult(result, binding) {
  const nonce = hashCanonical([binding, result.fixtureId, result.trial])
  const pair = createBlindPair({ stableOutput: result.stable, candidateOutput: result.candidate, nonce })
  const verdict = await compareBlind({
    rubric: { method: 'critical-pass-then-lower-golden-label-error' },
    outputs: pair.outputs,
    judge: async ({ outputs }) => {
      const rank = (value) => [value.criticalPass === true ? 0 : 1, value.primary]
      const left = rank(outputs.A)
      const right = rank(outputs.B)
      if (left[0] === right[0] && left[1] === right[1]) return { winner: 'tie', reasonCode: 'OBJECTIVE_TIE' }
      return { winner: left[0] < right[0] || (left[0] === right[0] && left[1] < right[1]) ? 'A' : 'B', reasonCode: 'OBJECTIVE_SCORE' }
    },
  })
  const revealed = revealBlindVerdict({ verdict, mapping: pair.mapping, nonce, sealedMappingHash: pair.sealedMappingHash })
  return {
    winner: revealed.winner,
    reasonCode: revealed.reasonCode,
    sealedMappingHash: pair.sealedMappingHash,
    disagreement: revealed.winner !== objectiveWinner(result.stable, result.candidate),
  }
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

async function hashEvaluatorCode() {
  const sources = await Promise.all([
    import.meta.url,
    new URL('./evaluation-suite.js', import.meta.url),
    new URL('./validator.js', import.meta.url),
    new URL('./blind-comparator.js', import.meta.url),
  ].map((url) => readFile(fileURLToPath(url), 'utf8')))
  return hashCanonical(sources)
}

export function createHarnessEvaluator({ ctx, workspace, authorityRoot, fixturesDirectory, policyPath, runArm = createChildAgentArmRunner(ctx) }) {
  async function readInputs() {
    const paths = resolveWorkbenchPaths(workspace, { authorityRoot })
    const stableSkillPath = await assertContainedRegularFile(paths.authorityRoot, paths.stableSkill)
    const stableStrategiesPath = await assertContainedRegularFile(paths.authorityRoot, paths.strategy)
    const [fixtureRegistry, policyText, stableSkill, stableStrategies, evaluatorCodeHash] = await Promise.all([
      loadRegistry(fixturesDirectory),
      readFile(policyPath, 'utf8'),
      readFile(stableSkillPath, 'utf8'),
      readFile(stableStrategiesPath, 'utf8'),
      hashEvaluatorCode(),
    ])
    const policy = JSON.parse(policyText)
    const binding = {
      schemaVersion: 1,
      stableSkillHash: hashCanonical(stableSkill),
      stableStrategiesHash: hashCanonical(stableStrategies),
      fixtureManifestHash: hashCanonical(fixtureRegistry),
      evaluationPolicyHash: hashCanonical(policy),
      evaluatorCodeHash,
      evaluatorVersion: EVALUATOR_VERSION,
      fixtureIds: fixtureRegistry.map((fixture) => fixture.id),
    }
    return { fixtureRegistry, policy, stableSkill, stableStrategies, binding }
  }

  const evaluator = async (candidate, exec) => {
    const { fixtureRegistry, policy, stableSkill, stableStrategies, binding: currentBinding } = await readInputs()
    if (hashCanonical(currentBinding) !== hashCanonical((({ baselineCatalogHash: _baseline, candidateHash: _candidate, ...rest }) => rest)(candidate.evaluationBinding ?? {}))) {
      throw new Error('evaluation binding changed after candidate creation')
    }
    const binding = structuredClone(candidate.evaluationBinding)
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
        return { ...paired, binding, comparator: { disagreement: true, mode: 'sealed-blind-golden-label' }, allGoldenIncluded: false }
      }
      const fixtureResults = []
      for (const result of paired.fixtureResults) {
        fixtureResults.push({
          fixtureId: result.fixtureId,
          partition: result.partition,
          golden: result.golden,
          stableCriticalPass: result.stable.criticalPass,
          candidateCriticalPass: result.candidate.criticalPass,
          stablePrimary: result.stable.primary,
          candidatePrimary: result.candidate.primary,
          blindComparison: await blindCompareResult(result, binding),
        })
      }
      const comparatorDisagreement = fixtureResults.some((result) => result.blindComparison.disagreement)
      const allGolden = fixtureRegistry.filter((fixture) => fixture.golden).map((fixture) => fixture.id)
      return {
        status: 'complete', binding,
        budget: paired.budget,
        comparator: { disagreement: comparatorDisagreement, mode: 'sealed-blind-golden-label' },
        allGoldenIncluded: allGolden.every((id) => fixtureResults.some((result) => result.fixtureId === id)),
        fixtureResults,
      }
    } finally {
      await isolated.cleanup()
    }
  }
  evaluator.prepareCandidateBinding = async () => (await readInputs()).binding
  evaluator.verifyCandidateBinding = async (candidate) => {
    const current = (await readInputs()).binding
    const committed = (({ baselineCatalogHash: _baseline, candidateHash: _candidate, ...rest }) => rest)(candidate.evaluationBinding ?? {})
    if (hashCanonical(current) !== hashCanonical(committed)) throw new Error('evaluation binding changed after candidate creation')
    return true
  }
  return evaluator
}
