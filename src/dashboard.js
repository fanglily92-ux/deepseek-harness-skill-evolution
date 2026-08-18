function countState(candidates, state) {
  return candidates.filter((candidate) => candidate.state === state).length
}

function partitionScore(fixtureResults, partition) {
  const rows = fixtureResults.filter((result) => result.partition === partition)
  return {
    count: rows.length,
    stableErrors: rows.reduce((sum, result) => sum + result.stablePrimary, 0),
    candidateErrors: rows.reduce((sum, result) => sum + result.candidatePrimary, 0),
  }
}

export function createApprovalCard(candidate) {
  const report = candidate.evaluationReport ?? {}
  const rows = Array.isArray(report.fixtureResults) ? report.fixtureResults : []
  const support = partitionScore(rows, 'support')
  const heldout = partitionScore(rows, 'heldout')
  return {
    candidateId: candidate.id,
    state: candidate.state,
    exactDiff: { operation: 'append-one-rule', rule: structuredClone(candidate.proposedRule) },
    hashes: {
      baseline: candidate.baselineHash,
      candidate: candidate.candidateHash,
      validationReport: candidate.validationReportHash,
      stableSkill: candidate.evaluationBinding?.stableSkillHash,
      stableStrategies: candidate.evaluationBinding?.stableStrategiesHash,
      fixtures: candidate.evaluationBinding?.fixtureManifestHash,
      evaluationPolicy: candidate.evaluationBinding?.evaluationPolicyHash,
      evaluatorCode: candidate.evaluationBinding?.evaluatorCodeHash,
    },
    evaluation: {
      support,
      heldout,
      allGoldenIncluded: report.allGoldenIncluded === true,
      comparator: report.comparator ?? null,
    },
    guardrails: {
      allCriticalPass: rows.length > 0 && rows.every((row) => row.stableCriticalPass === true && row.candidateCriticalPass === true),
      zeroHeldoutRegression: heldout.count > 0 && heldout.candidateErrors <= heldout.stableErrors,
      strictSupportImprovement: support.count > 0 && support.candidateErrors < support.stableErrors,
    },
    cost: {
      armRuns: rows.length * 2,
      validationStage: report.stage ?? null,
      actualArmRuns: report.budget?.actualRuns ?? null,
      maxArmRuns: report.budget?.maxRuns ?? null,
      inputTokens: report.budget?.usage?.inputTokens ?? null,
      outputTokens: report.budget?.usage?.outputTokens ?? null,
      meteredTokens: report.budget?.usage?.meteredTokens ?? null,
      cacheReadTokens: report.budget?.usage?.cacheReadTokens ?? null,
      maxMeteredTokens: report.budget?.maxMeteredTokens ?? null,
      maxOutputTokensPerArm: report.budget?.maxOutputTokensPerArm ?? null,
      maxPromptCharsPerArm: report.budget?.maxPromptCharsPerArm ?? null,
      timeoutMsPerRun: report.budget?.timeoutMs ?? null,
      budgetExhausted: report.budget?.exhausted ?? null,
    },
    uncertainty: ['LLM execution is stochastic; only the precommitted fixture boundary was evaluated.'],
    rollbackCondition: 'Any attributable critical regression quarantines the rule; restoration requires a separately reviewed rollback path.',
  }
}

export function renderDashboard(state) {
  const candidates = Array.isArray(state.candidates) ? state.candidates : []
  return `# DeepSeek Harness 自进化工作台

## 当前状态

- 健康状态：\`${state.health}\`
- 稳定版本：\`${state.stableVersion}\`
- 稳定哈希：\`${state.stableHash}\`
- 收据数量：${state.receiptCount}
- 待批准：${countState(candidates, 'awaiting-approval')}
- 已隔离：${countState(candidates, 'quarantined')}
- 已回滚：${countState(candidates, 'rolled-back')}

## 入口

- [[审批队列]]
- [[策略账本]]
`
}

export function renderApprovalQueue(candidates) {
  const rows = [...candidates].sort((left, right) => left.id.localeCompare(right.id))
  const body = rows.length === 0
    ? '- 当前无候选。'
    : rows.map((candidate) => `- [[候选方案/${candidate.id}|${candidate.id}]] — \`${candidate.state}\``).join('\n')
  return `# 审批队列

${body}
`
}

export function renderStrategyLedger(catalog) {
  const body = catalog.rules.length === 0
    ? '- 当前没有已晋升策略。'
    : catalog.rules.map((rule) => `## ${rule.id}

- 状态：\`${rule.status}\`
- 任务类型：${rule.appliesWhen.taskKinds.join('、')}
- 失败机制：${rule.appliesWhen.failureMechanisms.join('、')}
- 动作：${rule.action}
- 避免：${rule.avoid}
- 主要指标：\`${rule.primaryMetric}\`（${rule.baselineValue} → ${rule.candidateValue}）
- 来源候选：\`${rule.introducedBy}\`
- 证据：${rule.evidenceCaseIds.map((id) => `\`${id}\``).join('、')}`).join('\n\n')
  return `# 策略账本

- 稳定版本：\`${catalog.stableVersion}\`

${body}
`
}

export function renderCandidateCard(candidate, report) {
  const approvalCard = createApprovalCard(candidate)
  const checks = Array.isArray(report.checks) && report.checks.length > 0
    ? report.checks.map((check) => `- \`${check}\``).join('\n')
    : '- 无已记录检查。'
  const scorecard = Object.entries(report.scorecard ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `- ${key}: \`${value}\``)
    .join('\n') || '- 无可比较分数。'
  return `# ${candidate.id}

- 状态：\`${candidate.state}\`
- 基线哈希：\`${candidate.baselineHash}\`
- 验证报告哈希：\`${report.reportHash}\`
- 验证通过：\`${report.pass === true}\`
- 证据案例：${candidate.caseIds.map((id) => `\`${id}\``).join('、')}

## 候选规则

- ID：\`${candidate.proposedRule.id}\`
- 动作：${candidate.proposedRule.action}
- 避免：${candidate.proposedRule.avoid}

## 记分卡

${scorecard}

## 检查

${checks}

## 人工审批证据

\`\`\`json
${JSON.stringify(approvalCard, null, 2)}
\`\`\`
`
}

export function buildWorkbenchProjection({ health, stableVersion, stableHash, receiptCount, candidates, catalog }) {
  const files = {
    '工作台首页.md': renderDashboard({ health, stableVersion, stableHash, receiptCount, candidates }),
    '审批队列.md': renderApprovalQueue(candidates),
    '策略账本.md': renderStrategyLedger(catalog),
  }
  for (const candidate of candidates.filter((item) => item.validationReport && item.evaluationReport)) {
    files[`候选方案/${candidate.id}.md`] = renderCandidateCard(candidate, candidate.validationReport)
  }
  return files
}
