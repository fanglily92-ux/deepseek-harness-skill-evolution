import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name } from '../index.js'

function fakeContext() {
  const listeners = new Map()
  const registered = []
  return {
    listeners,
    registered,
    tools: { register(tool) { registered.push(tool); return () => undefined } },
    on(event, listener) { listeners.set(event, listener); return () => undefined },
  }
}

const services = {
  status: async () => ({}), review: async () => ({}), propose: async () => ({}), validate: async () => ({}), promote: async () => ({}),
}

test('plugin exports the expected Cordis identity and registers five tools', () => {
  const ctx = fakeContext()
  apply(ctx, { services })

  assert.equal(name, 'deepseek-skill-evolution')
  assert.deepEqual(inject, ['tools', 'agents', 'agentPresets'])
  assert.equal(ctx.registered.length, 5)
})

test('plugin can mount with workspace config and no injected test services', () => {
  const ctx = fakeContext()
  apply(ctx, { workspace: '/tmp/evolution-workspace' })
  assert.equal(ctx.registered.length, 5)
  assert.equal(ctx.listeners.has('session/event'), true)
})

test('plugin asks for one-time approval only for the exact promotion call', () => {
  const ctx = fakeContext()
  apply(ctx, { services })
  const gate = ctx.listeners.get('tools/pre-execute')
  const next = () => ({ kind: 'allow' })

  assert.deepEqual(
    gate({ name: 'evolution_promote', arguments: { candidate_id: 'EVO-20260817-001' } }, next),
    { kind: 'ask', reason: 'Promote EVO-20260817-001 to the stable optimize-work-strategy catalog after all monotonic checks passed.' },
  )
  assert.deepEqual(gate({ name: 'evolution_status', arguments: {} }, next), { kind: 'allow' })
})

test('plugin denies obvious non-evolution writes to authority files as defense in depth', () => {
  const ctx = fakeContext()
  apply(ctx, { services, workspace: '/tmp/evolution-workspace' })
  const gate = ctx.listeners.get('tools/pre-execute')
  const result = gate({ name: 'bash', arguments: { command: 'printf x > .dsh/skills/optimize-work-strategy/references/strategies.yaml' } }, () => ({ kind: 'allow' }))
  assert.deepEqual(result, { kind: 'deny', reason: 'Authority state may be changed only through evolution tools.' })
})
