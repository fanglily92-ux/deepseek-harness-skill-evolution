import test from 'node:test'
import assert from 'node:assert/strict'

import {
  renderApprovalQueue,
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
