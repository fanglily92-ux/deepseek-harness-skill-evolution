import { lstat, readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { installerContract } from './installer.js'
import { assertAuthorityRootOutsideSandboxTemp, assertContainedPathNoSymlinks, canonicalWorkbenchRoots } from './paths.js'

async function regularFile(path) {
  try {
    const stat = await lstat(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function pathMissing(path) {
  try { await lstat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

async function containedRealPath(root, target) {
  try { await assertContainedPathNoSymlinks(root, target); return true } catch { return false }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail }
}

function readDshVersion(versionReader) {
  if (versionReader) return String(versionReader()).trim()
  const result = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (result.error || result.status !== 0) return null
  return String(result.stdout || result.stderr).trim()
}

async function hasNoLockFiles(paths) {
  for (const path of paths) {
    try {
      const entries = await readdir(path)
      if (entries.some((entry) => entry.endsWith('.lock'))) return false
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return true
}

export async function runDoctor(options) {
  const workspace = resolve(options.workspace)
  const authorityRoot = resolve(options.authorityRoot ?? options.dshHome)
  const authorityGuard = options.authorityGuard ?? assertAuthorityRootOutsideSandboxTemp
  const rootGuard = options.rootGuard ?? canonicalWorkbenchRoots
  const pluginEntry = resolve(options.pluginEntry)
  const presetPath = resolve(options.presetPath)
  const stateRoot = join(authorityRoot, '.skill-evolution-authority', 'state')
  const skillPath = join(authorityRoot, 'skills', 'optimize-work-strategy', 'SKILL.md')
  const projectSkillPath = join(workspace, '.dsh', 'skills', 'optimize-work-strategy')
  const pluginRoot = dirname(pluginEntry)
  const whitelistPath = join(pluginRoot, 'config', 'whitelist.json')
  const dashboardPath = join(workspace, '知识库', 'DeepSeek Harness自进化工作台', '工作台首页.md')
  const dshVersion = readDshVersion(options.versionReader)
  const preset = await readText(presetPath)
  const whitelist = await readText(whitelistPath)

  let whitelistOk = false
  try {
    const parsed = JSON.parse(whitelist ?? '')
    whitelistOk = parsed.schemaVersion === 1 && Array.isArray(parsed.skills) && parsed.skills.includes('optimize-work-strategy')
  } catch {}

  const presetOk = Boolean(
    preset
      && new RegExp(`^\\s*-\\s+id:\\s*${installerContract.pluginId}\\s*$`, 'm').test(preset)
      && preset.includes(JSON.stringify(pluginEntry))
      && preset.includes(JSON.stringify(workspace))
      && preset.includes(JSON.stringify(authorityRoot)),
  )

  const pluginRelation = relative(authorityRoot, pluginEntry)
  let authorityBoundaryOk = false
  try { authorityGuard(authorityRoot); authorityBoundaryOk = true } catch {}
  let workbenchRootsOk = false
  try { rootGuard(workspace, authorityRoot); workbenchRootsOk = true } catch {}
  const authorityOk = authorityBoundaryOk && workbenchRootsOk && pluginRelation !== '' && !pluginRelation.startsWith('..') && !isAbsolute(pluginRelation) && await containedRealPath(authorityRoot, pluginEntry)

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
  const checks = [
    check('platform', ['darwin', 'linux'].includes(process.platform), process.platform),
    check('node', nodeMajor >= installerContract.minimumNodeMajor, process.versions.node),
    check('dsh', Boolean(dshVersion), dshVersion ?? 'dsh command unavailable'),
    check('harness-version', dshVersion === installerContract.supportedHarnessVersion, dshVersion ?? 'unknown'),
    check('workbench-roots', workbenchRootsOk, 'workspace and authority are canonical, disjoint real paths'),
    check('authority-root', authorityOk, authorityRoot),
    check('plugin-entry', await regularFile(pluginEntry), pluginEntry),
    check('preset-disk-config', presetOk, presetPath),
    check('skill', await regularFile(skillPath), skillPath),
    check('project-skill-shadow', await pathMissing(projectSkillPath), projectSkillPath),
    check('whitelist', whitelistOk, whitelistPath),
    check('ledger', await regularFile(join(stateRoot, 'receipts.jsonl')), join(stateRoot, 'receipts.jsonl')),
    check('ledger-anchor', await regularFile(join(stateRoot, 'receipts.anchor.json')), join(stateRoot, 'receipts.anchor.json')),
    check('candidate-state', await regularFile(join(stateRoot, 'candidates.json')), join(stateRoot, 'candidates.json')),
    check('versions', await regularFile(join(stateRoot, 'versions.jsonl')), join(stateRoot, 'versions.jsonl')),
    check('locks', await hasNoLockFiles([stateRoot, join(authorityRoot, 'skills', 'optimize-work-strategy', 'references')]), 'no stale lock files'),
    check('projection-presence', await regularFile(dashboardPath), `${dashboardPath} (non-authoritative; freshness not verified)`),
  ]
  return { ok: checks.every((item) => item.ok), scope: 'disk-preflight-only', mountVerified: false, checks }
}
