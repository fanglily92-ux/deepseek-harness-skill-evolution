import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkLockLicenses } from '../scripts/check-licenses.js'

test('license check accepts approved SPDX licenses and rejects missing metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-license-'))
  const path = join(root, 'package-lock.json')
  await writeFile(path, JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'root', version: '1.0.0' },
    'node_modules/a': { version: '1.0.0', license: 'MIT' },
  } }))
  assert.equal((await checkLockLicenses(path)).ok, true)
  await writeFile(path, JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'root', version: '1.0.0' },
    'node_modules/a': { version: '1.0.0' },
  } }))
  assert.equal((await checkLockLicenses(path)).ok, false)
})
