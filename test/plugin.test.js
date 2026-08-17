import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, inject, name, recordObserverSuccess } from '../index.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fakeContext(workspace = '/tmp/evolution-workspace') {
  const listeners = new Map()
  const registered = []
  return {
    listeners,
    registered,
    tools: { register(tool) { registered.push(tool); return () => undefined } },
    shell: { sandboxMode: 'workspace-write' },
    fs: { sandboxMode: 'workspace-write' },
    sandboxPolicy: { defaultMode: 'workspace-write', async resolve() { return { mode: 'workspace-write', workspaceRoot: workspace } } },
    get(name) { return name === 'sandboxPolicy' ? this.sandboxPolicy : undefined },
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
  assert.deepEqual(inject, ['tools', 'agents', 'agentPresets', 'shell', 'fs', 'sandboxPolicy'])
  assert.equal(ctx.registered.length, 5)
})

test('plugin can mount with workspace config and no injected test services', () => {
  const ctx = fakeContext()
  apply(ctx, { workspace: '/tmp/evolution-workspace', authorityRoot: projectRoot })
  assert.equal(ctx.registered.length, 5)
  assert.equal(ctx.listeners.has('session/event'), true)
})

test('plugin refuses to mount when a project Skill shadows the protected Skill', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'evolution-plugin-shadow-'))
  await mkdir(join(workspace, '.dsh', 'skills', 'optimize-work-strategy'), { recursive: true })
  const ctx = fakeContext(workspace)

  assert.throws(
    () => apply(ctx, { services, workspace, authorityRoot: projectRoot }),
    /project Skill shadows the protected user Skill/,
  )
  assert.equal(ctx.registered.length, 0)
})

test('plugin denies evolution calls if a project Skill appears after mount', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'evolution-plugin-late-shadow-'))
  const ctx = fakeContext(workspace)
  apply(ctx, { services, workspace, authorityRoot: projectRoot })
  await mkdir(join(workspace, '.dsh', 'skills', 'optimize-work-strategy'), { recursive: true })

  const gate = ctx.listeners.get('tools/pre-execute')
  assert.deepEqual(
    await gate({ name: 'evolution_propose', arguments: {} }, () => ({ kind: 'allow' })),
    { kind: 'deny', reason: 'A project Skill shadows the protected optimize-work-strategy Skill.' },
  )
})

test('plugin asks for one-time approval only for the exact promotion call', async () => {
  const ctx = fakeContext()
  apply(ctx, { services })
  const gate = ctx.listeners.get('tools/pre-execute')
  const next = () => ({ kind: 'allow' })

  assert.deepEqual(
    await gate({ name: 'evolution_promote', arguments: { candidate_id: 'EVO-20260817-001' } }, next),
    { kind: 'ask', reason: 'Promote EVO-20260817-001 to the stable optimize-work-strategy catalog after all monotonic checks passed.' },
  )
  assert.deepEqual(await gate({ name: 'evolution_status', arguments: {} }, next), { kind: 'allow' })
})

test('plugin denies obvious non-evolution writes to authority files as defense in depth', async () => {
  const ctx = fakeContext()
  apply(ctx, { services, workspace: '/tmp/evolution-workspace', authorityRoot: projectRoot })
  const gate = ctx.listeners.get('tools/pre-execute')
  const result = await gate({ name: 'bash', arguments: { command: 'printf x > .dsh/skills/optimize-work-strategy/references/strategies.yaml' } }, () => ({ kind: 'allow' }))
  assert.deepEqual(result, { kind: 'deny', reason: 'Authority state may be changed only through evolution tools.' })
})

test('plugin rejects unconfined sessions and all sandbox escalation requests', async () => {
  const ctx = fakeContext()
  apply(ctx, { services, workspace: '/tmp/evolution-workspace', authorityRoot: projectRoot })
  const gate = ctx.listeners.get('tools/pre-execute')
  assert.deepEqual(await gate({ name: 'bash', arguments: { command: 'true', sandbox_permissions: 'danger-full-access' } }, () => ({ kind: 'allow' })), {
    kind: 'deny', reason: 'Sandbox escalation is disabled while the Skill evolution authority is mounted.',
  })
  ctx.sandboxPolicy.resolve = async () => ({ mode: 'danger-full-access', workspaceRoot: '/tmp/evolution-workspace' })
  assert.deepEqual(await gate({ name: 'bash', arguments: { command: 'true' } }, () => ({ kind: 'allow' })), {
    kind: 'deny', reason: 'Skill evolution requires a workspace-confined agent session.',
  })
})

test('observer degradation remains sticky until restart', () => {
  const health = { status: 'degraded', lastErrorCode: 'EIO', lastSuccessSeq: 2 }
  recordObserverSuccess(health, 3)
  assert.deepEqual(health, { status: 'degraded', lastErrorCode: 'EIO', lastSuccessSeq: 2 })
})
