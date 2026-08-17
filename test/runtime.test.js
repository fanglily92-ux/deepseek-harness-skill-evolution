import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntimeServices } from '../src/runtime.js'
import { ReceiptLedger } from '../src/receipt-ledger.js'
import { resolveWorkbenchPaths } from '../src/paths.js'

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'evolution-runtime-'))
  const strategyPath = join(workspace, '.dsh', 'skills', 'optimize-work-strategy', 'references', 'strategies.yaml')
  await mkdir(join(strategyPath, '..'), { recursive: true })
  await writeFile(strategyPath, '{"schemaVersion":1,"stableVersion":0,"rules":[]}\n', { flag: 'wx' })
  const paths = resolveWorkbenchPaths(workspace)
  const ledger = await ReceiptLedger.open(paths)
  const cases = [
    ['CASE-1111111111111111', 'a'.repeat(64), 1],
    ['CASE-2222222222222222', 'b'.repeat(64), 2],
    ['CASE-3333333333333333', 'c'.repeat(64), 3],
  ]
  for (const [caseId, sessionHash, turn] of cases) {
    await ledger.append({
      schemaVersion: 1, caseId, skillName: 'optimize-work-strategy', sessionHash, turn, outcome: 'failure',
      evidence: { errorClass: 'UNCLEAR_APPROVAL', userSignal: 'negative', toolCalls: 1, toolFailures: 0, validationCalls: 0, durationMs: 1, startSeq: 1, endSeq: 2 },
      createdAt: 1786924800000 + turn,
    })
  }
  await ledger.close()
  return { workspace, paths, strategyPath, caseIds: cases.map(([id]) => id) }
}

test('default runtime reviews independent evidence and creates an isolated candidate', async () => {
  const setup = await fixture()
  const services = createRuntimeServices({ workspace: setup.workspace, now: () => new Date('2026-08-18T00:00:00Z') })
  const review = await services.review({ case_ids: setup.caseIds })
  assert.equal(review.mechanism, 'UNCLEAR_APPROVAL')
  assert.equal(review.independentCaseCount, 3)

  const proposal = await services.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
    primary_metric: 'approval-misclassification-rate', baseline_value: 1,
  })
  assert.equal(proposal.candidateId, 'EVO-20260818-001')
  assert.equal(proposal.state, 'awaiting-validation')
  const stable = JSON.parse(await readFile(setup.strategyPath, 'utf8'))
  assert.deepEqual(stable.rules, [])
})

test('default runtime validation fails closed when no paired evaluator is configured', async () => {
  const setup = await fixture()
  const services = createRuntimeServices({ workspace: setup.workspace, now: () => new Date('2026-08-18T00:00:00Z') })
  const proposal = await services.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
    primary_metric: 'approval-misclassification-rate', baseline_value: 1,
  })
  const validation = await services.validate({ candidate_id: proposal.candidateId })
  assert.equal(validation.status, 'inconclusive')
  assert.equal(validation.stableChanged, false)
  await assert.rejects(services.validate({ candidate_id: proposal.candidateId }), /not awaiting validation/)
  await assert.rejects(services.promote({ candidate_id: proposal.candidateId }), /awaiting approval/)
})

test('runtime promotes only a fully validated candidate and advances stable by one append', async () => {
  const setup = await fixture()
  const evaluator = async (candidate) => ({
    status: 'complete', budget: { exhausted: false }, comparator: { disagreement: false }, allGoldenIncluded: true,
    binding: { candidateHash: candidate.candidateHash, baselineHash: candidate.baselineHash, fixtureManifestHash: 'c'.repeat(64), evaluatorVersion: 'golden-label-v1' },
    fixtureResults: [
      ...[1, 2, 3].map((id) => ({ fixtureId: `SUP-${id}`, partition: 'support', stableCriticalPass: true, candidateCriticalPass: true, stablePrimary: 1, candidatePrimary: 0 })),
      ...[1, 2].map((id) => ({ fixtureId: `HOLD-${id}`, partition: 'heldout', stableCriticalPass: true, candidateCriticalPass: true, stablePrimary: 0, candidatePrimary: 0 })),
    ],
  })
  const services = createRuntimeServices({ workspace: setup.workspace, evaluator, now: () => new Date('2026-08-18T00:00:00Z') })
  const proposal = await services.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
    primary_metric: 'approval-misclassification-rate', baseline_value: 1,
  })
  const validation = await services.validate({ candidate_id: proposal.candidateId })
  assert.equal(validation.status, 'awaiting-approval')
  const promotion = await services.promote({ candidate_id: proposal.candidateId })
  assert.equal(promotion.state, 'promoted')
  const stable = JSON.parse(await readFile(setup.strategyPath, 'utf8'))
  assert.equal(stable.stableVersion, 1)
  assert.equal(stable.rules.length, 1)
  assert.equal(stable.rules[0].status, 'stable')
})

test('runtime blocks evolution when observer health is degraded', async () => {
  const setup = await fixture()
  const services = createRuntimeServices({ workspace: setup.workspace, observerHealth: { status: 'degraded', lastErrorCode: 'EIO' } })
  await assert.rejects(services.review({ case_ids: setup.caseIds }), /observer unavailable: EIO/)
})

test('runtime does not propose mechanisms without predeclared evaluation coverage', async () => {
  const setup = await fixture()
  const text = await readFile(setup.paths.receipts, 'utf8')
  const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line))
  for (const row of rows) row.payload.evidence.errorClass = 'REWORK'
  // Rebuild through the public ledger contract so hashes remain valid.
  await writeFile(setup.paths.receipts, '')
  const ledger = await ReceiptLedger.open(setup.paths)
  for (const row of rows) await ledger.append(row.payload)
  await ledger.close()
  const services = createRuntimeServices({ workspace: setup.workspace })
  await assert.rejects(services.review({ case_ids: setup.caseIds }), /no predeclared evaluation coverage/)
})
