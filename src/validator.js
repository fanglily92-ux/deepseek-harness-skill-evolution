import { createHash } from 'node:crypto'

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

export function validateCandidate({ candidateId, baselineHash, evaluationReport }) {
  rejectForbidden(evaluationReport)
  if (evaluationReport.status !== 'complete') return failure(candidateId, baselineHash, 'evaluation incomplete')
  if (evaluationReport.budget?.exhausted) return failure(candidateId, baselineHash, 'evaluation budget exhausted')
  if (evaluationReport.comparator?.disagreement) return failure(candidateId, baselineHash, 'blind comparator disagreement')
  if (!evaluationReport.allGoldenIncluded) return failure(candidateId, baselineHash, 'golden fixtures omitted')
  const support = evaluationReport.fixtureResults.filter((result) => result.partition === 'support')
  const heldout = evaluationReport.fixtureResults.filter((result) => result.partition === 'heldout')
  if (support.length < 3 || heldout.length < 2) return failure(candidateId, baselineHash, 'insufficient support or held-out fixtures')
  for (const result of evaluationReport.fixtureResults) {
    if (result.stableCriticalPass !== true || result.candidateCriticalPass !== true) return failure(candidateId, baselineHash, `critical guardrail failed on ${result.fixtureId}`)
    if (!Number.isFinite(result.stablePrimary) || !Number.isFinite(result.candidatePrimary)) return failure(candidateId, baselineHash, `missing primary metric on ${result.fixtureId}`)
  }
  for (const result of heldout) {
    if (result.candidatePrimary > result.stablePrimary) return failure(candidateId, baselineHash, `held-out regression on ${result.fixtureId}`)
  }
  const scorecard = {
    supportStable: support.reduce((sum, result) => sum + result.stablePrimary, 0),
    supportCandidate: support.reduce((sum, result) => sum + result.candidatePrimary, 0),
  }
  if (scorecard.supportCandidate >= scorecard.supportStable) return failure(candidateId, baselineHash, 'primary metric did not strictly improve', scorecard)
  const reportHash = createHash('sha256').update(JSON.stringify(evaluationReport)).digest('hex')
  return { pass: true, candidateId, baselineHash, reason: 'strict improvement with zero held-out regression', scorecard, reportHash }
}
