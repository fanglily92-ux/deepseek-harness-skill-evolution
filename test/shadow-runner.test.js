import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createIsolatedRun } from '../src/shadow-runner.js'

test('createIsolatedRun creates distinct stable and candidate roots outside Skill discovery paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'evolution-shadow-'))
  const run = await createIsolatedRun({ candidateId: 'EVO-20260817-001', runId: 'run-001', workspace })

  assert.notEqual(run.stableRoot, run.candidateRoot)
  assert.match(run.root, /tmp\/DeepSeek-Harness自进化\/evals\/EVO-20260817-001\/run-001$/)
  for (const path of [run.root, run.stableRoot, run.candidateRoot]) {
    assert.equal(path.includes('/.dsh/skills/'), false)
    assert.equal(path.includes('/.agents/skills/'), false)
    await access(path)
  }
  await run.cleanup()
  await assert.rejects(access(run.root), /ENOENT/)
})

test('createIsolatedRun rejects traversal in candidate and run identifiers', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'evolution-shadow-'))
  await assert.rejects(
    createIsolatedRun({ candidateId: '../escape', runId: 'run-001', workspace }),
    /invalid candidate id/,
  )
  await assert.rejects(
    createIsolatedRun({ candidateId: 'EVO-20260817-001', runId: '../escape', workspace }),
    /invalid run id/,
  )
})
