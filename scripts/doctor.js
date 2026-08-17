#!/usr/bin/env node
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

import { runDoctor } from '../src/doctor.js'

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) throw new Error(`unknown argument: ${item}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${item}`)
    values[item.slice(2)] = value
    index += 1
  }
  return values
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.workspace) throw new Error('--workspace is required')
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dshHome = resolve(args['dsh-home'] ?? join(homedir(), '.dsh'))
  const packageJson = JSON.parse(await readFile(join(scriptRoot, 'package.json'), 'utf8'))
  const result = await runDoctor({
    workspace: resolve(args.workspace),
    dshHome,
    authorityRoot: dshHome,
    pluginEntry: resolve(args['plugin-entry'] ?? join(dshHome, 'plugins', 'deepseek-skill-evolution', packageJson.version, 'index.js')),
    presetPath: join(dshHome, '.agent-presets', 'video-reader', 'agent.cordis.yml'),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
