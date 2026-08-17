import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertCandidate,
  assertReceipt,
  createCandidateId,
  createCaseId,
} from '../src/contracts.js'

test('createCandidateId uses the UTC date and zero-pads the sequence', () => {
  assert.equal(
    createCandidateId(new Date('2026-08-17T23:59:00-07:00'), 7),
    'EVO-20260818-007',
  )
})

test('createCandidateId rejects a sequence outside 1 through 999', () => {
  assert.throws(() => createCandidateId(new Date('2026-08-17T00:00:00Z'), 0), /1 through 999/)
  assert.throws(() => createCandidateId(new Date('2026-08-17T00:00:00Z'), 1000), /1 through 999/)
})

test('createCaseId is deterministic without exposing the session identifier', () => {
  const first = createCaseId('synthetic-session-name', 12, 'optimize-work-strategy')
  const second = createCaseId('synthetic-session-name', 12, 'optimize-work-strategy')

  assert.equal(first, second)
  assert.match(first, /^CASE-[a-f0-9]{16}$/)
  assert.equal(first.includes('synthetic-session-name'), false)
})

test('createCaseId changes when a receipt coordinate changes', () => {
  assert.notEqual(
    createCaseId('session-a', 1, 'optimize-work-strategy'),
    createCaseId('session-a', 2, 'optimize-work-strategy'),
  )
})

test('assertReceipt accepts the privacy-bounded receipt contract', () => {
  const receipt = {
    schemaVersion: 1,
    caseId: 'CASE-0123456789abcdef',
    skillName: 'optimize-work-strategy',
    sessionHash: 'a'.repeat(64),
    turn: 2,
    outcome: 'failure',
    evidence: {
      errorClass: 'REWORK',
      userSignal: 'negative',
      toolCalls: 3,
      toolFailures: 0,
      validationCalls: 1,
      durationMs: 1250,
      startSeq: 10,
      endSeq: 20,
    },
    createdAt: 1786924800000,
  }

  assert.equal(assertReceipt(receipt), receipt)
})

test('assertReceipt rejects raw prompt fields and unknown outcome values', () => {
  const receipt = {
    schemaVersion: 1,
    caseId: 'CASE-0123456789abcdef',
    skillName: 'optimize-work-strategy',
    sessionHash: 'a'.repeat(64),
    turn: 2,
    outcome: 'failure',
    evidence: {
      errorClass: 'REWORK',
      userSignal: 'negative',
      toolCalls: 3,
      toolFailures: 0,
      validationCalls: 1,
      durationMs: 1250,
      startSeq: 10,
      endSeq: 20,
    },
    createdAt: 1786924800000,
    rawPrompt: 'must never be stored',
  }

  assert.throws(() => assertReceipt(receipt), /unknown receipt field: rawPrompt/)
  delete receipt.rawPrompt
  receipt.outcome = 'maybe'
  assert.throws(() => assertReceipt(receipt), /outcome/)
})

test('assertCandidate requires an exact state, baseline hash, and independent case ids', () => {
  const candidate = {
    schemaVersion: 1,
    id: 'EVO-20260817-001',
    skillName: 'optimize-work-strategy',
    state: 'awaiting-validation',
    baselineHash: 'b'.repeat(64),
    proposedRule: { id: 'rule-001' },
    caseIds: [
      'CASE-0123456789abcdef',
      'CASE-1123456789abcdef',
      'CASE-2123456789abcdef',
    ],
    createdAt: 1786924800000,
  }

  assert.equal(assertCandidate(candidate), candidate)
  candidate.caseIds[2] = candidate.caseIds[1]
  assert.throws(() => assertCandidate(candidate), /independent case ids/)
})
