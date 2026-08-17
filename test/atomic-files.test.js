import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { atomicReplace, sha256, snapshotRegularFile, withExclusiveLock } from '../src/atomic-files.js'

test('snapshotRegularFile rejects a symlink target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-atomic-'))
  const real = join(root, 'real.json')
  const linked = join(root, 'linked.json')
  await writeFile(real, '{}\n', { flag: 'wx' })
  await symlink(real, linked)

  await assert.rejects(snapshotRegularFile(linked), /symlink/)
})

test('atomicReplace uses compare-and-swap and preserves bytes on a stale hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-atomic-'))
  const target = join(root, 'catalog.json')
  await writeFile(target, 'old\n', { flag: 'wx' })

  await assert.rejects(atomicReplace(target, 'new\n', '0'.repeat(64)), /target hash changed/)
  assert.equal(await readFile(target, 'utf8'), 'old\n')

  const result = await atomicReplace(target, 'new\n', sha256('old\n'))
  assert.equal(await readFile(target, 'utf8'), 'new\n')
  assert.equal(result.hash, sha256('new\n'))
})

test('withExclusiveLock never removes an existing unknown lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-lock-'))
  const lock = join(root, 'catalog.lock')
  await writeFile(lock, 'other-process\n', { flag: 'wx' })

  await assert.rejects(withExclusiveLock(lock, async () => undefined), /lock already exists/)
  assert.equal(await readFile(lock, 'utf8'), 'other-process\n')
})
