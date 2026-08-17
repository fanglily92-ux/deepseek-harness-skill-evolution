function countState(candidates, state) {
  return candidates.filter((candidate) => candidate.state === state).length
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
`
}
