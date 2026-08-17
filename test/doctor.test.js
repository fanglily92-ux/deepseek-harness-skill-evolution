import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runDoctor } from '../src/doctor.js'

async function healthyFixture() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-doctor-'))
  const workspace = join(root, 'workspace')
  const dshHome = join(root, '.dsh')
  const pluginEntry = join(workspace, 'plugin', 'index.js')
  const presetPath = join(dshHome, '.agent-presets', 'video-reader', 'agent.cordis.yml')
  const files = [
    pluginEntry,
    join(workspace, '.dsh', 'skills', 'optimize-work-strategy', 'SKILL.md'),
    join(workspace, 'plugin', 'config', 'whitelist.json'),
    join(workspace, 'logs', 'DeepSeek-Harness自进化', 'state', 'receipts.jsonl'),
    join(workspace, 'logs', 'DeepSeek-Harness自进化', 'state', 'candidates.json'),
    join(workspace, 'logs', 'DeepSeek-Harness自进化', 'state', 'versions.jsonl'),
    join(workspace, '知识库', 'DeepSeek Harness自进化工作台', '工作台首页.md'),
  ]
  for (const file of files) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, file.endsWith('whitelist.json') ? '{"schemaVersion":1,"skills":["optimize-work-strategy"]}\n' : '\n', { flag: 'wx' })
  }
  await mkdir(join(presetPath, '..'), { recursive: true })
  await writeFile(presetPath, `- id: deepseek-skill-evolution\n  name: ${JSON.stringify(pluginEntry)}\n  config:\n    workspace: ${JSON.stringify(workspace)}\n`, { flag: 'wx' })
  return { workspace, dshHome, pluginEntry, presetPath, versionReader: () => '0.1.0-rc.6' }
}

test('runDoctor reports stable check ids and passes a healthy isolated fixture', async () => {
  const result = await runDoctor(await healthyFixture())
  assert.equal(result.ok, true)
  assert.deepEqual(result.checks.map((check) => check.id), [
    'platform', 'node', 'dsh', 'harness-version', 'plugin-entry', 'preset', 'skill', 'whitelist', 'ledger', 'candidate-state', 'versions', 'locks', 'dashboard',
  ])
})

test('runDoctor is read-only and reports a missing preset row without throwing', async () => {
  const options = await healthyFixture()
  await writeFile(options.presetPath, '- id: tool-skill\n', { flag: 'w' })
  const result = await runDoctor(options)
  assert.equal(result.ok, false)
  assert.equal(result.checks.find((check) => check.id === 'preset').ok, false)
})
