import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRuntimeServices } from '../src/runtime.js'
import { ReceiptLedger } from '../src/receipt-ledger.js'
import { resolveWorkbenchPaths } from '../src/paths.js'

async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'evolution-runtime-')))
  const authorityRoot = await realpath(await mkdtemp(join(tmpdir(), 'evolution-authority-')))
  const strategyPath = join(authorityRoot, 'skills', 'optimize-work-strategy', 'references', 'strategies.yaml')
  await mkdir(join(strategyPath, '..'), { recursive: true })
  await writeFile(strategyPath, '{"schemaVersion":1,"stableVersion":0,"rules":[]}\n', { flag: 'wx' })
  const paths = resolveWorkbenchPaths(workspace, { authorityRoot })
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
  return { workspace, authorityRoot, paths, strategyPath, caseIds: cases.map(([id]) => id) }
}

function binding() {
  return {
    schemaVersion: 1,
    stableSkillHash: '1'.repeat(64), stableStrategiesHash: '2'.repeat(64),
    fixtureManifestHash: '3'.repeat(64), evaluationPolicyHash: '4'.repeat(64),
    evaluatorCodeHash: '5'.repeat(64), evaluatorVersion: 'golden-label-v1',
    fixtureIds: ['SUP-1', 'SUP-2', 'SUP-3', 'HOLD-1', 'HOLD-2'],
  }
}

function attachBinding(evaluator) {
  evaluator.prepareCandidateBinding = async () => binding()
  evaluator.verifyCandidateBinding = async () => true
  return evaluator
}

function completeEvaluationReport(candidate) {
  const row = (fixtureId, partition, trial) => ({
    fixtureId, partition, trial,
    stableCriticalPass: true, candidateCriticalPass: true,
    stablePrimary: partition === 'support' ? 1 : 0,
    candidatePrimary: 0,
  })
  return {
    status: 'complete', stage: 'full-validation',
    budget: {
      maxRuns: 30, actualRuns: 30, maxToolCalls: 120,
      maxOutputTokensPerArm: 32, maxPromptCharsPerArm: 8000,
      maxMeteredTokens: 100000, timeoutMs: 120000,
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, meteredTokens: 1100 },
      exhausted: false,
    },
    comparator: { disagreement: false }, allGoldenIncluded: true,
    binding: candidate.evaluationBinding,
    fixtureResults: [
      ...[1, 2, 3].flatMap((id) => [1, 2, 3].map((trial) => row(`SUP-${id}`, 'support', trial))),
      ...[1, 2].flatMap((id) => [1, 2, 3].map((trial) => row(`HOLD-${id}`, 'heldout', trial))),
    ],
  }
}

test('default runtime reviews independent evidence and creates an isolated candidate', async () => {
  const setup = await fixture()
  const services = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot, evaluator: attachBinding(async () => { throw new Error('not used') }), now: () => new Date('2026-08-18T00:00:00Z') })
  const review = await services.review({ case_ids: setup.caseIds })
  assert.equal(review.mechanism, 'UNCLEAR_APPROVAL')
  assert.equal(review.independentCaseCount, 3)

  const proposal = await services.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
  })
  assert.equal(proposal.candidateId, 'EVO-20260818-001')
  assert.equal(proposal.state, 'awaiting-validation')
  assert.equal(proposal.primaryMetric, 'golden-label-error-rate')
  const stable = JSON.parse(await readFile(setup.strategyPath, 'utf8'))
  assert.deepEqual(stable.rules, [])
})

test('default runtime validation fails closed when no paired evaluator is configured', async () => {
  const setup = await fixture()
  const unavailable = attachBinding(async () => { const error = new Error('unavailable'); error.code = 'EVALUATOR_UNAVAILABLE'; throw error })
  const services = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot, evaluator: unavailable, now: () => new Date('2026-08-18T00:00:00Z') })
  const proposal = await services.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
  })
  const validation = await services.validate({ candidate_id: proposal.candidateId })
  assert.equal(validation.status, 'inconclusive')
  assert.equal(validation.stableChanged, false)
  await assert.rejects(services.validate({ candidate_id: proposal.candidateId }), /not awaiting validation/)
  await assert.rejects(services.promote({ candidate_id: proposal.candidateId }), /awaiting approval/)
})

test('runtime promotes only a fully validated candidate and advances stable by one append', async () => {
  const setup = await fixture()
  const evaluator = attachBinding(async (candidate) => completeEvaluationReport(candidate))
  const services = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot, evaluator, now: () => new Date('2026-08-18T00:00:00Z') })
  const proposal = await services.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
  })
  const validation = await services.validate({ candidate_id: proposal.candidateId })
  assert.equal(validation.status, 'awaiting-approval')
  assert.equal(validation.approvalCard.candidateId, proposal.candidateId)
  assert.equal(validation.approvalCard.hashes.validationReport, validation.validationReportHash)
  assert.deepEqual(validation.approvalCard.evaluation.support, { count: 9, stableErrors: 9, candidateErrors: 0 })
  assert.deepEqual(validation.approvalCard.evaluation.heldout, { count: 6, stableErrors: 0, candidateErrors: 0 })
  assert.equal(validation.approvalCard.guardrails.strictSupportImprovement, true)
  assert.equal(validation.approvalCard.exactDiff.operation, 'append-one-rule')
  const status = await services.status()
  assert.equal(status.candidates[0].approvalCard.candidateId, proposal.candidateId)
  assert.match(status.projection[`候选方案/${proposal.candidateId}.md`], /人工审批证据/)
  const promotion = await services.promote({ candidate_id: proposal.candidateId })
  assert.equal(promotion.state, 'promoted')
  const stable = JSON.parse(await readFile(setup.strategyPath, 'utf8'))
  assert.equal(stable.stableVersion, 1)
  assert.equal(stable.rules.length, 1)
  assert.equal(stable.rules[0].status, 'stable')
  assert.equal(stable.rules[0].primaryMetric, 'golden-label-error-rate')
  assert.equal(stable.rules[0].baselineValue, 1)
  assert.equal(stable.rules[0].candidateValue, 0)
})

test('runtime rejects caller-selected metrics that are not bound to the evaluator', async () => {
  const setup = await fixture()
  const services = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot, evaluator: attachBinding(async () => {}) })
  await assert.rejects(services.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
    primary_metric: 'latency', baseline_value: 999,
  }), /primary metric is fixed by the evaluation policy/)
})

test('runtime blocks evolution when observer health is degraded', async () => {
  const setup = await fixture()
  const services = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot, observerHealth: { status: 'degraded', lastErrorCode: 'EIO' } })
  await assert.rejects(services.review({ case_ids: setup.caseIds }), /observer unavailable: EIO/)
})

test('runtime does not propose mechanisms without predeclared evaluation coverage', async () => {
  const setup = await fixture()
  const text = await readFile(setup.paths.receipts, 'utf8')
  const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line))
  for (const row of rows) row.payload.evidence.errorClass = 'REWORK'
  // Rebuild through the public ledger contract so hashes remain valid.
  await writeFile(setup.paths.receipts, '')
  await unlink(setup.paths.receiptAnchor)
  const ledger = await ReceiptLedger.open(setup.paths)
  for (const row of rows) await ledger.append(row.payload)
  await ledger.close()
  const services = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot })
  await assert.rejects(services.review({ case_ids: setup.caseIds }), /no predeclared evaluation coverage/)
})

test('runtime atomically claims one validation attempt across processes', async () => {
  const setup = await fixture()
  let evaluations = 0
  let release
  let entered
  const wait = new Promise((resolve) => { release = resolve })
  const evaluatorEntered = new Promise((resolve) => { entered = resolve })
  const evaluator = attachBinding(async (candidate) => {
    evaluations += 1
    entered()
    await wait
    return completeEvaluationReport(candidate)
  })
  const first = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot, evaluator, now: () => new Date('2026-08-18T00:00:00Z') })
  const second = createRuntimeServices({ workspace: setup.workspace, authorityRoot: setup.authorityRoot, evaluator, now: () => new Date('2026-08-18T00:00:00Z') })
  const proposal = await first.propose({
    mechanism: 'UNCLEAR_APPROVAL', case_ids: setup.caseIds, task_kinds: ['promotion'],
    action: 'Require an exact candidate identifier before promotion.',
    avoid: 'Do not interpret generic continuation language as approval.',
  })
  const running = first.validate({ candidate_id: proposal.candidateId })
  await evaluatorEntered
  await assert.rejects(second.validate({ candidate_id: proposal.candidateId }), /not awaiting validation/)
  release()
  await running
  assert.equal(evaluations, 1)
})

test('runtime refuses a symlinked workspace alias', async () => {
  const setup = await fixture()
  const aliasRoot = await realpath(await mkdtemp(join(tmpdir(), 'runtime-workspace-alias-')))
  const workspaceAlias = join(aliasRoot, 'workspace-alias')
  await symlink(setup.workspace, workspaceAlias)
  assert.throws(
    () => createRuntimeServices({ workspace: workspaceAlias, authorityRoot: setup.authorityRoot }),
    /workspace must not be a symlink or aliased path/,
  )
})
