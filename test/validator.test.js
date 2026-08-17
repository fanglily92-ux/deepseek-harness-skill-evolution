import test from 'node:test'
import assert from 'node:assert/strict'

import { validateCandidate } from '../src/validator.js'

const candidateHash = 'b'.repeat(64)
const baselineHash = 'a'.repeat(64)
const evaluationBinding = {
  schemaVersion: 1, candidateHash, baselineCatalogHash: baselineHash,
  stableSkillHash: 'c'.repeat(64), stableStrategiesHash: 'd'.repeat(64),
  fixtureManifestHash: 'e'.repeat(64), evaluationPolicyHash: 'f'.repeat(64),
  evaluatorCodeHash: '1'.repeat(64), evaluatorVersion: 'golden-label-v1',
  fixtureIds: ['SUP-1', 'SUP-2', 'SUP-3', 'HOLD-1', 'HOLD-2'],
}

function evaluationReport(overrides = {}) {
  return {
    status: 'complete',
    budget: { exhausted: false },
    comparator: { disagreement: false },
    allGoldenIncluded: true,
    binding: evaluationBinding,
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
  const result = validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash, candidateHash, evaluationBinding, evaluationReport: evaluationReport() })
  assert.equal(result.pass, true)
  assert.equal(result.scorecard.supportStable, 6)
  assert.equal(result.scorecard.supportCandidate, 3)
})

test('validateCandidate fails closed on regression, disagreement, exhausted budget, or omitted golden cases', () => {
  const heldoutRegression = evaluationReport()
  heldoutRegression.fixtureResults[3].candidatePrimary = 1
  const input = (report) => ({ candidateId: 'EVO-20260817-001', baselineHash, candidateHash, evaluationBinding, evaluationReport: report })
  assert.match(validateCandidate(input(heldoutRegression)).reason, /held-out regression/)
  assert.match(validateCandidate(input(evaluationReport({ comparator: { disagreement: true } }))).reason, /comparator disagreement/)
  assert.match(validateCandidate(input(evaluationReport({ budget: { exhausted: true } }))).reason, /budget exhausted/)
  assert.match(validateCandidate(input(evaluationReport({ allGoldenIncluded: false }))).reason, /golden fixtures omitted/)
  assert.match(validateCandidate(input(evaluationReport({ binding: { ...evaluationBinding, candidateHash: 'd'.repeat(64) } }))).reason, /candidate hash mismatch/)
})

test('validateCandidate rejects reports containing raw outputs or prompts', () => {
  const report = evaluationReport({ rawOutput: 'private content' })
  assert.throws(
    () => validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash, candidateHash, evaluationBinding, evaluationReport: report }),
    /forbidden persisted field: rawOutput/,
  )
})
