import test from 'node:test'
import assert from 'node:assert/strict'

import { validateCandidate } from '../src/validator.js'

function evaluationReport(overrides = {}) {
  return {
    status: 'complete',
    budget: { exhausted: false },
    comparator: { disagreement: false },
    allGoldenIncluded: true,
    fixtureResults: [
      { fixtureId: 'SUP-1', partition: 'support', golden: false, stablePrimary: 2, candidatePrimary: 1, stableCriticalPass: true, candidateCriticalPass: true },
      { fixtureId: 'SUP-2', partition: 'support', golden: false, stablePrimary: 2, candidatePrimary: 1, stableCriticalPass: true, candidateCriticalPass: true },
      { fixtureId: 'SUP-3', partition: 'support', golden: false, stablePrimary: 2, candidatePrimary: 1, stableCriticalPass: true, candidateCriticalPass: true },
      { fixtureId: 'HOLD-1', partition: 'heldout', golden: true, stablePrimary: 0, candidatePrimary: 0, stableCriticalPass: true, candidateCriticalPass: true },
      { fixtureId: 'HOLD-2', partition: 'heldout', golden: true, stablePrimary: 0, candidatePrimary: 0, stableCriticalPass: true, candidateCriticalPass: true },
    ],
    ...overrides,
  }
}

test('validateCandidate passes only strict support improvement with zero held-out regression', () => {
  const result = validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash: 'a'.repeat(64), evaluationReport: evaluationReport() })
  assert.equal(result.pass, true)
  assert.equal(result.scorecard.supportStable, 6)
  assert.equal(result.scorecard.supportCandidate, 3)
})

test('validateCandidate fails closed on regression, disagreement, exhausted budget, or omitted golden cases', () => {
  const heldoutRegression = evaluationReport()
  heldoutRegression.fixtureResults[3].candidatePrimary = 1
  assert.match(validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash: 'a'.repeat(64), evaluationReport: heldoutRegression }).reason, /held-out regression/)
  assert.match(validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash: 'a'.repeat(64), evaluationReport: evaluationReport({ comparator: { disagreement: true } }) }).reason, /comparator disagreement/)
  assert.match(validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash: 'a'.repeat(64), evaluationReport: evaluationReport({ budget: { exhausted: true } }) }).reason, /budget exhausted/)
  assert.match(validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash: 'a'.repeat(64), evaluationReport: evaluationReport({ allGoldenIncluded: false }) }).reason, /golden fixtures omitted/)
})

test('validateCandidate rejects reports containing raw outputs or prompts', () => {
  const report = evaluationReport({ rawOutput: 'private content' })
  assert.throws(
    () => validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash: 'a'.repeat(64), evaluationReport: report }),
    /forbidden persisted field: rawOutput/,
  )
})
