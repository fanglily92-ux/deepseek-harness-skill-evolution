import { lstat, open, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'

import { atomicReplace, sha256, snapshotRegularFile } from './atomic-files.js'

const SUPPORTED_HARNESS_VERSION = '0.1.0-rc.6'
const MINIMUM_NODE_MAJOR = 22
const PLUGIN_ID = 'deepseek-skill-evolution'

export function detectHarnessVersion(command = 'dsh', spawn = spawnSync) {
  const result = spawn(command, ['--version'], { encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) throw new Error('could not read Harness version with dsh --version')
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const match = output.match(/\b\d+\.\d+\.\d+-rc\.\d+\b/)
  if (!match) throw new Error('unrecognized Harness version output')
  return match[0]
}

function assertSupportedVersions({ harnessVersion, nodeVersion }) {
  if (harnessVersion !== SUPPORTED_HARNESS_VERSION) {
    throw new Error(`unsupported Harness version: expected ${SUPPORTED_HARNESS_VERSION}`)
  }
  const nodeMajor = Number.parseInt(String(nodeVersion).replace(/^v/, '').split('.')[0], 10)
  if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    throw new Error(`unsupported Node.js version: expected >=${MINIMUM_NODE_MAJOR}`)
  }
}

async function assertRegularFile(path, label) {
  const stat = await lstat(path)
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`)
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`)
}

function assertInsideWorkspace(workspace, pluginEntry) {
  const parent = resolve(workspace)
  const child = resolve(pluginEntry)
  const offset = relative(parent, child)
  if (offset === '' || offset.startsWith('..') || offset.startsWith('/')) {
    throw new Error('plugin entry must be a file inside the workspace')
  }
}

function appendBlockFor({ workspace, pluginEntry }) {
  return [
    `- id: ${PLUGIN_ID}`,
    `  name: ${JSON.stringify(resolve(pluginEntry))}`,
    '  config:',
    `    workspace: ${JSON.stringify(resolve(workspace))}`,
    '',
  ].join('\n')
}

export async function planInstall(options) {
  const { workspace, pluginEntry, presetPath } = options
  assertSupportedVersions(options)
  assertInsideWorkspace(workspace, pluginEntry)
  await assertRegularFile(pluginEntry, 'plugin entry')
  await assertRegularFile(presetPath, 'preset')

  const before = await snapshotRegularFile(presetPath)
  const current = before.content.toString('utf8')
  if (new RegExp(`^\\s*-\\s+id:\\s*${PLUGIN_ID}\\s*$`, 'm').test(current)) {
    throw new Error(`preset already contains ${PLUGIN_ID}`)
  }
  if (!/^\s*-\s+id:\s*tool-skill\s*$/m.test(current)) {
    throw new Error('preset does not contain the required tool-skill row')
  }

  const appendBlock = appendBlockFor(options)
  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n'
  const plannedContent = `${current}${separator}${appendBlock}`
  return {
    presetPath: resolve(presetPath),
    beforeHash: before.hash,
    afterHash: sha256(plannedContent),
    appendBlock,
    plannedContent,
    writeRequired: true,
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
    const existing = await snapshotRegularFile(backupPath)
    if (existing.hash !== hash) throw new Error('existing backup does not match the preset snapshot')
  } finally {
    await handle?.close()
  }
  return backupPath
}

export async function installHarness(options) {
  if (!options.expectedPresetHash) throw new Error('expectedPresetHash is required for installation')
  const plan = await planInstall(options)
  if (plan.beforeHash !== options.expectedPresetHash) {
    throw new Error('preset hash changed since the approved preview')
  }
  const before = await readFile(plan.presetPath)
  const backupPath = await createVerifiedBackup(plan.presetPath, before, plan.beforeHash)
  const committed = await atomicReplace(plan.presetPath, plan.plannedContent, plan.beforeHash)
  return { ...plan, backupPath, committedHash: committed.hash }
}

export const installerContract = Object.freeze({
  pluginId: PLUGIN_ID,
  supportedHarnessVersion: SUPPORTED_HARNESS_VERSION,
  minimumNodeMajor: MINIMUM_NODE_MAJOR,
})
