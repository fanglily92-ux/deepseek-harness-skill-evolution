import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyDirectUserSignal,
  classifyPromotionApproval,
  safeEventSummary,
} from '../src/redaction.js'

test('classifyDirectUserSignal detects a correction without returning its text', () => {
  const result = classifyDirectUserSignal([
    { type: 'text', text: '这不对，请重新做。SENSITIVE_MARKER_7F3A' },
  ])

  assert.equal(result, 'negative')
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('classifyPromotionApproval requires approval language and an exact candidate id', () => {
  assert.equal(classifyPromotionApproval([{ type: 'text', text: '继续' }]), 'generic')
  assert.equal(classifyPromotionApproval([{ type: 'text', text: '批准 EVO-20260818-001' }]), 'exact')
  assert.equal(classifyPromotionApproval([{ type: 'text', text: '拒绝 EVO-20260818-001' }]), 'none')
})

test('classifyDirectUserSignal treats mixed approval and correction as ambiguous', () => {
  assert.equal(
    classifyDirectUserSignal([{ type: 'text', text: '可以了，但这里不对，需要重做' }]),
    'none',
  )
})

test('safeEventSummary drops tool arguments and result content', () => {
  const summary = safeEventSummary({
    type: 'tool/call',
    seq: 9,
    time: 1,
    data: {
      turn: 2,
      step: 1,
      callId: 'c1',
      name: 'bash',
      arguments: '{"command":"echo secret"}',
    },
  })

  assert.deepEqual(summary, {
    type: 'tool/call',
    seq: 9,
    time: 1,
    turn: 2,
    step: 1,
    callId: 'c1',
    tool: 'bash',
  })
  assert.equal(JSON.stringify(summary).includes('secret'), false)
})

test('safeEventSummary rejects unknown event types instead of copying their data', () => {
  assert.equal(
    safeEventSummary({ type: 'unknown/private', seq: 1, data: { token: 'secret' } }),
    null,
  )
})
