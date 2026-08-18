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
  const result = (fixtureId, partition, trial) => ({
    fixtureId,
    partition,
    trial,
    golden: partition === 'heldout',
    stablePrimary: partition === 'support' ? 2 : 0,
    candidatePrimary: partition === 'support' ? 1 : 0,
    stableCriticalPass: true,
    candidateCriticalPass: true,
  })
  return {
    status: 'complete',
    stage: 'full-validation',
    budget: {
      maxRuns: 30, actualRuns: 30, maxToolCalls: 120,
      maxOutputTokensPerArm: 32, maxPromptCharsPerArm: 8000,
      maxMeteredTokens: 100000, timeoutMs: 120000,
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, meteredTokens: 1100 },
      exhausted: false,
    },
    comparator: { disagreement: false },
    allGoldenIncluded: true,
    binding: evaluationBinding,
    fixtureResults: evaluationBinding.fixtureIds.flatMap((fixtureId) => [1, 2, 3].map((trial) => result(fixtureId, fixtureId.startsWith('SUP-') ? 'support' : 'heldout', trial))),
    ...overrides,
  }
}

test('validateCandidate passes only strict support improvement with zero held-out regression', () => {
  const result = validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash, candidateHash, evaluationBinding, evaluationReport: evaluationReport() })
  assert.equal(result.pass, true)
  assert.equal(result.scorecard.supportStable, 18)
  assert.equal(result.scorecard.supportCandidate, 9)
})

test('validateCandidate fails closed on regression, disagreement, exhausted budget, or omitted golden cases', () => {
  const heldoutRegression = evaluationReport()
  heldoutRegression.fixtureResults.find((result) => result.partition === 'heldout').candidatePrimary = 1
  const input = (report) => ({ candidateId: 'EVO-20260817-001', baselineHash, candidateHash, evaluationBinding, evaluationReport: report })
  assert.match(validateCandidate(input(heldoutRegression)).reason, /held-out regression/)
  assert.match(validateCandidate(input(evaluationReport({ comparator: { disagreement: true } }))).reason, /comparator disagreement/)
  assert.match(validateCandidate(input(evaluationReport({ budget: { exhausted: true } }))).reason, /budget exhausted/)
  assert.match(validateCandidate(input(evaluationReport({ allGoldenIncluded: false }))).reason, /golden fixtures omitted/)
  assert.match(validateCandidate(input(evaluationReport({ binding: { ...evaluationBinding, candidateHash: 'd'.repeat(64) } }))).reason, /candidate hash mismatch/)
})

test('validateCandidate rejects a preflight-only report and incomplete trial cardinality', () => {
  const input = (report) => ({ candidateId: 'EVO-20260817-001', baselineHash, candidateHash, evaluationBinding, evaluationReport: report })
  assert.match(validateCandidate(input(evaluationReport({ stage: 'preflight-rejected' }))).reason, /full validation/)
  const missingTrial = evaluationReport()
  missingTrial.fixtureResults.pop()
  assert.match(validateCandidate(input(missingTrial)).reason, /30 arms and 15 paired results/)
  const unsafeBudget = evaluationReport()
  unsafeBudget.budget.maxMeteredTokens = 100001
  assert.match(validateCandidate(input(unsafeBudget)).reason, /30 arms and 15 paired results/)
})

test('validateCandidate rejects reports containing raw outputs or prompts', () => {
  const report = evaluationReport({ rawOutput: 'private content' })
  assert.throws(
    () => validateCandidate({ candidateId: 'EVO-20260817-001', baselineHash, candidateHash, evaluationBinding, evaluationReport: report }),
    /forbidden persisted field: rawOutput/,
  )
})
