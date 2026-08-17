import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

export async function snapshotRegularFile(path) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`target must not be a symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`target must be a regular file: ${path}`)
  const content = await readFile(path)
  return { path, content, hash: sha256(content), mode: stat.mode }
}

export async function withExclusiveLock(lockPath, fn) {
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`lock already exists: ${lockPath}`)
    throw error
  }
  try {
    await handle.writeFile(`${process.pid}\n`, 'utf8')
    await handle.sync()
    return await fn()
  } finally {
    await handle.close()
    await unlink(lockPath)
  }
}

export async function atomicReplace(target, content, expectedHash) {
  const before = await snapshotRegularFile(target)
  if (before.hash !== expectedHash) throw new Error('target hash changed before atomic replacement')
  const tempPath = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  const temp = await open(tempPath, 'wx', before.mode)
  let renamed = false
  try {
    await temp.writeFile(content)
    await temp.sync()
    await temp.close()
    const latest = await snapshotRegularFile(target)
    if (latest.hash !== expectedHash) throw new Error('target hash changed before atomic replacement')
    await rename(tempPath, target)
    renamed = true
    const directory = await open(dirname(target), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    const committed = await snapshotRegularFile(target)
    return { path: target, hash: committed.hash }
  } finally {
    if (!renamed) {
      try { await temp.close() } catch {}
      try { await unlink(tempPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}
