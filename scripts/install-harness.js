#!/usr/bin/env node
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectHarnessVersion, installHarness, planInstall } from '../src/installer.js'

function usage() {
  return [
    'Usage:',
    '  node scripts/install-harness.js --workspace <absolute-path> [--dsh-home <path>]',
    '  node scripts/install-harness.js --workspace <absolute-path> --apply --expected-preset-hash <sha256> --expected-source-manifest-hash <sha256>',
    '',
    'The default mode is a zero-write preview. --apply requires the exact preview hash.',
  ].join('\n')
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--apply') values.apply = true
    else if (item === '--dry-run') values.apply = false
    else if (item.startsWith('--')) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${item}`)
      values[item.slice(2)] = value
      index += 1
    } else throw new Error(`unknown argument: ${item}`)
  }
  return values
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.workspace) throw new Error(`--workspace is required\n\n${usage()}`)
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dshHome = resolve(args['dsh-home'] ?? join(homedir(), '.dsh'))
  const options = {
    workspace: resolve(args.workspace),
    dshHome,
    sourceRoot: scriptRoot,
    presetPath: join(dshHome, '.agent-presets', 'video-reader', 'agent.cordis.yml'),
    harnessVersion: detectHarnessVersion(),
    nodeVersion: process.versions.node,
  }
  if (!args.apply) {
    const plan = await planInstall(options)
    process.stdout.write(`${JSON.stringify({
      mode: 'preview-only',
      presetPath: plan.presetPath,
      beforeHash: plan.beforeHash,
      afterHash: plan.afterHash,
      sourceManifestHash: plan.sourceManifestHash,
      pluginDirectory: plan.pluginDirectory,
      skillDirectory: plan.skillDirectory,
      appendBlock: plan.appendBlock,
      writePerformed: false,
    }, null, 2)}\n`)
    return
  }
  if (!args['expected-preset-hash']) throw new Error('--apply requires --expected-preset-hash from an approved preview')
  if (!args['expected-source-manifest-hash']) throw new Error('--apply requires --expected-source-manifest-hash from an approved preview')
  const result = await installHarness({ ...options, expectedPresetHash: args['expected-preset-hash'], expectedSourceManifestHash: args['expected-source-manifest-hash'] })
  process.stdout.write(`${JSON.stringify({
    mode: 'applied',
    presetPath: result.presetPath,
    backupPath: result.backupPath,
    pluginDirectory: result.pluginDirectory,
    skillDirectory: result.skillDirectory,
    committedHash: result.committedHash,
  }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
