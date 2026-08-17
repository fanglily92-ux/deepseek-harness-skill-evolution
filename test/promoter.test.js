import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashCatalog, promoteCandidate } from '../src/promoter.js'
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
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportCandidate: 0, supportCount: 3 } }
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
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportCandidate: 0, supportCount: 3 } }
  const candidate = { id: validationReport.candidateId, state: 'awaiting-approval', baselineHash: validationReport.baselineHash, validationReportHash: validationReport.reportHash, proposedRule: proposedRule(), candidateHash: hashCandidateProposal(proposedRule()) }

  await assert.rejects(promoteCandidate({ ...paths, candidate, validationReport, now: () => 1 }))
  assert.deepEqual(JSON.parse(await readFile(paths.strategyPath, 'utf8')), paths.catalog)
})

test('promoteCandidate rejects a proposal changed after validation', async () => {
  const paths = await setup()
  const original = proposedRule()
  const validationReport = { pass: true, candidateId: 'EVO-20260817-001', baselineHash: hashCatalog(paths.catalog), reportHash: 'c'.repeat(64), scorecard: { supportCandidate: 0, supportCount: 3 } }
  const candidate = { id: validationReport.candidateId, state: 'awaiting-approval', baselineHash: validationReport.baselineHash, validationReportHash: validationReport.reportHash, proposedRule: { ...original, action: 'Changed after validation.' }, candidateHash: hashCandidateProposal(original) }
  await assert.rejects(promoteCandidate({ ...paths, candidate, validationReport }), /candidate content hash mismatch/)
  assert.deepEqual(JSON.parse(await readFile(paths.strategyPath, 'utf8')), paths.catalog)
})
