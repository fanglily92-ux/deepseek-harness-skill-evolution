import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEvaluationSuite, runPairedEvaluation } from '../src/evaluation-suite.js'

const candidate = {
  id: 'EVO-20260817-001',
  createdAt: 100,
  mechanism: 'UNCLEAR_APPROVAL',
  proposedRule: { primaryMetric: 'golden-label-error-rate' },
}

const policy = { supportMinimum: 3, heldoutMinimum: 2, stochasticTrials: 3, primaryMetricByMechanism: { UNCLEAR_APPROVAL: 'golden-label-error-rate' } }
const evaluationBudget = {
  maxRuns: 10,
  maxToolCalls: 50,
  maxOutputTokensPerArm: 32,
  maxPromptCharsPerArm: 8000,
  maxMeteredTokens: 100000,
  timeoutMs: 1000,
}

function fixture(id, partition, overrides = {}) {
  return {
    id,
    partition,
    mechanism: partition === 'support' ? 'UNCLEAR_APPROVAL' : 'near-miss',
    createdAt: 50,
    golden: partition === 'heldout',
    deterministic: true,
    ...overrides,
  }
}

test('buildEvaluationSuite requires three support fixtures, two pre-existing held-out fixtures, and every golden fixture', () => {
  const fixtures = [
    fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'),
    fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout'),
  ]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })

  assert.deepEqual(suite.support.map((item) => item.id), ['SUP-1', 'SUP-2', 'SUP-3'])
  assert.deepEqual(suite.heldout.map((item) => item.id), ['HOLD-1', 'HOLD-2'])

  assert.throws(
    () => buildEvaluationSuite({ candidate, fixtureRegistry: fixtures.slice(0, 4), policy }),
    /at least 2 held-out fixtures/,
  )
  assert.throws(
    () => buildEvaluationSuite({ candidate, fixtureRegistry: [...fixtures, fixture('GOLD-3', 'heldout', { omitted: true })], policy }),
    /fixture has unknown field: omitted/,
  )
})

test('runPairedEvaluation gives stable and candidate arms the identical environment and budget', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  const calls = []
  const report = await runPairedEvaluation({
    suite,
    environment: { model: 'configured-model', provider: 'configured-provider', toolsHash: 'a'.repeat(64), permissionHash: 'b'.repeat(64) },
    budget: evaluationBudget,
    runArm: async (input) => {
      calls.push(input)
      return { primaryMetric: input.arm === 'stable' ? 2 : 1, criticalPass: true, outputHash: input.arm === 'stable' ? 'c'.repeat(64) : 'd'.repeat(64), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
    },
  })

  assert.equal(report.status, 'complete')
  assert.equal(calls.length, 10)
  assert.deepEqual(calls[0].environment, calls[1].environment)
  assert.deepEqual(calls[0].budget, calls[1].budget)
})

test('runPairedEvaluation treats provider quota failure as inconclusive instead of regression', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  const report = await runPairedEvaluation({
    suite,
    environment: { model: 'configured-model', provider: 'configured-provider', toolsHash: 'a'.repeat(64), permissionHash: 'b'.repeat(64) },
    budget: evaluationBudget,
    runArm: async () => {
      const error = new Error('provider unavailable')
      error.code = 'QUOTA'
      throw error
    },
  })

  assert.deepEqual(report, {
    status: 'inconclusive',
    reason: 'external evaluation failure: QUOTA',
    budget: {
      ...evaluationBudget, actualRuns: 0, exhausted: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, meteredTokens: 0 },
    },
    fixtureResults: [],
  })
})

test('runPairedEvaluation can execute candidate first without changing arm attribution', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  const order = []
  const report = await runPairedEvaluation({
    suite, environment: {}, budget: { ...evaluationBudget, maxToolCalls: 0 },
    firstArm: () => 'candidate',
    runArm: async ({ arm }) => { order.push(arm); return { criticalPass: true, primary: arm === 'stable' ? 1 : 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } } },
  })
  assert.deepEqual(order.slice(0, 2), ['candidate', 'stable'])
  assert.equal(report.fixtureResults[0].stable.primary, 1)
  assert.equal(report.fixtureResults[0].candidate.primary, 0)
})

test('runPairedEvaluation stops when reported input and output usage exceeds the candidate token budget', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  let calls = 0
  const report = await runPairedEvaluation({
    suite,
    environment: {},
    budget: { ...evaluationBudget, maxToolCalls: 0, maxMeteredTokens: 10 },
    runArm: async () => {
      calls += 1
      return { criticalPass: true, primary: 0, usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 20 } }
    },
  })

  assert.equal(calls, 2)
  assert.equal(report.status, 'inconclusive')
  assert.equal(report.reason, 'token budget exhausted')
  assert.equal(report.budget.exhausted, true)
  assert.deepEqual(report.budget.usage, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 40, meteredTokens: 12 })
})

test('runPairedEvaluation fails closed when an arm omits normalized token usage', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  const report = await runPairedEvaluation({
    suite,
    environment: {},
    budget: evaluationBudget,
    runArm: async () => ({ criticalPass: true, primary: 0 }),
  })

  assert.equal(report.status, 'inconclusive')
  assert.equal(report.reason, 'external evaluation failure: TOKEN_USAGE_UNAVAILABLE')
  assert.equal(report.budget.actualRuns, 1)
})

test('runPairedEvaluation fails closed when one arm exceeds its output-token cap', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  const report = await runPairedEvaluation({
    suite,
    environment: {},
    budget: evaluationBudget,
    runArm: async () => ({ criticalPass: true, primary: 0, usage: { inputTokens: 1, outputTokens: 33, cacheReadTokens: 0 } }),
  })

  assert.equal(report.status, 'inconclusive')
  assert.equal(report.reason, 'token budget exhausted')
  assert.equal(report.budget.actualRuns, 1)
})

test('runPairedEvaluation does not start another arm after reaching the metered-token limit', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  let calls = 0
  const report = await runPairedEvaluation({
    suite,
    environment: {},
    budget: { ...evaluationBudget, maxMeteredTokens: 10 },
    runArm: async () => {
      calls += 1
      return { criticalPass: true, primary: 0, usage: { inputTokens: 9, outputTokens: 1, cacheReadTokens: 0 } }
    },
  })

  assert.equal(calls, 1)
  assert.equal(report.status, 'inconclusive')
  assert.equal(report.reason, 'token budget exhausted')
  assert.equal(report.budget.usage.meteredTokens, 10)
})

test('runPairedEvaluation rejects an incomplete budget before starting any arm', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  let calls = 0
  const report = await runPairedEvaluation({
    suite,
    environment: {},
    budget: { maxRuns: 10 },
    runArm: async () => { calls += 1 },
  })

  assert.equal(calls, 0)
  assert.equal(report.status, 'inconclusive')
  assert.equal(report.reason, 'invalid evaluation budget')
})

test('runPairedEvaluation reports zero runs and usage when planned arms exceed the run budget', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy })
  const report = await runPairedEvaluation({
    suite,
    environment: {},
    budget: { ...evaluationBudget, maxRuns: 9 },
    runArm: async () => { throw new Error('must not run') },
  })

  assert.equal(report.status, 'inconclusive')
  assert.equal(report.budget.actualRuns, 0)
  assert.deepEqual(report.budget.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, meteredTokens: 0 })
})
