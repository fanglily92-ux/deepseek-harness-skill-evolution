import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEvaluationSuite, runPairedEvaluation } from '../src/evaluation-suite.js'

const candidate = {
  id: 'EVO-20260817-001',
  createdAt: 100,
  mechanism: 'unclear-approval',
}

function fixture(id, partition, overrides = {}) {
  return {
    id,
    partition,
    mechanism: partition === 'support' ? 'unclear-approval' : 'near-miss',
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
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy: { supportMinimum: 3, heldoutMinimum: 2, stochasticTrials: 3 } })

  assert.deepEqual(suite.support.map((item) => item.id), ['SUP-1', 'SUP-2', 'SUP-3'])
  assert.deepEqual(suite.heldout.map((item) => item.id), ['HOLD-1', 'HOLD-2'])

  assert.throws(
    () => buildEvaluationSuite({ candidate, fixtureRegistry: fixtures.slice(0, 4), policy: { supportMinimum: 3, heldoutMinimum: 2, stochasticTrials: 3 } }),
    /at least 2 held-out fixtures/,
  )
  assert.throws(
    () => buildEvaluationSuite({ candidate, fixtureRegistry: [...fixtures, fixture('GOLD-3', 'heldout', { omitted: true })], policy: { supportMinimum: 3, heldoutMinimum: 2, stochasticTrials: 3 } }),
    /fixture has unknown field: omitted/,
  )
})

test('runPairedEvaluation gives stable and candidate arms the identical environment and budget', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy: { supportMinimum: 3, heldoutMinimum: 2, stochasticTrials: 3 } })
  const calls = []
  const report = await runPairedEvaluation({
    suite,
    environment: { model: 'configured-model', provider: 'configured-provider', toolsHash: 'a'.repeat(64), permissionHash: 'b'.repeat(64) },
    budget: { maxRuns: 10, maxToolCalls: 50, timeoutMs: 1000 },
    runArm: async (input) => {
      calls.push(input)
      return { primaryMetric: input.arm === 'stable' ? 2 : 1, criticalPass: true, outputHash: input.arm === 'stable' ? 'c'.repeat(64) : 'd'.repeat(64) }
    },
  })

  assert.equal(report.status, 'complete')
  assert.equal(calls.length, 10)
  assert.deepEqual(calls[0].environment, calls[1].environment)
  assert.deepEqual(calls[0].budget, calls[1].budget)
})

test('runPairedEvaluation treats provider quota failure as inconclusive instead of regression', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy: { supportMinimum: 3, heldoutMinimum: 2, stochasticTrials: 3 } })
  const report = await runPairedEvaluation({
    suite,
    environment: { model: 'configured-model', provider: 'configured-provider', toolsHash: 'a'.repeat(64), permissionHash: 'b'.repeat(64) },
    budget: { maxRuns: 10, maxToolCalls: 50, timeoutMs: 1000 },
    runArm: async () => {
      const error = new Error('provider unavailable')
      error.code = 'QUOTA'
      throw error
    },
  })

  assert.deepEqual(report, {
    status: 'inconclusive',
    reason: 'external evaluation failure: QUOTA',
    budget: { maxRuns: 10, maxToolCalls: 50, timeoutMs: 1000, exhausted: false },
    fixtureResults: [],
  })
})

test('runPairedEvaluation can execute candidate first without changing arm attribution', async () => {
  const fixtures = [fixture('SUP-1', 'support'), fixture('SUP-2', 'support'), fixture('SUP-3', 'support'), fixture('HOLD-1', 'heldout'), fixture('HOLD-2', 'heldout')]
  const suite = buildEvaluationSuite({ candidate, fixtureRegistry: fixtures, policy: { supportMinimum: 3, heldoutMinimum: 2, stochasticTrials: 3 } })
  const order = []
  const report = await runPairedEvaluation({
    suite, environment: {}, budget: { maxRuns: 10, maxToolCalls: 0, timeoutMs: 1000 },
    firstArm: () => 'candidate',
    runArm: async ({ arm }) => { order.push(arm); return { criticalPass: true, primary: arm === 'stable' ? 1 : 0 } },
  })
  assert.deepEqual(order.slice(0, 2), ['candidate', 'stable'])
  assert.equal(report.fixtureResults[0].stable.primary, 1)
  assert.equal(report.fixtureResults[0].candidate.primary, 0)
})
