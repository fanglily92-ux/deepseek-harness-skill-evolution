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

function validateEvaluationPolicy(policy) {
  const invalid = (field) => { throw new Error(`invalid evaluation policy: ${field}`) }
  if (policy?.schemaVersion !== 1) invalid('schemaVersion')
  if (!policy.primaryMetricByMechanism || typeof policy.primaryMetricByMechanism !== 'object' || Array.isArray(policy.primaryMetricByMechanism)) invalid('primaryMetricByMechanism')
  if (!Number.isInteger(policy.supportMinimum) || policy.supportMinimum !== 3) invalid('supportMinimum')
  if (!Number.isInteger(policy.heldoutMinimum) || policy.heldoutMinimum !== 2) invalid('heldoutMinimum')
  if (!Number.isInteger(policy.stochasticTrials) || policy.stochasticTrials !== 3) invalid('stochasticTrials')
  if (!Number.isInteger(policy.maxRunsPerCandidate) || policy.maxRunsPerCandidate !== 30) invalid('maxRunsPerCandidate')
  if (!Number.isInteger(policy.maxToolCallsPerCandidate) || policy.maxToolCallsPerCandidate < 0) invalid('maxToolCallsPerCandidate')
  if (!Number.isInteger(policy.maxOutputTokensPerArm) || policy.maxOutputTokensPerArm < 1 || policy.maxOutputTokensPerArm > 32) invalid('maxOutputTokensPerArm')
  if (!Number.isInteger(policy.maxPromptCharsPerArm) || policy.maxPromptCharsPerArm < 1 || policy.maxPromptCharsPerArm > 8000) invalid('maxPromptCharsPerArm')
  if (!Number.isInteger(policy.maxMeteredTokensPerCandidate) || policy.maxMeteredTokensPerCandidate < 1 || policy.maxMeteredTokensPerCandidate > 100000) invalid('maxMeteredTokensPerCandidate')
  if (!Number.isFinite(policy.timeoutMsPerRun) || policy.timeoutMsPerRun <= 0) invalid('timeoutMsPerRun')
  return policy
}

function textFromAssistant(event) {
  return event?.data?.message?.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('') ?? ''
}

function usageFromAssistant(event) {
  const raw = event?.data?.usage ?? event?.data?.message?.usage
  if (!raw || !Number.isFinite(raw.inputTokens) || raw.inputTokens < 0 || !Number.isFinite(raw.outputTokens) || raw.outputTokens < 0) {
    const error = new Error('provider did not report token usage')
    error.code = 'TOKEN_USAGE_UNAVAILABLE'
    throw error
  }
  const value = (name) => Number.isFinite(raw[name]) && raw[name] >= 0 ? raw[name] : 0
  return {
    inputTokens: value('inputTokens'),
    outputTokens: value('outputTokens'),
    cacheReadTokens: value('cacheReadTokens'),
  }
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

function preflightImproves(results) {
  if (results.some((result) => result.stable.criticalPass !== true || result.candidate.criticalPass !== true)) return false
  const support = results.filter((result) => result.partition === 'support')
  const heldout = results.filter((result) => result.partition === 'heldout')
  if (heldout.some((result) => result.candidate.primary > result.stable.primary)) return false
  const stableErrors = support.reduce((total, result) => total + result.stable.primary, 0)
  const candidateErrors = support.reduce((total, result) => total + result.candidate.primary, 0)
  return candidateErrors < stableErrors
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
    const contextText = evaluatorContext(candidate, arm)
    const prompt = fixture.input.replaceAll('{{candidateId}}', candidate.id)
    if (!Number.isInteger(budget?.maxPromptCharsPerArm) || budget.maxPromptCharsPerArm < 1 || contextText.length + prompt.length > budget.maxPromptCharsPerArm) {
      const error = new Error('evaluation prompt exceeds the configured token proxy budget')
      error.code = 'TOKEN_BUDGET'
      throw error
    }
    if (!Number.isInteger(budget?.maxOutputTokensPerArm) || budget.maxOutputTokensPerArm < 1) {
      const error = new Error('evaluation output token budget is unavailable')
      error.code = 'TOKEN_BUDGET'
      throw error
    }
    const parent = exec.agent
    const handle = await parent.ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd: candidate.armRoots[arm], parentSession: parent.id, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { ...parent.options, maxTokens: budget.maxOutputTokensPerArm },
      setup(childCtx) {
        ctx.agentPresets.composeFrom(childCtx, parent.ctx)
        childCtx.tools.guard(() => 'evaluation agents cannot execute tools')
        childCtx.systemPrompt.context({
          name: `evolution:evaluation:${candidate.id}:${arm}`,
          order: 1000,
          text: contextText,
        })
      },
    })
    try {
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
      const usage = usageFromAssistant(assistant)
      if (usage.outputTokens > budget.maxOutputTokensPerArm) {
        const error = new Error('evaluation output exceeded its configured token cap')
        error.code = 'TOKEN_BUDGET'
        throw error
      }
      return {
        criticalPass: toolCalls === 0,
        primary: decision === fixture.expectedDecision ? 0 : 1,
        usage,
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
    new URL('./shadow-runner.js', import.meta.url),
    new URL('./contracts.js', import.meta.url),
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
    const policy = validateEvaluationPolicy(JSON.parse(policyText))
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
      const sharedBudget = {
        maxToolCalls: policy.maxToolCallsPerCandidate,
        maxOutputTokensPerArm: policy.maxOutputTokensPerArm,
        maxPromptCharsPerArm: policy.maxPromptCharsPerArm,
        timeoutMs: policy.timeoutMsPerRun,
      }
      const preflight = await runPairedEvaluation({
        suite: { ...suite, policy: { ...suite.policy, stochasticTrials: 1 } },
        environment: { provider: exec?.agent?.options?.provider, model: exec?.agent?.options?.model },
        budget: { maxRuns: 10, maxMeteredTokens: policy.maxMeteredTokensPerCandidate, ...sharedBudget },
        runArm: (options) => runArm({ ...options, candidate: executableCandidate, exec }),
      })
      if (preflight.status !== 'complete') {
        return { ...preflight, stage: 'preflight-inconclusive', binding, comparator: { disagreement: true, mode: 'sealed-blind-golden-label' }, allGoldenIncluded: false }
      }
      let stage = 'preflight-rejected'
      let pairedResults = preflight.fixtureResults
      let confirmation
      if (preflightImproves(preflight.fixtureResults)) {
        const remainingTokens = policy.maxMeteredTokensPerCandidate - (preflight.budget.usage?.meteredTokens ?? 0)
        confirmation = await runPairedEvaluation({
          suite: { ...suite, policy: { ...suite.policy, stochasticTrials: Math.max(0, suite.policy.stochasticTrials - 1) } },
          environment: { provider: exec?.agent?.options?.provider, model: exec?.agent?.options?.model },
          budget: { maxRuns: 20, maxMeteredTokens: remainingTokens, ...sharedBudget },
          runArm: (options) => runArm({ ...options, candidate: executableCandidate, exec }),
        })
        if (confirmation.status !== 'complete') {
          const usage = {
            inputTokens: (preflight.budget.usage?.inputTokens ?? 0) + (confirmation.budget.usage?.inputTokens ?? 0),
            outputTokens: (preflight.budget.usage?.outputTokens ?? 0) + (confirmation.budget.usage?.outputTokens ?? 0),
            cacheReadTokens: (preflight.budget.usage?.cacheReadTokens ?? 0) + (confirmation.budget.usage?.cacheReadTokens ?? 0),
            meteredTokens: (preflight.budget.usage?.meteredTokens ?? 0) + (confirmation.budget.usage?.meteredTokens ?? 0),
          }
          return {
            ...confirmation,
            stage: 'confirmation-inconclusive',
            binding,
            budget: {
              maxRuns: policy.maxRunsPerCandidate,
              maxMeteredTokens: policy.maxMeteredTokensPerCandidate,
              ...sharedBudget,
              actualRuns: (preflight.budget.actualRuns ?? 0) + (confirmation.budget.actualRuns ?? 0),
              usage,
              exhausted: confirmation.budget.exhausted,
            },
            comparator: { disagreement: true, mode: 'sealed-blind-golden-label' },
            allGoldenIncluded: false,
          }
        }
        stage = 'full-validation'
        pairedResults = [
          ...preflight.fixtureResults,
          ...confirmation.fixtureResults.map((result) => ({ ...result, trial: result.trial + 1 })),
        ]
      }
      const fixtureResults = []
      for (const result of pairedResults) {
        fixtureResults.push({
          fixtureId: result.fixtureId,
          partition: result.partition,
          golden: result.golden,
          trial: result.trial,
          stableCriticalPass: result.stable.criticalPass,
          candidateCriticalPass: result.candidate.criticalPass,
          stablePrimary: result.stable.primary,
          candidatePrimary: result.candidate.primary,
          blindComparison: await blindCompareResult(result, binding),
        })
      }
      const comparatorDisagreement = fixtureResults.some((result) => result.blindComparison.disagreement)
      const allGolden = fixtureRegistry.filter((fixture) => fixture.golden).map((fixture) => fixture.id)
      const usage = {
        inputTokens: (preflight.budget.usage?.inputTokens ?? 0) + (confirmation?.budget.usage?.inputTokens ?? 0),
        outputTokens: (preflight.budget.usage?.outputTokens ?? 0) + (confirmation?.budget.usage?.outputTokens ?? 0),
        cacheReadTokens: (preflight.budget.usage?.cacheReadTokens ?? 0) + (confirmation?.budget.usage?.cacheReadTokens ?? 0),
        meteredTokens: (preflight.budget.usage?.meteredTokens ?? 0) + (confirmation?.budget.usage?.meteredTokens ?? 0),
      }
      return {
        status: 'complete', stage, binding,
        budget: { maxRuns: policy.maxRunsPerCandidate, maxMeteredTokens: policy.maxMeteredTokensPerCandidate, ...sharedBudget, actualRuns: fixtureResults.length * 2, usage, exhausted: false },
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
