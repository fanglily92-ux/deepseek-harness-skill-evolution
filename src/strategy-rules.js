const RULE_FIELDS = new Set([
  'id',
  'status',
  'appliesWhen',
  'action',
  'avoid',
  'evidenceCaseIds',
  'primaryMetric',
  'baselineValue',
  'candidateValue',
  'introducedBy',
])
const CASE_ID = /^CASE-[a-f0-9]{16}$/
const CANDIDATE_ID = /^EVO-\d{8}-\d{3}$/
const RULE_ID = /^STR-\d{4}$/
const UNSAFE_ACTIONS = [
  /\b(?:bypass|disable|skip|remove)\b.{0,40}\b(?:approval|test|doctor|rollback|hash|permission)\b/iu,
  /\b(?:read|store|record|expose|send|upload)\b.{0,40}\b(?:api[ _-]?keys?|tokens?|cookies?|passwords?|credentials?|secrets?)\b/iu,
  /\b(?:modify|change|rewrite|register|unregister)\b.{0,40}\b(?:tool|plugin|permission)\b/iu,
  /\b(?:switch|change)\b.{0,40}\b(?:provider|model)\b/iu,
  /(?:绕过|关闭|跳过|删除).{0,20}(?:审批|测试|doctor|回滚|哈希|权限)/u,
  /(?:读取|保存|记录|泄露|上传).{0,20}(?:令牌|密钥|Cookie|密码|凭据)/u,
  /(?:修改|改写|注册|注销).{0,20}(?:工具|插件|权限|模型|provider)/u,
]

function assertExactFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown ${label} field: ${key}`)
  }
}

function assertUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`)
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`)
}

export function validateStrategyRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new TypeError('strategy rule must be an object')
  assertExactFields(rule, RULE_FIELDS, 'strategy rule')
  if (!RULE_ID.test(rule.id)) throw new Error('invalid strategy rule id')
  if (!['stable', 'candidate'].includes(rule.status)) throw new Error('invalid strategy rule status')
  if (!rule.appliesWhen || typeof rule.appliesWhen !== 'object' || Array.isArray(rule.appliesWhen)) throw new Error('invalid appliesWhen')
  assertExactFields(rule.appliesWhen, new Set(['taskKinds', 'failureMechanisms']), 'appliesWhen')
  assertUniqueStrings(rule.appliesWhen.taskKinds, 'appliesWhen requires non-empty taskKinds')
  assertUniqueStrings(rule.appliesWhen.failureMechanisms, 'appliesWhen requires non-empty failureMechanisms')
  if (typeof rule.action !== 'string' || rule.action.trim() === '') throw new Error('action must be non-empty')
  if (UNSAFE_ACTIONS.some((pattern) => pattern.test(rule.action))) throw new Error('unsafe strategy action')
  if (typeof rule.avoid !== 'string' || rule.avoid.trim() === '') throw new Error('avoid must be non-empty')
  if (!Array.isArray(rule.evidenceCaseIds) || rule.evidenceCaseIds.length < 3 || new Set(rule.evidenceCaseIds).size !== rule.evidenceCaseIds.length || rule.evidenceCaseIds.some((id) => !CASE_ID.test(id))) {
    throw new Error('strategy rule requires three independent evidence cases')
  }
  if (typeof rule.primaryMetric !== 'string' || rule.primaryMetric.length === 0) throw new Error('primaryMetric must be non-empty')
  if (!Number.isFinite(rule.baselineValue) || !Number.isFinite(rule.candidateValue)) throw new Error('metric values must be finite')
  if (!CANDIDATE_ID.test(rule.introducedBy)) throw new Error('invalid introducedBy candidate id')
  return rule
}

export function parseStrategyCatalog(text) {
  let catalog
  try {
    catalog = JSON.parse(text)
  } catch (error) {
    throw new Error(`strategy catalog must use the strict JSON subset of YAML 1.2: ${error.message}`)
  }
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('strategy catalog must be an object')
  assertExactFields(catalog, new Set(['schemaVersion', 'stableVersion', 'rules']), 'strategy catalog')
  if (catalog.schemaVersion !== 1) throw new Error('unsupported strategy catalog schemaVersion')
  if (!Number.isInteger(catalog.stableVersion) || catalog.stableVersion < 0) throw new Error('invalid stableVersion')
  if (!Array.isArray(catalog.rules)) throw new Error('rules must be an array')
  for (const rule of catalog.rules) {
    validateStrategyRule(rule)
    if (rule.status !== 'stable') throw new Error('stable catalog contains a non-stable rule')
  }
  return catalog
}

export function rulesOverlap(left, right) {
  validateStrategyRule(left)
  validateStrategyRule(right)
  const taskKinds = new Set(left.appliesWhen.taskKinds)
  const mechanisms = new Set(left.appliesWhen.failureMechanisms)
  return right.appliesWhen.taskKinds.some((value) => taskKinds.has(value))
    && right.appliesWhen.failureMechanisms.some((value) => mechanisms.has(value))
}

export function appendCandidateRule(catalog, candidateRule) {
  if (!catalog || catalog.schemaVersion !== 1 || !Number.isInteger(catalog.stableVersion) || !Array.isArray(catalog.rules)) {
    throw new Error('invalid stable catalog')
  }
  for (const stable of catalog.rules) {
    validateStrategyRule(stable)
    if (stable.status !== 'stable') throw new Error('stable catalog contains a non-stable rule')
  }
  validateStrategyRule(candidateRule)
  if (candidateRule.status !== 'candidate') throw new Error('appended rule must have candidate status')
  for (const stable of catalog.rules) {
    if (rulesOverlap(stable, candidateRule)) throw new Error(`candidate overlaps stable rule ${stable.id}`)
  }
  return {
    schemaVersion: catalog.schemaVersion,
    stableVersion: catalog.stableVersion,
    rules: [...structuredClone(catalog.rules), structuredClone(candidateRule)],
  }
}

export function scoreMonotonicity({ baseline, candidate }) {
  const critical = ['safety', 'privacy', 'approval', 'criticalQuality']
  for (const key of critical) {
    if (!Number.isFinite(baseline?.[key]) || !Number.isFinite(candidate?.[key])) {
      return { pass: false, reason: `missing comparable metric: ${key}` }
    }
    if (candidate[key] < baseline[key]) return { pass: false, reason: `${key} regressed` }
  }
  if (!Number.isFinite(baseline?.primaryMetric) || !Number.isFinite(candidate?.primaryMetric)) {
    return { pass: false, reason: 'missing comparable metric: primaryMetric' }
  }
  if (candidate.primaryMetric >= baseline.primaryMetric) {
    return { pass: false, reason: 'primary metric did not strictly improve' }
  }
  return { pass: true, reason: 'primary metric improved with non-inferior guardrails' }
}
