import { createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
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

export async function promoteCandidate({ candidate, validationReport, strategyPath, versionsPath, backupDirectory, now = Date.now }) {
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
    } catch (error) {
      await atomicReplace(strategyPath, oldSnapshot.content, committed.hash)
      throw error
    }
    const postcondition = parseStrategyCatalog(await readFile(strategyPath, 'utf8'))
    if (postcondition.stableVersion !== current.stableVersion + 1 || JSON.stringify(postcondition.rules.slice(0, -1)) !== JSON.stringify(current.rules) || JSON.stringify(postcondition.rules.at(-1)) !== JSON.stringify(promotedRule)) {
      await atomicReplace(strategyPath, oldSnapshot.content, committed.hash)
      throw new Error('promotion postcondition failed')
    }
    return { candidateId: candidate.id, stableVersion: postcondition.stableVersion, hash: committed.hash, backupPath }
  })
}
