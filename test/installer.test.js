import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installHarness, planInstall } from '../src/installer.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-install-'))
  const dshHome = join(root, '.dsh')
  const workspace = join(root, 'workspace')
  const pluginEntry = join(workspace, 'plugin', 'index.js')
  const presetPath = join(dshHome, '.agent-presets', 'video-reader', 'agent.cordis.yml')
  await mkdir(join(workspace, 'plugin'), { recursive: true })
  await mkdir(join(dshHome, '.agent-presets', 'video-reader'), { recursive: true })
  await writeFile(pluginEntry, 'export const name = "test"\n', { flag: 'wx' })
  await writeFile(presetPath, '- id: tool-skill\n  name: "@deepseek-ai/dsh-tool-skill"\n', { flag: 'wx' })
  return { root, dshHome, workspace, pluginEntry, presetPath, harnessVersion: '0.1.0-rc.6', nodeVersion: '22.0.0' }
}

test('planInstall is zero-write and returns an exact append-only preview', async () => {
  const options = await fixture()
  const before = await readFile(options.presetPath, 'utf8')
  const plan = await planInstall(options)

  assert.equal(await readFile(options.presetPath, 'utf8'), before)
  assert.equal(plan.writeRequired, true)
  assert.match(plan.appendBlock, /id: deepseek-skill-evolution/)
  assert.match(plan.appendBlock, /config:\n    workspace:/)
  assert.match(plan.beforeHash, /^[a-f0-9]{64}$/)
})

test('installHarness creates a backup and appends exactly one plugin row in a temporary DSH home', async () => {
  const options = await fixture()
  const result = await installHarness({ ...options, expectedPresetHash: (await planInstall(options)).beforeHash })
  const installed = await readFile(options.presetPath, 'utf8')

  assert.equal((installed.match(/id: deepseek-skill-evolution/g) ?? []).length, 1)
  assert.equal(await readFile(result.backupPath, 'utf8'), '- id: tool-skill\n  name: "@deepseek-ai/dsh-tool-skill"\n')
})

test('planInstall rejects duplicate rows and symlink plugin entries', async () => {
  const options = await fixture()
  const plan = await planInstall(options)
  await installHarness({ ...options, expectedPresetHash: plan.beforeHash })
  await assert.rejects(planInstall(options), /already contains deepseek-skill-evolution/)

  const other = await fixture()
  const real = other.pluginEntry
  const linked = join(other.workspace, 'plugin', 'linked.js')
  await symlink(real, linked)
  await assert.rejects(planInstall({ ...other, pluginEntry: linked }), /symlink/)
})
