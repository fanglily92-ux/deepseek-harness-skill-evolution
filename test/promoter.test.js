import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashCatalog, promoteCandidate, recoverPromotionJournal } from '../src/promoter.js'
import { hashCandidateProposal } from '../src/integrity.js'

function proposedRule() {
  return {
    id: 'STR-0001', status: 'candidate',
    appliesWhen: { taskKinds: ['skill-review'], failureMechanisms: ['unclear-approval'] },
    action: 'Require an exact candidate identifier.',
    avoid: 'Treating general agreement as promotion approval.',
    evidenceCaseIds: ['CASE-0123456789abcdef', 'CASE-1123456789abcdef', 'CASE-2123456789abcdef'],
    primaryMetric: 'approval-ambiguity-count', baselineValue: 2, candidateValue: 0,
    introducedBy: 'EVO-20260817-001',
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-promote-'))
  const strategyPath = join(root, 'strategies.yaml')
  const versionsPath = join(root, 'versions.jsonl')
  const backupDirectory = join(root, 'backups')
  const catalog = { schemaVersion: 1, stableVersion: 0, rules: [] }
  await writeFile(strategyPath, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' })
  return { root, strategyPath, versionsPath, backupDirectory, catalog }
}

test('promoteCandidate atomically appends one stable rule, backup, and version row', async () => {
  const paths = await setup()
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportStable: 6, supportCandidate: 0, supportCount: 3 } }
  const candidate = {
    id: 'EVO-20260817-001', state: 'awaiting-approval', baselineHash: hashCatalog(paths.catalog),
    validationReportHash: validationReport.reportHash, proposedRule: proposedRule(), candidateHash: hashCandidateProposal(proposedRule()),
  }

  const result = await promoteCandidate({ ...paths, candidate, validationReport, now: () => 1786924800000 })
  const promoted = JSON.parse(await readFile(paths.strategyPath, 'utf8'))

  assert.equal(promoted.stableVersion, 1)
  assert.equal(promoted.rules[0].status, 'stable')
  assert.equal(result.candidateId, candidate.id)
  assert.equal((await readFile(paths.versionsPath, 'utf8')).trimEnd().split('\n').length, 1)
  await stat(result.backupPath)
})

test('promoteCandidate rejects a stale validation hash before writing', async () => {
  const paths = await setup()
  const candidate = { id: 'EVO-20260817-001', state: 'awaiting-approval', baselineHash: hashCatalog(paths.catalog), validationReportHash: 'a'.repeat(64), proposedRule: proposedRule(), candidateHash: hashCandidateProposal(proposedRule()) }
  const validationReport = { pass: true, candidateId: candidate.id, baselineHash: candidate.baselineHash, reportHash: 'b'.repeat(64) }

  await assert.rejects(promoteCandidate({ ...paths, candidate, validationReport, now: () => 1 }), /validation report hash mismatch/)
  assert.deepEqual(JSON.parse(await readFile(paths.strategyPath, 'utf8')), paths.catalog)
})

test('promoteCandidate restores the old catalog if the version ledger cannot commit', async () => {
  const paths = await setup()
  await mkdir(paths.versionsPath)
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportStable: 6, supportCandidate: 0, supportCount: 3 } }
  const candidate = { id: validationReport.candidateId, state: 'awaiting-approval', baselineHash: validationReport.baselineHash, validationReportHash: validationReport.reportHash, proposedRule: proposedRule(), candidateHash: hashCandidateProposal(proposedRule()) }

  await assert.rejects(promoteCandidate({ ...paths, candidate, validationReport, now: () => 1 }))
  assert.deepEqual(JSON.parse(await readFile(paths.strategyPath, 'utf8')), paths.catalog)
})

test('promoteCandidate rejects a proposal changed after validation', async () => {
  const paths = await setup()
  const original = proposedRule()
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportStable: 6, supportCandidate: 0, supportCount: 3 } }
  const candidate = { id: validationReport.candidateId, state: 'awaiting-approval', baselineHash: validationReport.baselineHash, validationReportHash: validationReport.reportHash, proposedRule: { ...original, action: 'Changed after validation.' }, candidateHash: hashCandidateProposal(original) }
  await assert.rejects(promoteCandidate({ ...paths, candidate, validationReport }), /candidate content hash mismatch/)
  assert.deepEqual(JSON.parse(await readFile(paths.strategyPath, 'utf8')), paths.catalog)
})

test('promoteCandidate rejects measured baseline values not bound to the validation scorecard', async () => {
  const paths = await setup()
  const original = proposedRule()
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportStable: 3, supportCandidate: 0, supportCount: 3 } }
  const candidate = { id: validationReport.candidateId, state: 'awaiting-approval', baselineHash: validationReport.baselineHash, validationReportHash: validationReport.reportHash, proposedRule: { ...original, baselineValue: 99 }, candidateHash: hashCandidateProposal(original) }
  await assert.rejects(promoteCandidate({ ...paths, candidate, validationReport }), /baseline metric is not bound/)
})

test('promotion journal recovers catalog, versions, and candidate state after a simulated crash', async () => {
  const paths = await setup()
  await writeFile(paths.versionsPath, '')
  const candidateStatePath = join(paths.root, 'candidates.json')
  const journalPath = join(paths.root, 'promotion.journal.json')
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportStable: 6, supportCandidate: 0, supportCount: 3 } }
  const candidate = { id: validationReport.candidateId, state: 'awaiting-approval', baselineHash: validationReport.baselineHash, validationReportHash: validationReport.reportHash, proposedRule: proposedRule(), candidateHash: hashCandidateProposal(proposedRule()) }
  await writeFile(candidateStatePath, `${JSON.stringify({ schemaVersion: 1, candidates: [candidate] }, null, 2)}\n`)

  await assert.rejects(promoteCandidate({
    ...paths, candidate, validationReport, candidateStatePath, journalPath,
    faultAfter: 'version-appended', simulateCrash: true,
  }), /simulated promotion crash/)

  await recoverPromotionJournal({
    journalPath,
    expectedPaths: [paths.strategyPath, paths.versionsPath, candidateStatePath],
    expectedLockPaths: [`${candidateStatePath}.lock`, `${paths.strategyPath}.lock`],
    force: true,
  })
  assert.deepEqual(JSON.parse(await readFile(paths.strategyPath, 'utf8')), paths.catalog)
  assert.equal(await readFile(paths.versionsPath, 'utf8'), '')
  assert.equal(JSON.parse(await readFile(candidateStatePath, 'utf8')).candidates[0].state, 'awaiting-approval')
  await assert.rejects(readFile(journalPath), /ENOENT/)
})

test('promoteCandidate acquires the candidate-state lock before changing any transaction file', async () => {
  const paths = await setup()
  await writeFile(paths.versionsPath, '')
  const candidateStatePath = join(paths.root, 'candidates.json')
  const journalPath = join(paths.root, 'promotion.journal.json')
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportStable: 6, supportCandidate: 0, supportCount: 3 } }
  const candidate = { id: validationReport.candidateId, state: 'awaiting-approval', baselineHash: validationReport.baselineHash, validationReportHash: validationReport.reportHash, proposedRule: proposedRule(), candidateHash: hashCandidateProposal(proposedRule()) }
  const originalState = `${JSON.stringify({ schemaVersion: 1, candidates: [candidate] }, null, 2)}\n`
  await writeFile(candidateStatePath, originalState)
  await writeFile(`${candidateStatePath}.lock`, `${process.pid}\n`)

  await assert.rejects(promoteCandidate({
    ...paths, candidate, validationReport, candidateStatePath, journalPath,
  }), /lock already exists/)

  assert.deepEqual(JSON.parse(await readFile(paths.strategyPath, 'utf8')), paths.catalog)
  assert.equal(await readFile(paths.versionsPath, 'utf8'), '')
  assert.equal(await readFile(candidateStatePath, 'utf8'), originalState)
  await assert.rejects(readFile(journalPath), /ENOENT/)
})

test('committed journal recovery refuses to clean up a live promotion', async () => {
  const paths = await setup()
  await writeFile(paths.versionsPath, '')
  const candidateStatePath = join(paths.root, 'candidates.json')
  await writeFile(candidateStatePath, '{"schemaVersion":1,"candidates":[]}\n')
  const snapshots = await Promise.all([paths.strategyPath, paths.versionsPath, candidateStatePath].map(async (path) => {
    const content = await readFile(path)
    return { path, hash: (await import('../src/atomic-files.js')).sha256(content), contentBase64: content.toString('base64') }
  }))
  const lockPaths = [`${candidateStatePath}.lock`, `${paths.strategyPath}.lock`]
  for (const path of lockPaths) await writeFile(path, `${process.pid}\n`)
  const journalPath = join(paths.root, 'promotion.journal.json')
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 2, phase: 'committed', pid: process.pid, lockPaths, snapshots,
    afterHashes: Object.fromEntries(snapshots.map((snapshot) => [snapshot.path, snapshot.hash])),
  })}\n`)

  await assert.rejects(recoverPromotionJournal({
    journalPath,
    expectedPaths: snapshots.map((snapshot) => snapshot.path),
    expectedLockPaths: lockPaths,
  }), /promotion transaction is still active/)
  await readFile(journalPath)
  for (const path of lockPaths) await readFile(path)
})

test('journal recovery clears only dead orphan promotion locks when no journal exists', async () => {
  const paths = await setup()
  const candidateStatePath = join(paths.root, 'candidates.json')
  const lockPaths = [`${candidateStatePath}.lock`, `${paths.strategyPath}.lock`]
  const deadPid = 2147483647
  await writeFile(lockPaths[0], `${deadPid}\n`)

  const result = await recoverPromotionJournal({
    journalPath: join(paths.root, 'promotion.journal.json'),
    expectedPaths: [paths.strategyPath, paths.versionsPath, candidateStatePath],
    expectedLockPaths: lockPaths,
  })

  assert.deepEqual(result, { recovered: true, action: 'cleared-orphan-locks' })
  await assert.rejects(readFile(lockPaths[0]), /ENOENT/)
})
