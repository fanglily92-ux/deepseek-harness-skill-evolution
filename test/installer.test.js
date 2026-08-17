import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectHarnessVersion, installHarness, planInstall } from '../src/installer.js'

const isolatedFixtureDependencies = { authorityGuard() {} }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-install-'))
  const dshHome = join(root, '.dsh')
  const workspace = join(root, 'workspace')
  const sourceRoot = join(root, 'source')
  const presetPath = join(dshHome, '.agent-presets', 'video-reader', 'agent.cordis.yml')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(dshHome, '.agent-presets', 'video-reader'), { recursive: true })
  const sources = {
    'index.js': 'export const name = "test"\n',
    'src/a.js': 'export const a = 1\n',
    'config/a.json': '{}\n',
    'eval/a.json': '{}\n',
    'skills/optimize-work-strategy/SKILL.md': '# Skill\n',
    'skills/optimize-work-strategy/references/strategies.yaml': '{"schemaVersion":1,"stableVersion":0,"rules":[]}\n',
    'scripts/a.js': '\n',
    'package.json': '{"name":"deepseek-harness-skill-evolution","version":"0.1.0"}\n',
    'package-lock.json': '{}\n', 'README.md': '# Readme\n', 'LICENSE': 'MIT\n', 'THIRD_PARTY_NOTICES.md': '# Notices\n',
  }
  for (const [path, content] of Object.entries(sources)) {
    const target = join(sourceRoot, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, { flag: 'wx' })
  }
  await writeFile(presetPath, '- id: tool-skill\n  name: "@deepseek-ai/dsh-tool-skill"\n', { flag: 'wx' })
  return { root, dshHome, workspace, sourceRoot, presetPath, harnessVersion: '0.1.0-rc.6', nodeVersion: '22.0.0' }
}

test('planInstall is zero-write and returns an exact append-only preview', async () => {
  const options = await fixture()
  const before = await readFile(options.presetPath, 'utf8')
  const plan = await planInstall(options, isolatedFixtureDependencies)

  assert.equal(await readFile(options.presetPath, 'utf8'), before)
  assert.equal(plan.writeRequired, true)
  assert.match(plan.appendBlock, /id: deepseek-skill-evolution/)
  assert.match(plan.appendBlock, /config:\n    workspace:/)
  assert.match(plan.appendBlock, /authorityRoot:/)
  assert.match(plan.beforeHash, /^[a-f0-9]{64}$/)
  assert.match(plan.sourceManifestHash, /^[a-f0-9]{64}$/)
  await assert.rejects(readFile(plan.pluginEntry), /ENOENT/)
})

test('detectHarnessVersion uses the real dsh command output and fails closed', () => {
  const version = detectHarnessVersion('dsh', () => ({ status: 0, stdout: '0.1.0-rc.6\n', stderr: '' }))
  assert.equal(version, '0.1.0-rc.6')
  assert.throws(() => detectHarnessVersion('dsh', () => ({ status: 1, stdout: '', stderr: 'failed' })), /could not read Harness version/)
  assert.throws(() => detectHarnessVersion('dsh', () => ({ status: 0, stdout: 'unknown', stderr: '' })), /unrecognized Harness version/)
})

test('installHarness creates a backup and appends exactly one plugin row in a temporary DSH home', async () => {
  const options = await fixture()
  const preview = await planInstall(options, isolatedFixtureDependencies)
  const result = await installHarness({ ...options, expectedPresetHash: preview.beforeHash, expectedSourceManifestHash: preview.sourceManifestHash }, isolatedFixtureDependencies)
  const installed = await readFile(options.presetPath, 'utf8')

  assert.equal((installed.match(/id: deepseek-skill-evolution/g) ?? []).length, 1)
  assert.equal(await readFile(result.backupPath, 'utf8'), '- id: tool-skill\n  name: "@deepseek-ai/dsh-tool-skill"\n')
  assert.equal(await readFile(result.pluginEntry, 'utf8'), 'export const name = "test"\n')
  assert.equal(await readFile(join(result.skillDirectory, 'SKILL.md'), 'utf8'), '# Skill\n')
})

test('planInstall rejects project Skill shadowing and symlinked source files', async () => {
  const options = await fixture()
  await mkdir(join(options.workspace, '.dsh', 'skills', 'optimize-work-strategy'), { recursive: true })
  await assert.rejects(planInstall(options, isolatedFixtureDependencies), /shadows the protected user Skill/)

  const other = await fixture()
  const real = join(other.sourceRoot, 'index.js')
  const linked = join(other.sourceRoot, 'src', 'linked.js')
  await symlink(real, linked)
  await assert.rejects(planInstall(other, isolatedFixtureDependencies), /symlink/)
})

test('planInstall rejects a symlinked authority parent', async () => {
  const options = await fixture()
  const outside = await mkdtemp(join(tmpdir(), 'evolution-install-outside-'))
  await symlink(outside, join(options.dshHome, 'plugins'))
  await assert.rejects(planInstall(options, isolatedFixtureDependencies), /symlink/)
})

test('planInstall rejects a sandbox-writable temporary DSH home', async () => {
  const options = await fixture()
  await assert.rejects(planInstall(options), /temporary directory|symlink or aliased path/)
})
