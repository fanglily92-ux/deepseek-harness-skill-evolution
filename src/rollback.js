import { readFile } from 'node:fs/promises'

import { atomicReplace, sha256, snapshotRegularFile } from './atomic-files.js'

const CRITICAL = new Set(['safety', 'privacy', 'approval', 'critical-quality', 'primary-metric'])
const EXTERNAL = new Set(['QUOTA', 'TRANSPORT', 'CANCELLED', 'PROVIDER', 'UNRELATED_TOOL'])

export function evaluateRegression(receipt, activeVersion) {
  if (EXTERNAL.has(receipt.regressionClass)) return { action: 'none', reason: 'external or unrelated failure' }
  if (receipt.attributableVersionHash !== activeVersion.hash) return { action: 'none', reason: 'regression is not attributable to the active version' }
  if (CRITICAL.has(receipt.regressionClass)) return { action: 'rollback', reason: `verified critical regression: ${receipt.regressionClass}` }
  if (receipt.regressionClass === 'subjective') return { action: 'observe', reason: 'subjective concern requires human review' }
  if (receipt.regressionClass === 'efficiency') {
    if (typeof receipt.fingerprint !== 'string' || receipt.fingerprint.length === 0) return { action: 'none', reason: 'efficiency regression lacks a fingerprint' }
    const prior = activeVersion.efficiencyObservations?.[receipt.fingerprint] ?? 0
    if (prior >= 1) return { action: 'rollback', reason: `repeated efficiency regression: ${receipt.fingerprint}` }
    return { action: 'observe', reason: `first reproducible efficiency regression: ${receipt.fingerprint}` }
  }
  return { action: 'none', reason: 'unrecognized regression class' }
}

export async function restoreStableVersion({ strategyPath, backupPath, regressedHash }) {
  const current = await snapshotRegularFile(strategyPath)
  if (current.hash !== regressedHash) throw new Error('active strategy hash no longer matches the regressed version')
  const backup = await snapshotRegularFile(backupPath)
  await atomicReplace(strategyPath, backup.content, regressedHash)
  const restored = await readFile(strategyPath)
  if (sha256(restored) !== backup.hash) throw new Error('rollback postcondition failed')
  return { restoredHash: backup.hash }
}
