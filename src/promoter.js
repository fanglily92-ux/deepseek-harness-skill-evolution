import { createHash } from 'node:crypto'
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { atomicReplace, sha256, snapshotRegularFile, withExclusiveLock } from './atomic-files.js'
import { hashCandidateProposal } from './integrity.js'
import { parseStrategyCatalog, validateStrategyRule } from './strategy-rules.js'

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function hashCatalog(catalog) {
  return createHash('sha256').update(canonicalJson(catalog)).digest('hex')
}

async function persistBackup(directory, snapshot) {
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${snapshot.hash}.yaml`)
  try {
    await writeFile(path, snapshot.content, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (sha256(await readFile(path)) !== snapshot.hash) throw new Error('existing backup hash mismatch')
  }
  return path
}

async function appendVersion(path, row) {
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.appendFile(`${JSON.stringify(row)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeDurableExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally { await handle.close() }
}

function journalSnapshot(snapshot) {
  return { path: snapshot.path, hash: snapshot.hash, contentBase64: snapshot.content.toString('base64') }
}

async function restoreJournalSnapshot(snapshot) {
  const current = await snapshotRegularFile(snapshot.path)
  const content = Buffer.from(snapshot.contentBase64, 'base64')
  if (sha256(content) !== snapshot.hash) throw new Error('promotion journal snapshot hash mismatch')
  if (current.hash !== snapshot.hash) await atomicReplace(snapshot.path, content, current.hash)
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

export async function recoverPromotionJournal({ journalPath, expectedPaths, expectedLockPath, force = false }) {
  let journal
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return { recovered: false }; throw error }
  if (journal?.schemaVersion !== 1 || !['prepared', 'committed'].includes(journal.phase) || !Array.isArray(journal.snapshots)) throw new Error('invalid promotion journal')
  if (!Array.isArray(expectedPaths) || expectedPaths.length !== journal.snapshots.length) throw new Error('promotion recovery requires exact expected paths')
  const actualPaths = journal.snapshots.map((snapshot) => snapshot.path).sort()
  const allowedPaths = [...expectedPaths].sort()
  if (JSON.stringify(actualPaths) !== JSON.stringify(allowedPaths) || journal.lockPath !== expectedLockPath) throw new Error('promotion journal path binding mismatch')
  if (journal.phase === 'committed') {
    for (const [path, expectedHash] of Object.entries(journal.afterHashes ?? {})) {
      if ((await snapshotRegularFile(path)).hash !== expectedHash) throw new Error('committed promotion journal postcondition mismatch')
    }
    await unlink(journalPath)
    return { recovered: true, action: 'confirmed-commit' }
  }
  if (!force && processAlive(journal.pid)) throw new Error('promotion transaction is still active')
  for (const snapshot of [...journal.snapshots].reverse()) await restoreJournalSnapshot(snapshot)
  try { await unlink(journal.lockPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await unlink(journalPath)
  return { recovered: true, action: 'rolled-back' }
}

export async function promoteCandidate({ candidate, validationReport, strategyPath, versionsPath, backupDirectory, candidateStatePath, journalPath, now = Date.now, faultAfter, simulateCrash = false }) {
  if (candidate.state !== 'awaiting-approval') throw new Error('candidate is not awaiting approval')
  if (!validationReport.pass || validationReport.candidateId !== candidate.id) throw new Error('validation report does not approve candidate')
  if (validationReport.reportHash !== candidate.validationReportHash) throw new Error('validation report hash mismatch')
  if (validationReport.baselineHash !== candidate.baselineHash) throw new Error('validation baseline hash mismatch')
  if (hashCandidateProposal(candidate.proposedRule) !== candidate.candidateHash) throw new Error('candidate content hash mismatch')
  const expectedCandidateValue = validationReport.scorecard?.supportCandidate / validationReport.scorecard?.supportCount
  if (!Number.isFinite(expectedCandidateValue) || candidate.proposedRule.candidateValue !== expectedCandidateValue) {
    throw new Error('candidate metric is not bound to validation scorecard')
  }
  validateStrategyRule(candidate.proposedRule)
  if (candidate.proposedRule.status !== 'candidate') throw new Error('proposed rule is not a candidate')

  return withExclusiveLock(`${strategyPath}.lock`, async () => {
    const oldSnapshot = await snapshotRegularFile(strategyPath)
    const transactionSnapshots = candidateStatePath && journalPath
      ? [oldSnapshot, await snapshotRegularFile(versionsPath), await snapshotRegularFile(candidateStatePath)]
      : null
    let journalSnapshotState
    if (transactionSnapshots) {
      const journal = {
        schemaVersion: 1, phase: 'prepared', pid: process.pid, lockPath: `${strategyPath}.lock`,
        snapshots: transactionSnapshots.map(journalSnapshot), afterHashes: {},
      }
      await writeDurableExclusive(journalPath, journal)
      journalSnapshotState = await snapshotRegularFile(journalPath)
    }
    const current = parseStrategyCatalog(oldSnapshot.content.toString('utf8'))
    if (hashCatalog(current) !== candidate.baselineHash) throw new Error('candidate baseline is stale')
    const backupPath = await persistBackup(backupDirectory, oldSnapshot)
    const promotedRule = { ...structuredClone(candidate.proposedRule), status: 'stable' }
    const next = { schemaVersion: current.schemaVersion, stableVersion: current.stableVersion + 1, rules: [...structuredClone(current.rules), promotedRule] }
    const nextContent = `${JSON.stringify(next, null, 2)}\n`
    const committed = await atomicReplace(strategyPath, nextContent, oldSnapshot.hash)
    const row = { schemaVersion: 1, candidateId: candidate.id, stableVersion: next.stableVersion, previousHash: oldSnapshot.hash, hash: committed.hash, validationReportHash: validationReport.reportHash, promotedAt: now() }
    try {
      await appendVersion(versionsPath, row)
      if (faultAfter === 'version-appended') throw new Error('simulated promotion crash')
      if (candidateStatePath) {
        const candidateSnapshot = transactionSnapshots[2]
        const state = JSON.parse(candidateSnapshot.content.toString('utf8'))
        const stored = state.candidates?.find((item) => item.id === candidate.id)
        if (!stored || stored.state !== 'awaiting-approval') throw new Error('candidate state changed before promotion commit')
        stored.state = 'promoted'
        await atomicReplace(candidateStatePath, `${JSON.stringify(state, null, 2)}\n`, candidateSnapshot.hash)
      }
    } catch (error) {
      if (simulateCrash && error.message === 'simulated promotion crash') throw error
      if (transactionSnapshots) {
        for (const snapshot of [...transactionSnapshots].reverse()) await restoreJournalSnapshot(journalSnapshot(snapshot))
        await unlink(journalPath)
      } else {
        await atomicReplace(strategyPath, oldSnapshot.content, committed.hash)
      }
      throw error
    }
    const postcondition = parseStrategyCatalog(await readFile(strategyPath, 'utf8'))
    if (postcondition.stableVersion !== current.stableVersion + 1 || JSON.stringify(postcondition.rules.slice(0, -1)) !== JSON.stringify(current.rules) || JSON.stringify(postcondition.rules.at(-1)) !== JSON.stringify(promotedRule)) {
      if (transactionSnapshots) {
        for (const snapshot of [...transactionSnapshots].reverse()) await restoreJournalSnapshot(journalSnapshot(snapshot))
        await unlink(journalPath)
      } else {
        await atomicReplace(strategyPath, oldSnapshot.content, committed.hash)
      }
      throw new Error('promotion postcondition failed')
    }
    if (transactionSnapshots) {
      const afterHashes = {
        [strategyPath]: (await snapshotRegularFile(strategyPath)).hash,
        [versionsPath]: (await snapshotRegularFile(versionsPath)).hash,
        [candidateStatePath]: (await snapshotRegularFile(candidateStatePath)).hash,
      }
      const prepared = JSON.parse(journalSnapshotState.content.toString('utf8'))
      prepared.phase = 'committed'
      prepared.afterHashes = afterHashes
      await atomicReplace(journalPath, `${JSON.stringify(prepared, null, 2)}\n`, journalSnapshotState.hash)
      await unlink(journalPath)
    }
    return { candidateId: candidate.id, stableVersion: postcondition.stableVersion, hash: committed.hash, backupPath }
  })
}
