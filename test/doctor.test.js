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
  const pluginEntry = join(dshHome, 'plugins', 'deepseek-skill-evolution', '0.1.0', 'index.js')
  const presetPath = join(dshHome, '.agent-presets', 'video-reader', 'agent.cordis.yml')
  const files = [
    pluginEntry,
    join(dshHome, 'skills', 'optimize-work-strategy', 'SKILL.md'),
    join(dshHome, 'plugins', 'deepseek-skill-evolution', '0.1.0', 'config', 'whitelist.json'),
    join(dshHome, '.skill-evolution-authority', 'state', 'receipts.jsonl'),
    join(dshHome, '.skill-evolution-authority', 'state', 'receipts.anchor.json'),
    join(dshHome, '.skill-evolution-authority', 'state', 'candidates.json'),
    join(dshHome, '.skill-evolution-authority', 'state', 'versions.jsonl'),
    join(workspace, '知识库', 'DeepSeek Harness自进化工作台', '工作台首页.md'),
  ]
  for (const file of files) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, file.endsWith('whitelist.json') ? '{"schemaVersion":1,"skills":["optimize-work-strategy"]}\n' : '\n', { flag: 'wx' })
  }
  await mkdir(join(presetPath, '..'), { recursive: true })
  await writeFile(presetPath, `- id: deepseek-skill-evolution\n  name: ${JSON.stringify(pluginEntry)}\n  config:\n    workspace: ${JSON.stringify(workspace)}\n    authorityRoot: ${JSON.stringify(dshHome)}\n`, { flag: 'wx' })
  return { workspace, dshHome, authorityRoot: dshHome, pluginEntry, presetPath, versionReader: () => '0.1.0-rc.6', authorityGuard() {} }
}

test('runDoctor reports stable check ids and passes a healthy isolated fixture', async () => {
  const result = await runDoctor(await healthyFixture())
  assert.equal(result.ok, true)
  assert.equal(result.scope, 'disk-preflight-only')
  assert.equal(result.mountVerified, false)
  assert.deepEqual(result.checks.map((check) => check.id), [
    'platform', 'node', 'dsh', 'harness-version', 'authority-root', 'plugin-entry', 'preset-disk-config', 'skill', 'project-skill-shadow', 'whitelist', 'ledger', 'ledger-anchor', 'candidate-state', 'versions', 'locks', 'projection-presence',
  ])
})

test('runDoctor is read-only and reports a missing preset row without throwing', async () => {
  const options = await healthyFixture()
  await writeFile(options.presetPath, '- id: tool-skill\n', { flag: 'w' })
  const result = await runDoctor(options)
  assert.equal(result.ok, false)
  assert.equal(result.checks.find((check) => check.id === 'preset-disk-config').ok, false)
})
