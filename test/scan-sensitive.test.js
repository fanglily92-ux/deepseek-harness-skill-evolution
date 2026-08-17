import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanSensitiveFiles } from '../scripts/scan-sensitive.js'

test('sensitive scan passes clean source and detects credentials, private keys, and personal absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-sensitive-'))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'clean.js'), 'export const example = "$WORKSPACE"\n')
  assert.deepEqual(await scanSensitiveFiles(root), [])

  const personalPath = ['/Us', 'ers/example/private.txt'].join('')
  const credential = ['OPENAI_API_', 'KEY=sk-example-value'].join('')
  const credentialUrl = ['https://user', ':password@example.invalid'].join('')
  const npmToken = ['_auth', 'Token=secret-value'].join('')
  await writeFile(join(root, 'src', 'bad.js'), `${personalPath}\n${credential}\n-----BEGIN RSA ${'PRIVATE KEY'}-----\n${credentialUrl}\n${npmToken}\n`)
  const findings = await scanSensitiveFiles(root)
  assert.deepEqual(new Set(findings.map((item) => item.rule)), new Set(['absolute-user-path', 'credential-assignment', 'private-key', 'credential-url', 'npm-auth-token']))
})
