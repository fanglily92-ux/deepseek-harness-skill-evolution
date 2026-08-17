import test from 'node:test'
import assert from 'node:assert/strict'

import { createEventObserver } from '../src/event-observer.js'

test('createEventObserver emits one privacy-bounded receipt for a whitelisted Skill turn', async () => {
  const appended = []
  const ledger = { append: async (value) => appended.push(value) }
  const observe = createEventObserver({
    ledger,
    whitelist: new Set(['optimize-work-strategy']),
    now: () => 1786924800000,
  })
  const session = { id: 'synthetic-session-id' }
  const events = [
    { type: 'turn/start', seq: 0, time: 90, data: { turn: 4 } },
    {
      type: 'user/message', seq: 1, time: 100,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这不对，请重新做。SENSITIVE_MARKER_7F3A' }] },
    },
    {
      type: 'tool/call', seq: 2, time: 110,
      data: { turn: 4, step: 1, callId: 'skill-1', name: 'skill', arguments: '{"name":"optimize-work-strategy"}' },
    },
    {
      type: 'tool/result', seq: 3, time: 120,
      data: { turn: 4, step: 1, message: { source: { kind: 'tool', callId: 'skill-1' }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: 'private Skill body' }] }] } },
    },
    {
      type: 'tool/call', seq: 4, time: 130,
      data: { turn: 4, step: 2, callId: 'bash-1', name: 'bash', arguments: '{"command":"echo secret"}' },
    },
    {
      type: 'tool/result', seq: 5, time: 150,
      data: { turn: 4, step: 2, message: { source: { kind: 'tool', callId: 'bash-1' }, content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: 'secret output' }] }] } },
    },
    {
      type: 'tool/call', seq: 6, time: 160,
      data: { turn: 4, step: 3, callId: 'doctor-1', name: 'evolution_doctor', arguments: '{}' },
    },
    {
      type: 'tool/result', seq: 7, time: 180,
      data: { turn: 4, step: 3, message: { source: { kind: 'tool', callId: 'doctor-1' }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'private error' }] }] }, error: { name: 'ToolError', code: 'FAILED' } },
    },
    { type: 'turn/end', seq: 8, time: 200, data: { turn: 4, status: 'completed' } },
  ]

  for (const event of events) await observe(session, event)

  assert.equal(appended.length, 1)
  assert.deepEqual(appended[0].evidence, {
    errorClass: 'REWORK',
    userSignal: 'negative',
    toolCalls: 2,
    toolFailures: 1,
    validationCalls: 2,
    durationMs: 110,
    startSeq: 0,
    endSeq: 8,
  })
  assert.equal(appended[0].outcome, 'failure')
  assert.match(appended[0].sessionHash, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(appended[0])
  for (const secret of ['synthetic-session-id', 'SENSITIVE_MARKER_7F3A', 'private Skill body', 'echo secret', 'secret output', 'private error']) {
    assert.equal(serialized.includes(secret), false)
  }
})

test('createEventObserver ignores non-user text and non-whitelisted Skill turns', async () => {
  const appended = []
  const observe = createEventObserver({
    ledger: { append: async (value) => appended.push(value) },
    whitelist: new Set(['optimize-work-strategy']),
    now: () => 1786924800000,
  })
  const session = { id: 'session' }

  await observe(session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
  await observe(session, { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'system' }, content: [{ type: 'text', text: '通过' }] } })
  await observe(session, { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, callId: 's', name: 'skill', arguments: '{"name":"not-whitelisted"}' } })
  await observe(session, { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } })

  assert.deepEqual(appended, [])
})

test('createEventObserver records an unclear approval mechanism when promotion follows generic language', async () => {
  const appended = []
  const observe = createEventObserver({
    ledger: { append: async (value) => appended.push(value) },
    whitelist: new Set(['optimize-work-strategy']),
    now: () => 1786924800000,
  })
  const session = { id: 'approval-session' }
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] } },
    { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: 'skill', name: 'skill', arguments: '{"name":"optimize-work-strategy"}' } },
    { type: 'tool/result', seq: 3, time: 3, data: { message: { source: { kind: 'tool', callId: 'skill' }, content: [{ type: 'tool-result', isError: false, content: [] }] } } },
    { type: 'tool/call', seq: 4, time: 4, data: { turn: 1, step: 2, callId: 'promote', name: 'evolution_promote', arguments: '{"candidate_id":"EVO-20260818-001"}' } },
    { type: 'tool/result', seq: 5, time: 5, data: { turn: 1, step: 2, message: { source: { kind: 'tool', callId: 'promote' }, content: [{ type: 'tool-result', isError: false, content: [] }] } } },
    { type: 'turn/end', seq: 6, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  for (const event of events) await observe(session, event)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].outcome, 'failure')
  assert.equal(appended[0].evidence.errorClass, 'UNCLEAR_APPROVAL')
})

test('createEventObserver activates only after a successful whitelisted Skill result', async () => {
  const appended = []
  const observe = createEventObserver({ ledger: { append: async (value) => appended.push(value) }, whitelist: new Set(['optimize-work-strategy']) })
  const session = { id: 'failed-skill' }
  await observe(session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
  await observe(session, { type: 'tool/call', seq: 1, time: 1, data: { callId: 'skill', name: 'skill', arguments: '{"name":"optimize-work-strategy"}' } })
  await observe(session, { type: 'tool/result', seq: 2, time: 2, data: { message: { source: { callId: 'skill' }, content: [{ type: 'tool-result', isError: true }] } } })
  await observe(session, { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } })
  assert.deepEqual(appended, [])
})

test('createEventObserver surfaces ledger failures to plugin health', async () => {
  const observe = createEventObserver({ ledger: { append: async () => { throw Object.assign(new Error('disk'), { code: 'EIO' }) } }, whitelist: new Set(['optimize-work-strategy']) })
  const session = { id: 'ledger-failure' }
  await observe(session, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
  await observe(session, { type: 'tool/call', seq: 1, time: 1, data: { callId: 'skill', name: 'skill', arguments: '{"name":"optimize-work-strategy"}' } })
  await observe(session, { type: 'tool/result', seq: 2, time: 2, data: { message: { source: { callId: 'skill' }, content: [{ type: 'tool-result', isError: false }] } } })
  await assert.rejects(observe(session, { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } }), /disk/)
  assert.equal(observe.health.ok, false)
  await observe({ id: 'unrelated-session' }, { type: 'turn/start', seq: 4, time: 4, data: { turn: 1 } })
  assert.equal(observe.health.ok, false)
})

test('createEventObserver does not correlate reused call ids across sessions', async () => {
  const appended = []
  const observe = createEventObserver({ ledger: { append: async (value) => appended.push(value) }, whitelist: new Set(['optimize-work-strategy']) })
  const first = { id: 'first-session' }
  const second = { id: 'second-session' }
  await observe(first, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
  await observe(second, { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } })
  await observe(first, { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, callId: 'reused', name: 'skill', arguments: '{"name":"optimize-work-strategy"}' } })
  await observe(second, { type: 'tool/result', seq: 1, time: 1, data: { turn: 1, message: { source: { callId: 'reused' }, content: [{ type: 'tool-result', isError: false }] } } })
  await observe(second, { type: 'turn/end', seq: 2, time: 2, data: { turn: 1 } })
  assert.deepEqual(appended, [])
})
