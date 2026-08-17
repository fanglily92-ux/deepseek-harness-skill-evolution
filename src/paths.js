import { lstat } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

function assertContained(root, target) {
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
    throw new Error(`target is outside workspace: ${target}`)
  }
}

export function assertAuthorityRootOutsideSandboxTemp(authorityRoot, { temporaryRoot, temporaryRoots, realpath = realpathSync } = {}) {
  const authority = realpath(resolve(authorityRoot))
  if (authority !== resolve(authorityRoot)) throw new Error('authorityRoot must not be a symlink or aliased path')
  const roots = temporaryRoots ?? [temporaryRoot ?? tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp']
  for (const value of new Set(roots.map((root) => resolve(root)))) {
    let temporary
    try { temporary = realpath(value) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const relation = relative(temporary, authority)
    if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))) {
      throw new Error('authorityRoot may not be inside a sandbox-writable temporary directory')
    }
  }
  return authority
}

export function resolveWorkbenchPaths(workspace, { authorityRoot, homePath = homedir() } = {}) {
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
  if (typeof authorityRoot !== 'string' || !isAbsolute(authorityRoot)) throw new Error('authorityRoot must be an absolute path')
  const authority = resolve(authorityRoot)
  if (authority === resolve('/') || authority === resolve(homePath)) throw new Error('authorityRoot is too broad')
  const authorityFromWorkspace = relative(root, authority)
  if (authorityFromWorkspace === '' || (!authorityFromWorkspace.startsWith('..') && !isAbsolute(authorityFromWorkspace))) {
    throw new Error('authorityRoot must be outside workspace')
  }
  const workspaceFromAuthority = relative(authority, root)
  if (workspaceFromAuthority === '' || (!workspaceFromAuthority.startsWith('..') && !isAbsolute(workspaceFromAuthority))) {
    throw new Error('authorityRoot must not contain workspace')
  }

  const stateRoot = join(authority, '.skill-evolution-authority', 'state')
  const paths = {
    workspace: root,
    authorityRoot: authority,
    receipts: join(stateRoot, 'receipts.jsonl'),
    receiptAnchor: join(stateRoot, 'receipts.anchor.json'),
    candidates: join(stateRoot, 'candidates.json'),
    versions: join(stateRoot, 'versions.jsonl'),
    promotionJournal: join(stateRoot, 'promotion.journal.json'),
    backups: join(stateRoot, 'backups'),
    strategy: join(authority, 'skills', 'optimize-work-strategy', 'references', 'strategies.yaml'),
    stableSkill: join(authority, 'skills', 'optimize-work-strategy', 'SKILL.md'),
    projectSkill: join(root, '.dsh', 'skills', 'optimize-work-strategy'),
    evaluationRoot: join(root, 'tmp', 'DeepSeek-Harness自进化', 'evals'),
  }

  for (const value of [paths.receipts, paths.receiptAnchor, paths.candidates, paths.versions, paths.promotionJournal, paths.backups, paths.strategy, paths.stableSkill]) assertContained(authority, value)
  assertContained(root, paths.evaluationRoot)
  assertContained(root, paths.projectSkill)
  return Object.freeze(paths)
}

export function assertProjectSkillAbsent(projectSkill, { lstat = lstatSync } = {}) {
  try {
    lstat(projectSkill)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error('project Skill shadows the protected user Skill')
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
