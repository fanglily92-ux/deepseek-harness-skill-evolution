import { createHash } from 'node:crypto'
import { hashCanonical } from './integrity.js'

const FORBIDDEN_FIELDS = new Set(['rawprompt', 'rawoutput', 'toolarguments', 'tooloutput'])

function rejectForbidden(value) {
  if (Array.isArray(value)) {
    for (const item of value) rejectForbidden(item)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) throw new Error(`forbidden persisted field: ${key}`)
    rejectForbidden(child)
  }
}

function failure(candidateId, baselineHash, reason, scorecard = {}) {
  return { pass: false, candidateId, baselineHash, reason, scorecard }
}

function hasCompleteBudgetEvidence(budget) {
  if (!budget || budget.maxRuns !== 30 || budget.actualRuns !== 30) return false
  if (!Number.isInteger(budget.maxToolCalls) || budget.maxToolCalls < 0) return false
  if (!Number.isInteger(budget.maxOutputTokensPerArm) || budget.maxOutputTokensPerArm < 1 || budget.maxOutputTokensPerArm > 32) return false
  if (!Number.isInteger(budget.maxPromptCharsPerArm) || budget.maxPromptCharsPerArm < 1 || budget.maxPromptCharsPerArm > 8000) return false
  if (!Number.isInteger(budget.maxMeteredTokens) || budget.maxMeteredTokens < 1 || budget.maxMeteredTokens > 100000) return false
  if (!Number.isFinite(budget.timeoutMs) || budget.timeoutMs <= 0) return false
  const usage = budget.usage
  if (!usage || ['inputTokens', 'outputTokens', 'cacheReadTokens', 'meteredTokens'].some((name) => !Number.isFinite(usage[name]) || usage[name] < 0)) return false
  return usage.meteredTokens === usage.inputTokens + usage.outputTokens && usage.meteredTokens < budget.maxMeteredTokens
}

function hasCompleteTrialCardinality(results, fixtureIds) {
  if (!Array.isArray(results) || results.length !== 15 || !Array.isArray(fixtureIds) || fixtureIds.length !== 5 || new Set(fixtureIds).size !== 5) return false
  const allowed = new Set(fixtureIds)
  for (const fixtureId of fixtureIds) {
    const rows = results.filter((result) => result.fixtureId === fixtureId)
    if (rows.length !== 3 || rows.map((result) => result.trial).sort().join(',') !== '1,2,3') return false
  }
  return results.every((result) => allowed.has(result.fixtureId))
}

export function validateCandidate({ candidateId, baselineHash, candidateHash, evaluationBinding, evaluationReport }) {
  rejectForbidden(evaluationReport)
  if (evaluationReport.binding?.candidateHash !== candidateHash) return failure(candidateId, baselineHash, 'candidate hash mismatch')
  if (evaluationReport.binding?.baselineCatalogHash !== baselineHash) return failure(candidateId, baselineHash, 'evaluation baseline hash mismatch')
  if (!evaluationBinding || hashCanonical(evaluationReport.binding) !== hashCanonical(evaluationBinding)) return failure(candidateId, baselineHash, 'evaluation evidence binding mismatch')
  if (evaluationReport.binding?.evaluatorVersion !== 'golden-label-v1') return failure(candidateId, baselineHash, 'evaluator version mismatch')
  if (evaluationReport.status !== 'complete') return failure(candidateId, baselineHash, 'evaluation incomplete')
  if (evaluationReport.stage !== 'full-validation') return failure(candidateId, baselineHash, 'full validation was not completed')
  if (evaluationReport.budget?.exhausted) return failure(candidateId, baselineHash, 'evaluation budget exhausted')
  if (evaluationReport.comparator?.disagreement) return failure(candidateId, baselineHash, 'blind comparator disagreement')
  if (!evaluationReport.allGoldenIncluded) return failure(candidateId, baselineHash, 'golden fixtures omitted')
  if (!hasCompleteBudgetEvidence(evaluationReport.budget) || !hasCompleteTrialCardinality(evaluationReport.fixtureResults, evaluationReport.binding.fixtureIds)) {
    return failure(candidateId, baselineHash, 'full validation requires exactly 30 arms and 15 paired results with complete token evidence')
  }
  const support = evaluationReport.fixtureResults.filter((result) => result.partition === 'support')
  const heldout = evaluationReport.fixtureResults.filter((result) => result.partition === 'heldout')
  if (support.length !== 9 || heldout.length !== 6) return failure(candidateId, baselineHash, 'insufficient support or held-out fixtures')
  for (const result of evaluationReport.fixtureResults) {
    if (result.stableCriticalPass !== true || result.candidateCriticalPass !== true) return failure(candidateId, baselineHash, `critical guardrail failed on ${result.fixtureId}`)
    if (!Number.isFinite(result.stablePrimary) || !Number.isFinite(result.candidatePrimary)) return failure(candidateId, baselineHash, `missing primary metric on ${result.fixtureId}`)
  }
  for (const result of heldout) {
    if (result.candidatePrimary > result.stablePrimary) return failure(candidateId, baselineHash, `held-out regression on ${result.fixtureId}`)
  }
  const scorecard = {
    supportCount: support.length,
    supportStable: support.reduce((sum, result) => sum + result.stablePrimary, 0),
    supportCandidate: support.reduce((sum, result) => sum + result.candidatePrimary, 0),
  }
  if (scorecard.supportCandidate >= scorecard.supportStable) return failure(candidateId, baselineHash, 'primary metric did not strictly improve', scorecard)
  const reportHash = createHash('sha256').update(JSON.stringify(evaluationReport)).digest('hex')
  return { pass: true, candidateId, baselineHash, reason: 'strict improvement with zero held-out regression', scorecard, reportHash }
}
