import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evaluateRegression, restoreStableVersion } from '../src/rollback.js'
import { sha256 } from '../src/atomic-files.js'

test('evaluateRegression rolls back one attributable critical regression', () => {
  assert.deepEqual(
    evaluateRegression({ regressionClass: 'privacy', attributableVersionHash: 'a'.repeat(64) }, { hash: 'a'.repeat(64), efficiencyObservations: {} }),
    { action: 'rollback', reason: 'verified critical regression: privacy' },
  )
})

test('evaluateRegression needs two matching efficiency observations and ignores external failures', () => {
  assert.deepEqual(
    evaluateRegression({ regressionClass: 'efficiency', fingerprint: 'slow-1', attributableVersionHash: 'a'.repeat(64) }, { hash: 'a'.repeat(64), efficiencyObservations: {} }),
    { action: 'observe', reason: 'first reproducible efficiency regression: slow-1' },
  )
  assert.equal(
    evaluateRegression({ regressionClass: 'efficiency', fingerprint: 'slow-1', attributableVersionHash: 'a'.repeat(64) }, { hash: 'a'.repeat(64), efficiencyObservations: { 'slow-1': 1 } }).action,
    'rollback',
  )
  for (const regressionClass of ['QUOTA', 'TRANSPORT', 'CANCELLED', 'PROVIDER', 'UNRELATED_TOOL']) {
    assert.equal(evaluateRegression({ regressionClass }, { hash: 'a'.repeat(64), efficiencyObservations: {} }).action, 'none')
  }
})

test('restoreStableVersion compares the regressed hash before restoring backup bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-rollback-'))
  const strategyPath = join(root, 'strategies.yaml')
  const backupPath = join(root, 'backup.yaml')
  await writeFile(strategyPath, 'regressed\n', { flag: 'wx' })
  await writeFile(backupPath, 'stable\n', { flag: 'wx' })

  await restoreStableVersion({ strategyPath, backupPath, regressedHash: sha256('regressed\n') })
  assert.equal(await readFile(strategyPath, 'utf8'), 'stable\n')
})
