import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertContainedRegularFile,
  assertContainedPathNoSymlinks,
  assertAuthorityRootOutsideSandboxTemp,
  resolveWorkbenchPaths,
} from '../src/paths.js'

test('resolveWorkbenchPaths returns only paths contained by the workspace', () => {
  const paths = resolveWorkbenchPaths('/workspace/lily_ai', { authorityRoot: '/authority/dsh', homePath: '/home/tester' })

  assert.equal(
    paths.receipts,
    '/authority/dsh/.skill-evolution-authority/state/receipts.jsonl',
  )
  assert.equal(
    paths.evaluationRoot,
    '/workspace/lily_ai/tmp/DeepSeek-Harness自进化/evals',
  )
  assert.equal(paths.strategy, '/authority/dsh/skills/optimize-work-strategy/references/strategies.yaml')
})

test('assertContainedPathNoSymlinks rejects a symlinked parent directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-paths-'))
  const outside = await mkdtemp(join(tmpdir(), 'evolution-outside-'))
  await symlink(outside, join(root, 'state'))
  await assert.rejects(
    assertContainedPathNoSymlinks(root, join(root, 'state', 'receipts.jsonl'), { allowMissingLeaf: true }),
    /symlink/,
  )
})

test('resolveWorkbenchPaths rejects broad or ambiguous workspace roots', () => {
  assert.throws(() => resolveWorkbenchPaths('/', { authorityRoot: '/authority/dsh', homePath: '/home/tester' }), /too broad/)
  assert.throws(() => resolveWorkbenchPaths('/home/tester', { authorityRoot: '/authority/dsh', homePath: '/home/tester' }), /home directory/)
  assert.throws(() => resolveWorkbenchPaths('relative/path', { authorityRoot: '/authority/dsh', homePath: '/home/tester' }), /absolute/)
  assert.throws(() => resolveWorkbenchPaths('/workspace/lily_ai', { authorityRoot: '/workspace/lily_ai/authority', homePath: '/home/tester' }), /authorityRoot must be outside workspace/)
  assert.throws(() => resolveWorkbenchPaths('/workspace/lily_ai', { authorityRoot: '/workspace', homePath: '/home/tester' }), /must not contain workspace/)
  assert.throws(() => assertAuthorityRootOutsideSandboxTemp('/tmp/evolution-authority', { temporaryRoot: '/tmp', realpath: (value) => value }), /temporary directory/)
  assert.throws(() => assertAuthorityRootOutsideSandboxTemp('/private/tmp/evolution-authority', {
    temporaryRoots: ['/tmp', '/private/tmp', '/var/tmp'], realpath: (value) => value,
  }), /temporary directory/)
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
