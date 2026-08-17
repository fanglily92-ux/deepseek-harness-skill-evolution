import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 1
export const RECEIPT_OUTCOMES = Object.freeze(['success', 'partial', 'failure', 'cancelled'])
export const CANDIDATE_STATES = Object.freeze([
  'observing',
  'awaiting-validation',
  'awaiting-approval',
  'promoted',
  'rejected',
  'quarantined',
  'rolled-back',
  'stale',
])

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CASE_ID_PATTERN = /^CASE-[a-f0-9]{16}$/
const CANDIDATE_ID_PATTERN = /^EVO-\d{8}-\d{3}$/

function assertExactFields(value, allowed, kind) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new Error(`unknown ${kind} field: ${field}`)
    }
  }
}

function assertNonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`)
  }
}

export function assertReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('receipt must be an object')
  }
  assertExactFields(
    receipt,
    new Set(['schemaVersion', 'caseId', 'skillName', 'sessionHash', 'turn', 'outcome', 'evidence', 'createdAt']),
    'receipt',
  )
  if (receipt.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported receipt schemaVersion')
  if (!CASE_ID_PATTERN.test(receipt.caseId)) throw new Error('invalid receipt caseId')
  if (typeof receipt.skillName !== 'string' || receipt.skillName.length === 0) throw new Error('invalid receipt skillName')
  if (!SHA256_PATTERN.test(receipt.sessionHash)) throw new Error('invalid receipt sessionHash')
  if (!Number.isInteger(receipt.turn) || receipt.turn < 0) throw new Error('invalid receipt turn')
  if (!RECEIPT_OUTCOMES.includes(receipt.outcome)) throw new Error('invalid receipt outcome')
  if (!receipt.evidence || typeof receipt.evidence !== 'object' || Array.isArray(receipt.evidence)) throw new Error('invalid receipt evidence')
  assertExactFields(receipt.evidence, new Set(['errorClass', 'toolCalls', 'durationMs']), 'evidence')
  if (typeof receipt.evidence.errorClass !== 'string' || receipt.evidence.errorClass.length === 0) throw new Error('invalid evidence errorClass')
  assertNonNegativeNumber(receipt.evidence.toolCalls, 'evidence.toolCalls')
  assertNonNegativeNumber(receipt.evidence.durationMs, 'evidence.durationMs')
  assertNonNegativeNumber(receipt.createdAt, 'createdAt')
  return receipt
}

export function assertCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('candidate must be an object')
  }
  assertExactFields(
    candidate,
    new Set(['schemaVersion', 'id', 'skillName', 'state', 'baselineHash', 'proposedRule', 'caseIds', 'createdAt']),
    'candidate',
  )
  if (candidate.schemaVersion !== SCHEMA_VERSION) throw new Error('unsupported candidate schemaVersion')
  if (!CANDIDATE_ID_PATTERN.test(candidate.id)) throw new Error('invalid candidate id')
  if (typeof candidate.skillName !== 'string' || candidate.skillName.length === 0) throw new Error('invalid candidate skillName')
  if (!CANDIDATE_STATES.includes(candidate.state)) throw new Error('invalid candidate state')
  if (!SHA256_PATTERN.test(candidate.baselineHash)) throw new Error('invalid candidate baselineHash')
  if (!candidate.proposedRule || typeof candidate.proposedRule !== 'object' || Array.isArray(candidate.proposedRule)) throw new Error('invalid candidate proposedRule')
  if (!Array.isArray(candidate.caseIds) || candidate.caseIds.length < 3) throw new Error('candidate requires at least three independent case ids')
  if (new Set(candidate.caseIds).size !== candidate.caseIds.length || candidate.caseIds.some((id) => !CASE_ID_PATTERN.test(id))) {
    throw new Error('candidate requires independent case ids')
  }
  assertNonNegativeNumber(candidate.createdAt, 'createdAt')
  return candidate
}

export function createCandidateId(date, sequence) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('date must be a valid Date')
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new RangeError('candidate sequence must be an integer from 1 through 999')
  }

  const stamp = date.toISOString().slice(0, 10).replaceAll('-', '')
  return `EVO-${stamp}-${String(sequence).padStart(3, '0')}`
}

export function createCaseId(sessionId, turn, skillName) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('sessionId must be a non-empty string')
  }
  if (!Number.isInteger(turn) || turn < 0) {
    throw new RangeError('turn must be a non-negative integer')
  }
  if (typeof skillName !== 'string' || skillName.length === 0) {
    throw new TypeError('skillName must be a non-empty string')
  }

  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, turn, skillName]))
    .digest('hex')
    .slice(0, 16)
  return `CASE-${digest}`
}
