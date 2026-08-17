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
  const session = { id: 'private-session-id' }
  const events = [
    {
      type: 'user/message', seq: 1, time: 100,
      data: { turn: 4, source: { kind: 'user' }, content: [{ type: 'text', text: '这不对，请重新做。API_KEY=secret' }] },
    },
    {
      type: 'tool/call', seq: 2, time: 110,
      data: { turn: 4, step: 1, callId: 'skill-1', name: 'skill', arguments: '{"name":"optimize-work-strategy"}' },
    },
    {
      type: 'tool/result', seq: 3, time: 120,
      data: { turn: 4, step: 1, callId: 'skill-1', name: 'skill', isError: false, content: [{ type: 'text', text: 'private Skill body' }] },
    },
    {
      type: 'tool/call', seq: 4, time: 130,
      data: { turn: 4, step: 2, callId: 'bash-1', name: 'bash', arguments: '{"command":"echo secret"}' },
    },
    {
      type: 'tool/result', seq: 5, time: 150,
      data: { turn: 4, step: 2, callId: 'bash-1', name: 'bash', isError: false, content: [{ type: 'text', text: 'secret output' }] },
    },
    {
      type: 'tool/call', seq: 6, time: 160,
      data: { turn: 4, step: 3, callId: 'doctor-1', name: 'evolution_doctor', arguments: '{}' },
    },
    {
      type: 'tool/result', seq: 7, time: 180,
      data: { turn: 4, step: 3, callId: 'doctor-1', name: 'evolution_doctor', isError: true, content: [{ type: 'text', text: 'private error' }] },
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
    durationMs: 100,
    startSeq: 1,
    endSeq: 8,
  })
  assert.equal(appended[0].outcome, 'failure')
  assert.match(appended[0].sessionHash, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(appended[0])
  for (const secret of ['private-session-id', 'API_KEY=secret', 'private Skill body', 'echo secret', 'secret output', 'private error']) {
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

  await observe(session, { type: 'user/message', seq: 1, time: 1, data: { turn: 1, source: { kind: 'system' }, content: [{ type: 'text', text: '通过' }] } })
  await observe(session, { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, callId: 's', name: 'skill', arguments: '{"name":"not-whitelisted"}' } })
  await observe(session, { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } })

  assert.deepEqual(appended, [])
})
