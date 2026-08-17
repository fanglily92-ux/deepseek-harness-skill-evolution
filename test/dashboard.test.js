import test from 'node:test'
import assert from 'node:assert/strict'

import {
  renderApprovalQueue,
  createApprovalCard,
  buildWorkbenchProjection,
  renderCandidateCard,
  renderDashboard,
  renderStrategyLedger,
} from '../src/dashboard.js'

test('renderDashboard reports bounded health and state counts without leaking paths or raw text', () => {
  const markdown = renderDashboard({
    health: 'degraded',
    stableVersion: 3,
    stableHash: 'a'.repeat(64),
    receiptCount: 12,
    candidates: [
      { id: 'EVO-20260817-003', state: 'quarantined' },
      { id: 'EVO-20260817-001', state: 'awaiting-approval' },
      { id: 'EVO-20260817-002', state: 'rolled-back' },
    ],
  })

  assert.match(markdown, /健康状态：`degraded`/)
  assert.match(markdown, /待批准：1/)
  assert.match(markdown, /已隔离：1/)
  assert.match(markdown, /已回滚：1/)
  assert.equal(markdown.includes('/Users/'), false)
  assert.equal(markdown.includes('rawPrompt'), false)
})

test('renderApprovalQueue sorts candidate ids and links approval cards deterministically', () => {
  const markdown = renderApprovalQueue([
    { id: 'EVO-20260817-002', state: 'rejected' },
    { id: 'EVO-20260817-001', state: 'awaiting-approval' },
  ])

  assert.ok(markdown.indexOf('EVO-20260817-001') < markdown.indexOf('EVO-20260817-002'))
  assert.match(markdown, /\[\[候选方案\/EVO-20260817-001\|EVO-20260817-001\]\]/)
})

test('renderStrategyLedger and renderCandidateCard include audit fields but not raw outputs', () => {
  const catalog = {
    schemaVersion: 1,
    stableVersion: 1,
    rules: [{
      id: 'STR-0001', status: 'stable',
      appliesWhen: { taskKinds: ['skill-review'], failureMechanisms: ['unclear-approval'] },
      action: 'Require an exact candidate id.', avoid: 'General approval.',
      evidenceCaseIds: ['CASE-0123456789abcdef', 'CASE-1123456789abcdef', 'CASE-2123456789abcdef'],
      primaryMetric: 'ambiguity-count', baselineValue: 2, candidateValue: 0,
      introducedBy: 'EVO-20260817-001',
    }],
  }
  const ledger = renderStrategyLedger(catalog)
  assert.match(ledger, /STR-0001/)
  assert.match(ledger, /unclear-approval/)

  const card = renderCandidateCard(
    { id: 'EVO-20260817-002', state: 'awaiting-approval', baselineHash: 'b'.repeat(64), caseIds: catalog.rules[0].evidenceCaseIds, proposedRule: catalog.rules[0] },
    { pass: true, reportHash: 'c'.repeat(64), scorecard: { supportStable: 6, supportCandidate: 3 }, checks: ['golden-pass'] },
  )
  assert.match(card, /supportStable.*6/)
  assert.match(card, /golden-pass/)
  assert.equal(card.includes('rawOutput'), false)
})

test('createApprovalCard exposes the evidence needed for exact human approval without raw model text', () => {
  const candidate = {
    id: 'EVO-20260817-001', state: 'awaiting-approval', baselineHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64),
    validationReportHash: 'c'.repeat(64), caseIds: ['CASE-0123456789abcdef', 'CASE-1123456789abcdef', 'CASE-2123456789abcdef'],
    evaluationBinding: { stableSkillHash: 'd'.repeat(64), evaluatorCodeHash: 'e'.repeat(64) },
    proposedRule: { id: 'STR-0001', action: 'Require exact approval.', avoid: 'Generic approval.', primaryMetric: 'golden-label-error-rate', baselineValue: 1, candidateValue: 0 },
    evaluationReport: {
      allGoldenIncluded: true, comparator: { disagreement: false, mode: 'sealed-blind-golden-label' },
      budget: { maxRuns: 30, timeoutMs: 120000, exhausted: false },
      fixtureResults: [
        { partition: 'support', stableCriticalPass: true, candidateCriticalPass: true, stablePrimary: 1, candidatePrimary: 0 },
        { partition: 'heldout', stableCriticalPass: true, candidateCriticalPass: true, stablePrimary: 0, candidatePrimary: 0 },
      ],
    },
  }
  const card = createApprovalCard(candidate)
  assert.equal(card.hashes.evaluatorCode, 'e'.repeat(64))
  assert.equal(card.exactDiff.operation, 'append-one-rule')
  assert.deepEqual(card.evaluation.support, { count: 1, stableErrors: 1, candidateErrors: 0 })
  assert.equal(card.guardrails.zeroHeldoutRegression, true)
  assert.equal(card.cost.armRuns, 4)
  assert.equal(JSON.stringify(card).includes('rawOutput'), false)
})

test('buildWorkbenchProjection deterministically rebuilds non-authoritative Obsidian files', () => {
  const catalog = { schemaVersion: 1, stableVersion: 0, rules: [] }
  const files = buildWorkbenchProjection({
    health: 'healthy', stableVersion: 0, stableHash: 'a'.repeat(64), receiptCount: 0,
    candidates: [], catalog,
  })
  assert.deepEqual(Object.keys(files), ['工作台首页.md', '审批队列.md', '策略账本.md'])
  assert.match(files['工作台首页.md'], /稳定版本：`0`/)
  assert.match(files['策略账本.md'], /当前没有已晋升策略/)
})
