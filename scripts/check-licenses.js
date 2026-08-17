#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APPROVED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Python-2.0'])

export async function checkLockLicenses(lockPath) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json must use lockfileVersion 3')
  }
  const dependencies = Object.entries(lock.packages)
    .filter(([path]) => path !== '')
    .map(([path, metadata]) => ({
      package: path.replace(/^.*node_modules\//, ''),
      version: metadata.version ?? 'unknown',
      license: metadata.license ?? 'MISSING',
    }))
    .sort((left, right) => left.package.localeCompare(right.package))
  const rejected = dependencies.filter((item) => !APPROVED.has(item.license))
  return { ok: rejected.length === 0, dependencyCount: dependencies.length, dependencies, rejected }
}

async function main() {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const result = await checkLockLicenses(resolve(process.argv[2] ?? `${root}/package-lock.json`))
  if (!result.ok) {
    for (const item of result.rejected) process.stderr.write(`${item.package}@${item.version}: ${item.license}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`PASS dependency license scan: ${result.dependencyCount} packages, approved SPDX licenses only\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
