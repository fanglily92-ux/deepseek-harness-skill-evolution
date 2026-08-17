import { readdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseRoot(argv) {
  const index = argv.indexOf('--root')
  if (index === -1) return resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (!argv[index + 1]) throw new Error('--root requires a path')
  return resolve(argv[index + 1])
}

async function collectJavaScript(root) {
  const results = []
  const candidates = ['index.js', 'src', 'scripts', 'test']
  for (const candidate of candidates) {
    const target = join(root, candidate)
    let targetStat
    try {
      targetStat = await stat(target)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (targetStat.isFile() && target.endsWith('.js')) {
      results.push(target)
      continue
    }
    if (!targetStat.isDirectory()) continue
    const entries = await readdir(target, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        results.push(join(entry.parentPath, entry.name))
      }
    }
  }
  return results.sort()
}

const root = parseRoot(process.argv.slice(2))
const files = await collectJavaScript(root)
for (const file of files) {
  const label = relative(root, file).split('\\').join('/')
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(`FAIL ${label}`)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = 1
    break
  }
  console.log(`PASS ${label}`)
}
