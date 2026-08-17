#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXCLUDED = new Set(['.git', 'node_modules', 'coverage'])
const macUserRoot = `/${['Us', 'ers'].join('')}/`
const linuxUserRoot = `/${['ho', 'me'].join('')}/`
const RULES = [
  ['absolute-user-path', new RegExp(`(?:${macUserRoot}|${linuxUserRoot})[^/\\s"']+/`)],
  ['credential-assignment', new RegExp(String.raw`(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|COOKIE)\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{8,}`, 'i')],
  ['private-key', new RegExp(['-----BEGIN ', '[A-Z ]*PRIVATE KEY-----'].join(''))],
  ['credential-url', /https?:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['npm-auth-token', /(?:^|\s)_authToken\s*=\s*[^\s$][^\s]*/i],
]

async function collectFiles(root, directory = root) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) files.push(...await collectFiles(root, path))
    else if (stat.isFile()) files.push(path)
  }
  return files
}

export async function scanSensitiveFiles(root) {
  const resolvedRoot = resolve(root)
  const findings = []
  for (const path of await collectFiles(resolvedRoot)) {
    const buffer = await readFile(path)
    if (buffer.includes(0)) continue
    const lines = buffer.toString('utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      for (const [rule, pattern] of RULES) {
        if (pattern.test(lines[index])) findings.push({ file: relative(resolvedRoot, path), line: index + 1, rule })
      }
    }
  }
  return findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.rule.localeCompare(right.rule))
}

async function main() {
  const root = resolve(process.argv[2] ?? resolve(fileURLToPath(new URL('..', import.meta.url))))
  const findings = await scanSensitiveFiles(root)
  if (findings.length === 0) {
    process.stdout.write('PASS sensitive-information scan: 0 findings\n')
    return
  }
  for (const finding of findings) process.stderr.write(`${finding.file}:${finding.line} ${finding.rule}\n`)
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
