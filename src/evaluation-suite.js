import { PRIMARY_METRIC_BY_MECHANISM } from './contracts.js'

const FIXTURE_FIELDS = new Set(['id', 'partition', 'mechanism', 'createdAt', 'golden', 'deterministic', 'input', 'expectedDecision'])

function validateFixture(fixture) {
  for (const key of Object.keys(fixture)) {
    if (!FIXTURE_FIELDS.has(key)) throw new Error(`fixture has unknown field: ${key}`)
  }
  if (typeof fixture.id !== 'string' || fixture.id.length === 0) throw new Error('fixture id is required')
  if (!['support', 'heldout'].includes(fixture.partition)) throw new Error('invalid fixture partition')
  if (typeof fixture.mechanism !== 'string' || fixture.mechanism.length === 0) throw new Error('fixture mechanism is required')
  if (!Number.isFinite(fixture.createdAt)) throw new Error('fixture createdAt is required')
  if (typeof fixture.golden !== 'boolean' || typeof fixture.deterministic !== 'boolean') throw new Error('fixture flags must be boolean')
  if (fixture.input !== undefined && (typeof fixture.input !== 'string' || fixture.input.length === 0)) throw new Error('fixture input must be non-empty')
  if (fixture.expectedDecision !== undefined && !['allow', 'deny'].includes(fixture.expectedDecision)) throw new Error('invalid expectedDecision')
}

export function buildEvaluationSuite({ candidate, fixtureRegistry, policy }) {
  if (!Array.isArray(fixtureRegistry)) throw new Error('fixtureRegistry must be an array')
  for (const fixture of fixtureRegistry) validateFixture(fixture)
  const fixedMetric = PRIMARY_METRIC_BY_MECHANISM[candidate.mechanism]
  if (!fixedMetric || policy.primaryMetricByMechanism?.[candidate.mechanism] !== fixedMetric || candidate.proposedRule?.primaryMetric !== fixedMetric) {
    throw new Error('candidate primary metric is not bound to the golden-label evaluator')
  }
  const support = fixtureRegistry.filter((fixture) => fixture.partition === 'support' && fixture.mechanism === candidate.mechanism)
  const heldout = fixtureRegistry.filter((fixture) => fixture.partition === 'heldout' && fixture.createdAt < candidate.createdAt)
  if (support.length < policy.supportMinimum) throw new Error(`evaluation requires at least ${policy.supportMinimum} support fixtures`)
  if (heldout.length < policy.heldoutMinimum) throw new Error(`evaluation requires at least ${policy.heldoutMinimum} held-out fixtures`)
  const golden = fixtureRegistry.filter((fixture) => fixture.golden)
  if (golden.some((fixture) => !heldout.includes(fixture) && !support.includes(fixture))) throw new Error('every golden fixture must be included')
  return Object.freeze({ candidateId: candidate.id, support: structuredClone(support), heldout: structuredClone(heldout), policy: structuredClone(policy) })
}

function validEvaluationBudget(budget) {
  return budget
    && Number.isInteger(budget.maxRuns) && budget.maxRuns > 0
    && Number.isInteger(budget.maxToolCalls) && budget.maxToolCalls >= 0
    && Number.isInteger(budget.maxOutputTokensPerArm) && budget.maxOutputTokensPerArm > 0
    && Number.isInteger(budget.maxPromptCharsPerArm) && budget.maxPromptCharsPerArm > 0
    && Number.isInteger(budget.maxMeteredTokens) && budget.maxMeteredTokens > 0
    && Number.isFinite(budget.timeoutMs) && budget.timeoutMs > 0
}

function normalizedUsage(result) {
  const usage = result?.usage
  if (!usage || ['inputTokens', 'outputTokens', 'cacheReadTokens'].some((name) => !Number.isFinite(usage[name]) || usage[name] < 0)) {
    const error = new Error('arm did not report normalized token usage')
    error.code = 'TOKEN_USAGE_UNAVAILABLE'
    throw error
  }
  return usage
}

export async function runPairedEvaluation({ suite, environment, budget, runArm, firstArm = () => Math.random() < 0.5 ? 'stable' : 'candidate' }) {
  if (typeof runArm !== 'function') throw new Error('runArm is required')
  const emptyUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, meteredTokens: 0 }
  if (!validEvaluationBudget(budget)) {
    return { status: 'inconclusive', reason: 'invalid evaluation budget', budget: { ...budget, actualRuns: 0, usage: emptyUsage, exhausted: false }, fixtureResults: [] }
  }
  const fixtures = [...suite.support, ...suite.heldout]
  const plannedRuns = fixtures.reduce((total, fixture) => total + (fixture.deterministic ? 2 : suite.policy.stochasticTrials * 2), 0)
  if (plannedRuns > budget.maxRuns) {
    return { status: 'inconclusive', reason: 'budget exhausted', budget: { ...budget, actualRuns: 0, usage: emptyUsage, exhausted: true }, fixtureResults: [] }
  }
  const fixtureResults = []
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, meteredTokens: 0 }
  let actualRuns = 0
  const executeArm = async (options) => {
    const result = await runArm(options)
    actualRuns += 1
    const armUsage = normalizedUsage(result)
    for (const name of ['inputTokens', 'outputTokens', 'cacheReadTokens']) {
      usage[name] += armUsage[name]
    }
    usage.meteredTokens = usage.inputTokens + usage.outputTokens
    if (armUsage.outputTokens > budget.maxOutputTokensPerArm || usage.meteredTokens >= budget.maxMeteredTokens) {
      const error = new Error('token budget exhausted')
      error.code = 'TOKEN_BUDGET'
      throw error
    }
    return result
  }
  try {
    for (const fixture of fixtures) {
      const trials = fixture.deterministic ? 1 : suite.policy.stochasticTrials
      for (let trial = 1; trial <= trials; trial += 1) {
        const common = { fixture: structuredClone(fixture), trial, environment: structuredClone(environment), budget: structuredClone(budget) }
        const first = firstArm({ fixture: structuredClone(fixture), trial })
        if (!['stable', 'candidate'].includes(first)) throw new Error('firstArm must return stable or candidate')
        const second = first === 'stable' ? 'candidate' : 'stable'
        const results = {}
        results[first] = await executeArm({ ...common, arm: first })
        results[second] = await executeArm({ ...common, arm: second })
        const { stable, candidate } = results
        fixtureResults.push({ fixtureId: fixture.id, partition: fixture.partition, golden: fixture.golden, trial, stable, candidate })
      }
    }
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN'
    const tokenBudgetExhausted = code === 'TOKEN_BUDGET'
    return {
      status: 'inconclusive',
      reason: tokenBudgetExhausted ? 'token budget exhausted' : `external evaluation failure: ${code}`,
      budget: { ...budget, actualRuns, usage, exhausted: tokenBudgetExhausted },
      fixtureResults: [],
    }
  }
  return { status: 'complete', budget: { ...budget, actualRuns, usage, exhausted: false }, fixtureResults }
}
