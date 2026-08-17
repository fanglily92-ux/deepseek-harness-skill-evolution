import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCandidate, buildPattern } from '../src/candidate-builder.js'

const caseIds = [
  'CASE-0123456789abcdef',
  'CASE-1123456789abcdef',
  'CASE-2123456789abcdef',
]

function candidateRule() {
  return {
    id: 'STR-0001',
    status: 'candidate',
    appliesWhen: { taskKinds: ['skill-review'], failureMechanisms: ['unclear-approval'] },
    action: 'Require an exact candidate identifier.',
    avoid: 'Treating general agreement as promotion approval.',
    evidenceCaseIds: caseIds,
    primaryMetric: 'approval-ambiguity-count',
    baselineValue: 2,
    candidateValue: 0,
    introducedBy: 'EVO-20260817-001',
  }
}

test('buildPattern requires three independent receipts for one mechanism', () => {
  assert.throws(
    () => buildPattern({ skillName: 'optimize-work-strategy', mechanism: 'unclear-approval', caseIds: [caseIds[0], caseIds[0], caseIds[1]], proposedRule: candidateRule() }),
    /three independent case ids/,
  )
})

test('buildCandidate binds the proposal to a deterministic baseline hash and id', () => {
  const pattern = buildPattern({
    skillName: 'optimize-work-strategy',
    mechanism: 'unclear-approval',
    caseIds,
    proposedRule: candidateRule(),
  })
  const baselineCatalog = { schemaVersion: 1, stableVersion: 0, rules: [] }
  const candidate = buildCandidate({
    pattern,
    baselineCatalog,
    evaluationBinding: {
      schemaVersion: 1,
      stableSkillHash: '1'.repeat(64),
      stableStrategiesHash: '2'.repeat(64),
      fixtureManifestHash: '3'.repeat(64),
      evaluationPolicyHash: '4'.repeat(64),
      evaluatorCodeHash: '5'.repeat(64),
      fixtureIds: ['SUP-1', 'SUP-2', 'SUP-3', 'HOLD-1', 'HOLD-2'],
    },
    date: new Date('2026-08-17T00:00:00Z'),
    sequence: 1,
  })

  assert.equal(candidate.id, 'EVO-20260817-001')
  assert.match(candidate.baselineHash, /^[a-f0-9]{64}$/)
  assert.match(candidate.candidateHash, /^[a-f0-9]{64}$/)
  assert.equal(candidate.validationAttempts, 0)
  assert.deepEqual(candidate.caseIds, caseIds)
  assert.equal(candidate.state, 'awaiting-validation')
  assert.equal(candidate.evaluationBinding.stableSkillHash, '1'.repeat(64))
  assert.equal(candidate.evaluationBinding.baselineCatalogHash, candidate.baselineHash)
})
