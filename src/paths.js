import { lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

function assertContained(root, target) {
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
    throw new Error(`target is outside workspace: ${target}`)
  }
}

export function resolveWorkbenchPaths(workspace, { homePath = homedir() } = {}) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
    throw new Error('workspace must be an absolute path')
  }

  const root = resolve(workspace)
  if (root === resolve('/')) {
    throw new Error('workspace root is too broad')
  }
  if (root === resolve(homePath)) {
    throw new Error('workspace may not be the home directory')
  }

  const paths = {
    workspace: root,
    receipts: join(root, 'logs', 'DeepSeek-Harness自进化', 'state', 'receipts.jsonl'),
    candidates: join(root, 'logs', 'DeepSeek-Harness自进化', 'state', 'candidates.json'),
    versions: join(root, 'logs', 'DeepSeek-Harness自进化', 'state', 'versions.jsonl'),
    evaluationRoot: join(root, 'tmp', 'DeepSeek-Harness自进化', 'evals'),
  }

  for (const value of Object.values(paths)) {
    assertContained(root, value)
  }
  return Object.freeze(paths)
}

export async function assertContainedRegularFile(root, target) {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  assertContained(resolvedRoot, resolvedTarget)

  const stat = await lstat(resolvedTarget)
  if (stat.isSymbolicLink()) {
    throw new Error(`target must not be a symlink: ${resolvedTarget}`)
  }
  if (!stat.isFile()) {
    throw new Error(`target must be a regular file: ${resolvedTarget}`)
  }
  return resolvedTarget
}

export async function assertContainedPathNoSymlinks(root, target, { allowMissingLeaf = false } = {}) {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(target)
  assertContained(resolvedRoot, resolvedTarget)
  const rootStat = await lstat(resolvedRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`workspace root must be a real directory: ${resolvedRoot}`)
  const parts = relative(resolvedRoot, resolvedTarget).split(process.platform === 'win32' ? '\\' : '/').filter(Boolean)
  let cursor = resolvedRoot
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index])
    let stat
    try {
      stat = await lstat(cursor)
    } catch (error) {
      if (error.code === 'ENOENT' && (allowMissingLeaf || index < parts.length - 1)) return resolvedTarget
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`path component must not be a symlink: ${cursor}`)
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`path parent must be a directory: ${cursor}`)
  }
  return resolvedTarget
}
