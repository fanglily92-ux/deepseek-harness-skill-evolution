import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendCandidateRule,
  parseStrategyCatalog,
  rulesOverlap,
  scoreMonotonicity,
  validateStrategyRule,
} from '../src/strategy-rules.js'

function rule(overrides = {}) {
  return {
    id: 'STR-0001',
    status: 'stable',
    appliesWhen: {
      taskKinds: ['skill-review'],
      failureMechanisms: ['unclear-approval'],
    },
    action: 'Require the exact candidate id in the approval request.',
    avoid: 'Treating conversational agreement as promotion approval.',
    evidenceCaseIds: [
      'CASE-0123456789abcdef',
      'CASE-1123456789abcdef',
      'CASE-2123456789abcdef',
    ],
    primaryMetric: 'approval-ambiguity-count',
    baselineValue: 2,
    candidateValue: 0,
    introducedBy: 'EVO-20260817-001',
    ...overrides,
  }
}

test('parseStrategyCatalog accepts the strict JSON subset of YAML 1.2', () => {
  assert.deepEqual(
    parseStrategyCatalog('{"schemaVersion":1,"stableVersion":0,"rules":[]}'),
    { schemaVersion: 1, stableVersion: 0, rules: [] },
  )
})

test('validateStrategyRule rejects empty conditions, unknown fields, and duplicate evidence', () => {
  const empty = rule({ appliesWhen: { taskKinds: [], failureMechanisms: [] } })
  assert.throws(() => validateStrategyRule(empty), /non-empty taskKinds/)

  const unknown = rule({ unexpected: true })
  assert.throws(() => validateStrategyRule(unknown), /unknown strategy rule field: unexpected/)

  const duplicated = rule({
    evidenceCaseIds: [
      'CASE-0123456789abcdef',
      'CASE-1123456789abcdef',
      'CASE-1123456789abcdef',
    ],
  })
  assert.throws(() => validateStrategyRule(duplicated), /three independent evidence cases/)
})

test('rulesOverlap requires a shared task kind and failure mechanism', () => {
  assert.equal(rulesOverlap(rule(), rule({ id: 'STR-0002', status: 'candidate' })), true)
  assert.equal(
    rulesOverlap(rule(), rule({
      id: 'STR-0002',
      status: 'candidate',
      appliesWhen: { taskKinds: ['company-research'], failureMechanisms: ['unclear-approval'] },
    })),
    false,
  )
})

test('appendCandidateRule appends one non-overlapping candidate without mutating stable rules', () => {
  const stable = rule()
  const catalog = { schemaVersion: 1, stableVersion: 1, rules: [stable] }
  const before = JSON.stringify(catalog)
  const candidate = rule({
    id: 'STR-0002',
    status: 'candidate',
    appliesWhen: { taskKinds: ['company-research'], failureMechanisms: ['missing-source'] },
    introducedBy: 'EVO-20260817-002',
  })

  const next = appendCandidateRule(catalog, candidate)

  assert.equal(JSON.stringify(catalog), before)
  assert.deepEqual(next.rules, [stable, candidate])
  assert.equal(next.stableVersion, 1)
})

test('appendCandidateRule rejects overlap and catalogs that already contain non-stable rules', () => {
  const stable = rule()
  const overlapping = rule({ id: 'STR-0002', status: 'candidate' })
  assert.throws(
    () => appendCandidateRule({ schemaVersion: 1, stableVersion: 1, rules: [stable] }, overlapping),
    /overlaps stable rule STR-0001/,
  )
  assert.throws(
    () => appendCandidateRule({ schemaVersion: 1, stableVersion: 1, rules: [overlapping] }, rule({ id: 'STR-0003', status: 'candidate' })),
    /stable catalog contains a non-stable rule/,
  )
})

test('scoreMonotonicity requires non-inferior guardrails and strict primary improvement', () => {
  const baseline = { safety: 1, privacy: 1, approval: 1, criticalQuality: 1, primaryMetric: 2 }

  assert.deepEqual(
    scoreMonotonicity({ baseline, candidate: { ...baseline, primaryMetric: 1 } }),
    { pass: true, reason: 'primary metric improved with non-inferior guardrails' },
  )
  assert.deepEqual(
    scoreMonotonicity({ baseline, candidate: { ...baseline, privacy: 0, primaryMetric: 0 } }),
    { pass: false, reason: 'privacy regressed' },
  )
  assert.deepEqual(
    scoreMonotonicity({ baseline, candidate: { ...baseline } }),
    { pass: false, reason: 'primary metric did not strictly improve' },
  )
  assert.deepEqual(
    scoreMonotonicity({ baseline, candidate: { safety: 1 } }),
    { pass: false, reason: 'missing comparable metric: privacy' },
  )
})
