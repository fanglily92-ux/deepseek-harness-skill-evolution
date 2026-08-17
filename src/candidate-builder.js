import { assertCandidate, createCandidateId } from './contracts.js'
import { hashCanonical, hashCandidateProposal } from './integrity.js'
import { validateStrategyRule } from './strategy-rules.js'

export function buildPattern({ skillName, mechanism, caseIds, proposedRule }) {
  if (typeof skillName !== 'string' || skillName.length === 0) throw new Error('skillName is required')
  if (typeof mechanism !== 'string' || mechanism.length === 0) throw new Error('mechanism is required')
  if (!Array.isArray(caseIds) || caseIds.length < 3 || new Set(caseIds).size !== caseIds.length) {
    throw new Error('pattern requires three independent case ids')
  }
  validateStrategyRule(proposedRule)
  if (proposedRule.status !== 'candidate') throw new Error('proposed rule must be a candidate')
  return Object.freeze({ skillName, mechanism, caseIds: [...caseIds], proposedRule: structuredClone(proposedRule) })
}

export function buildCandidate({ pattern, baselineCatalog, date, sequence }) {
  const id = createCandidateId(date, sequence)
  if (pattern.proposedRule.introducedBy !== id) throw new Error('proposed rule introducedBy must match candidate id')
  const baselineHash = hashCanonical(baselineCatalog)
  const candidate = {
    schemaVersion: 1,
    id,
    skillName: pattern.skillName,
    state: 'awaiting-validation',
    baselineHash,
    candidateHash: hashCandidateProposal(pattern.proposedRule),
    validationAttempts: 0,
    proposedRule: structuredClone(pattern.proposedRule),
    caseIds: [...pattern.caseIds],
    createdAt: date.getTime(),
  }
  assertCandidate(candidate)
  return candidate
}
