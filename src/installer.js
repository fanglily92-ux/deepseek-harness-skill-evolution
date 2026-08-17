import { spawnSync } from 'node:child_process'
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { atomicReplace, sha256, snapshotRegularFile } from './atomic-files.js'
import { assertContainedPathNoSymlinks } from './paths.js'

const SUPPORTED_HARNESS_VERSION = '0.1.0-rc.6'
const MINIMUM_NODE_MAJOR = 22
const PLUGIN_ID = 'deepseek-skill-evolution'
const PUBLISH_ENTRIES = ['index.js', 'src', 'config', 'eval', 'skills', 'scripts', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']

export function detectHarnessVersion(command = 'dsh', spawn = spawnSync) {
  const result = spawn(command, ['--version'], { encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) throw new Error('could not read Harness version with dsh --version')
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const match = output.match(/\b\d+\.\d+\.\d+-rc\.\d+\b/)
  if (!match) throw new Error('unrecognized Harness version output')
  return match[0]
}

function assertSupportedVersions({ harnessVersion, nodeVersion }) {
  if (harnessVersion !== SUPPORTED_HARNESS_VERSION) throw new Error(`unsupported Harness version: expected ${SUPPORTED_HARNESS_VERSION}`)
  const nodeMajor = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10)
  if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) throw new Error(`unsupported Node.js version: expected >=${MINIMUM_NODE_MAJOR}`)
}

async function statOrNull(path) {
  try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function collectFiles(sourceRoot, relativePath, output) {
  const source = join(sourceRoot, relativePath)
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) throw new Error(`install source must not contain symlinks: ${relativePath}`)
  if (stat.isFile()) {
    const content = await readFile(source)
    output.push({ path: relativePath.replaceAll('\\', '/'), hash: sha256(content), size: content.length })
    return
  }
  if (!stat.isDirectory()) throw new Error(`install source must contain only regular files: ${relativePath}`)
  const entries = await readdir(source)
  entries.sort()
  for (const entry of entries) await collectFiles(sourceRoot, join(relativePath, entry), output)
}

async function sourceManifest(sourceRoot) {
  const files = []
  for (const entry of PUBLISH_ENTRIES) await collectFiles(sourceRoot, entry, files)
  return { files, hash: sha256(JSON.stringify(files)) }
}

function assertInside(parent, child, label) {
  const offset = relative(resolve(parent), resolve(child))
  if (offset === '' || offset.startsWith('..') || isAbsolute(offset)) throw new Error(`${label} must be inside ${parent}`)
}

function appendBlockFor({ workspace, authorityRoot, pluginEntry }) {
  return [
    `- id: ${PLUGIN_ID}`,
    `  name: ${JSON.stringify(resolve(pluginEntry))}`,
    '  config:',
    `    workspace: ${JSON.stringify(resolve(workspace))}`,
    `    authorityRoot: ${JSON.stringify(resolve(authorityRoot))}`,
    '',
  ].join('\n')
}

export async function planInstall(options) {
  assertSupportedVersions(options)
  const sourceRoot = resolve(options.sourceRoot)
  const dshHome = resolve(options.dshHome)
  const workspace = resolve(options.workspace)
  const presetPath = resolve(options.presetPath)
  const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  if (packageJson.name !== 'deepseek-harness-skill-evolution' || typeof packageJson.version !== 'string') throw new Error('invalid plugin package manifest')
  const pluginDirectory = join(dshHome, 'plugins', PLUGIN_ID, packageJson.version)
  const pluginEntry = join(pluginDirectory, 'index.js')
  const skillDirectory = join(dshHome, 'skills', 'optimize-work-strategy')
  const projectSkill = join(workspace, '.dsh', 'skills', 'optimize-work-strategy')
  assertInside(dshHome, pluginEntry, 'plugin entry')
  assertInside(dshHome, skillDirectory, 'Skill directory')
  await assertContainedPathNoSymlinks(dshHome, pluginDirectory, { allowMissingLeaf: true })
  await assertContainedPathNoSymlinks(dshHome, skillDirectory, { allowMissingLeaf: true })
  await assertContainedPathNoSymlinks(dshHome, presetPath)
  if (await statOrNull(projectSkill)) throw new Error('project Skill shadows the protected user Skill')
  if (await statOrNull(pluginDirectory)) throw new Error('plugin install target already exists')
  if (await statOrNull(skillDirectory)) throw new Error('Skill install target already exists')
  const presetStat = await lstat(presetPath)
  if (presetStat.isSymbolicLink() || !presetStat.isFile()) throw new Error('preset must be a regular file')
  const manifest = await sourceManifest(sourceRoot)
  const before = await snapshotRegularFile(presetPath)
  const current = before.content.toString('utf8')
  if (new RegExp(`^\\s*-\\s+id:\\s*${PLUGIN_ID}\\s*$`, 'm').test(current)) throw new Error(`preset already contains ${PLUGIN_ID}`)
  if (!/^\s*-\s+id:\s*tool-skill\s*$/m.test(current)) throw new Error('preset does not contain the required tool-skill row')
  const appendBlock = appendBlockFor({ workspace, authorityRoot: dshHome, pluginEntry })
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  const plannedContent = `${current}${separator}${appendBlock}`
  return {
    sourceRoot, dshHome, workspace, presetPath, pluginDirectory, pluginEntry, skillDirectory,
    beforeHash: before.hash, afterHash: sha256(plannedContent), sourceManifestHash: manifest.hash,
    sourceFiles: manifest.files, appendBlock, plannedContent, writeRequired: true,
  }
}

async function createVerifiedBackup(presetPath, content, hash) {
  const backupPath = `${presetPath}.before-${PLUGIN_ID}-${hash.slice(0, 12)}.bak`
  let handle
  try {
    handle = await open(backupPath, 'wx', 0o600)
    await handle.writeFile(content)
    await handle.sync()
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if ((await snapshotRegularFile(backupPath)).hash !== hash) throw new Error('existing backup does not match the preset snapshot')
  } finally { await handle?.close() }
  return backupPath
}

async function copyManifest(sourceRoot, targetRoot, files, transform = (path) => path) {
  for (const file of files) {
    const destination = join(targetRoot, transform(file.path))
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const content = await readFile(join(sourceRoot, file.path))
    if (sha256(content) !== file.hash) throw new Error(`source changed after preview: ${file.path}`)
    await writeFile(destination, content, { flag: 'wx', mode: 0o600 })
  }
}

export async function installHarness(options) {
  if (!options.expectedPresetHash || !options.expectedSourceManifestHash) throw new Error('expectedPresetHash and expectedSourceManifestHash are required for installation')
  const plan = await planInstall(options)
  if (plan.beforeHash !== options.expectedPresetHash) throw new Error('preset hash changed since the approved preview')
  if (plan.sourceManifestHash !== options.expectedSourceManifestHash) throw new Error('source manifest changed since the approved preview')
  let pluginCreated = false
  let skillCreated = false
  try {
    await mkdir(plan.pluginDirectory, { recursive: true, mode: 0o700 })
    pluginCreated = true
    await copyManifest(plan.sourceRoot, plan.pluginDirectory, plan.sourceFiles)
    await mkdir(plan.skillDirectory, { recursive: true, mode: 0o700 })
    skillCreated = true
    const skillPrefix = 'skills/optimize-work-strategy/'
    const skillFiles = plan.sourceFiles.filter((file) => file.path.startsWith(skillPrefix))
    await copyManifest(plan.sourceRoot, plan.skillDirectory, skillFiles, (path) => path.slice(skillPrefix.length))
    const before = await readFile(plan.presetPath)
    const backupPath = await createVerifiedBackup(plan.presetPath, before, plan.beforeHash)
    const committed = await atomicReplace(plan.presetPath, plan.plannedContent, plan.beforeHash)
    return { ...plan, backupPath, committedHash: committed.hash }
  } catch (error) {
    if (skillCreated) await rm(plan.skillDirectory, { recursive: true, force: true })
    if (pluginCreated) await rm(plan.pluginDirectory, { recursive: true, force: true })
    throw error
  }
}

export const installerContract = Object.freeze({ pluginId: PLUGIN_ID, supportedHarnessVersion: SUPPORTED_HARNESS_VERSION, minimumNodeMajor: MINIMUM_NODE_MAJOR })
