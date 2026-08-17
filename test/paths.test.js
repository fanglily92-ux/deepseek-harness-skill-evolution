import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertContainedRegularFile,
  resolveWorkbenchPaths,
} from '../src/paths.js'

test('resolveWorkbenchPaths returns only paths contained by the workspace', () => {
  const paths = resolveWorkbenchPaths('/workspace/lily_ai', { homePath: '/home/tester' })

  assert.equal(
    paths.receipts,
    '/workspace/lily_ai/logs/DeepSeek-Harness自进化/state/receipts.jsonl',
  )
  assert.equal(
    paths.evaluationRoot,
    '/workspace/lily_ai/tmp/DeepSeek-Harness自进化/evals',
  )
})

test('resolveWorkbenchPaths rejects broad or ambiguous workspace roots', () => {
  assert.throws(() => resolveWorkbenchPaths('/', { homePath: '/home/tester' }), /too broad/)
  assert.throws(() => resolveWorkbenchPaths('/home/tester', { homePath: '/home/tester' }), /home directory/)
  assert.throws(() => resolveWorkbenchPaths('relative/path', { homePath: '/home/tester' }), /absolute/)
})

test('assertContainedRegularFile accepts a real file inside the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-paths-'))
  const target = join(root, 'state', 'receipt.jsonl')
  await mkdir(join(root, 'state'))
  await writeFile(target, '{}\n', { flag: 'wx' })

  assert.equal(await assertContainedRegularFile(root, target), target)
})

test('assertContainedRegularFile rejects symlinks even when they resolve inside the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-paths-'))
  const real = join(root, 'real.json')
  const linked = join(root, 'linked.json')
  await writeFile(real, '{}\n', { flag: 'wx' })
  await symlink(real, linked)

  await assert.rejects(assertContainedRegularFile(root, linked), /symlink/)
})

test('assertContainedRegularFile rejects targets outside the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-paths-'))
  const other = await mkdtemp(join(tmpdir(), 'evolution-other-'))
  const target = join(other, 'receipt.jsonl')
  await writeFile(target, '{}\n', { flag: 'wx' })

  await assert.rejects(assertContainedRegularFile(root, target), /outside workspace/)
})
