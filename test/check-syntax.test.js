import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const checker = fileURLToPath(new URL('../scripts/check-syntax.js', import.meta.url))

test('check-syntax exits zero after checking valid JavaScript files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-syntax-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'valid.js'), 'export const value = 1\n', { flag: 'wx' })

  const result = spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS src\/valid\.js/)
})

test('check-syntax exits nonzero and identifies an invalid JavaScript file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-syntax-'))
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts', 'invalid.js'), 'function (\n', { flag: 'wx' })

  const result = spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /FAIL scripts\/invalid\.js/)
})
