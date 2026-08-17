import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { atomicReplace, snapshotRegularFile, withExclusiveLock } from './atomic-files.js'
import { buildCandidate, buildPattern } from './candidate-builder.js'
import { parseStrategyCatalog, appendCandidateRule } from './strategy-rules.js'
import { hashCatalog, promoteCandidate } from './promoter.js'
import { ReceiptLedger } from './receipt-ledger.js'
import { assertContainedPathNoSymlinks, resolveWorkbenchPaths } from './paths.js'
import { validateCandidate } from './validator.js'
import { EVOLVABLE_FAILURE_MECHANISMS } from './contracts.js'

function currentDate(now) {
  const value = now()
  return value instanceof Date ? value : new Date(value)
}

async function ensureFile(root, path, initial) {
  await assertContainedPathNoSymlinks(root, path, { allowMissingLeaf: true })
  await mkdir(dirname(path), { recursive: true })
  await assertContainedPathNoSymlinks(root, dirname(path))
  try {
    await writeFile(path, initial, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

async function readCandidateState(root, path) {
  await ensureFile(root, path, '{"schemaVersion":1,"candidates":[]}\n')
  const state = JSON.parse(await readFile(path, 'utf8'))
  if (state?.schemaVersion !== 1 || !Array.isArray(state.candidates)) throw new Error('invalid candidate state')
  return state
}

async function readCandidateStateOnly(root, path) {
  await assertContainedPathNoSymlinks(root, path, { allowMissingLeaf: true })
  try {
    const state = JSON.parse(await readFile(path, 'utf8'))
    if (state?.schemaVersion !== 1 || !Array.isArray(state.candidates)) throw new Error('invalid candidate state')
    return state
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, candidates: [] }
    throw error
  }
}

async function updateCandidateState(root, path, mutate) {
  await ensureFile(root, path, '{"schemaVersion":1,"candidates":[]}\n')
  return withExclusiveLock(`${path}.lock`, async () => {
    const snapshot = await snapshotRegularFile(path)
    const current = JSON.parse(snapshot.content.toString('utf8'))
    if (current?.schemaVersion !== 1 || !Array.isArray(current.candidates)) throw new Error('invalid candidate state')
    const next = await mutate(structuredClone(current))
    await atomicReplace(path, `${JSON.stringify(next, null, 2)}\n`, snapshot.hash)
    return next
  })
}

async function loadReceipts(paths) {
  const ledger = await ReceiptLedger.open(paths, { create: false })
  try {
    return await ledger.readPayloads()
  } finally {
    await ledger.close()
  }
}

async function reviewCases(paths, caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length < 3 || new Set(caseIds).size !== caseIds.length) {
    throw new Error('review requires three independent case ids')
  }
  const wanted = new Set(caseIds)
  const selected = (await loadReceipts(paths)).filter((receipt) => wanted.has(receipt.caseId))
  if (selected.length !== wanted.size) throw new Error('one or more case ids are missing from the verified ledger')
  if (selected.some((receipt) => receipt.outcome !== 'failure')) throw new Error('support cases must be failures')
  if (new Set(selected.map((receipt) => receipt.skillName)).size !== 1) throw new Error('support cases must concern one Skill')
  if (new Set(selected.map((receipt) => receipt.sessionHash)).size !== selected.length) throw new Error('support cases must come from independent sessions')
  if (new Set(selected.map((receipt) => receipt.evidence.errorClass)).size !== 1) throw new Error('support cases must share one failure mechanism')
  if (!EVOLVABLE_FAILURE_MECHANISMS.includes(selected[0].evidence.errorClass)) throw new Error('failure mechanism has no predeclared evaluation coverage')
  return selected
}

function nextRuleId(catalog, candidates) {
  const values = [...catalog.rules, ...candidates.map((candidate) => candidate.proposedRule)]
    .map((rule) => Number.parseInt(String(rule?.id ?? '').slice(4), 10))
    .filter(Number.isInteger)
  return `STR-${String((values.length ? Math.max(...values) : 0) + 1).padStart(4, '0')}`
}

function findCandidate(state, candidateId) {
  const candidate = state.candidates.find((item) => item.id === candidateId)
  if (!candidate) throw new Error(`candidate not found: ${candidateId}`)
  return candidate
}

export function createRuntimeServices({ workspace, evaluator, now = Date.now, observerHealth = { status: 'healthy' } }) {
  const paths = resolveWorkbenchPaths(workspace)
  const strategyPath = join(workspace, '.dsh', 'skills', 'optimize-work-strategy', 'references', 'strategies.yaml')
  const backupDirectory = join(workspace, 'logs', 'DeepSeek-Harness自进化', 'state', 'backups')

  function assertObserverHealthy() {
    if (observerHealth.status !== 'healthy') throw new Error(`feedback observer unavailable: ${observerHealth.lastErrorCode ?? observerHealth.status}`)
  }

  async function assertAuthorityPaths() {
    for (const target of [paths.receipts, paths.candidates, paths.versions, strategyPath, backupDirectory]) {
      await assertContainedPathNoSymlinks(workspace, target, { allowMissingLeaf: true })
    }
  }

  return {
    async status() {
      await assertAuthorityPaths()
      let ledgerHealth = { ok: true, count: 0, lastHash: '0'.repeat(64) }
      try {
        const ledger = await ReceiptLedger.open(paths, { create: false })
        try { ledgerHealth = await ledger.verify() } finally { await ledger.close() }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      const catalog = parseStrategyCatalog(await readFile(strategyPath, 'utf8'))
      const state = await readCandidateStateOnly(workspace, paths.candidates)
      return {
        health: observerHealth.status,
        observer: { status: observerHealth.status, lastErrorCode: observerHealth.lastErrorCode ?? null, lastSuccessSeq: observerHealth.lastSuccessSeq ?? null },
        stableVersion: catalog.stableVersion,
        stableHash: hashCatalog(catalog),
        receiptCount: ledgerHealth.count,
        candidates: state.candidates.map(({ id, state: candidateState }) => ({ id, state: candidateState })),
      }
    },

    async review({ case_ids: caseIds }) {
      assertObserverHealthy()
      const cases = await reviewCases(paths, caseIds)
      return {
        skillName: cases[0].skillName,
        mechanism: cases[0].evidence.errorClass,
        independentCaseCount: cases.length,
        caseIds: cases.map((receipt) => receipt.caseId),
        proposalAllowed: true,
      }
    },

    async propose(args) {
      assertObserverHealthy()
      const cases = await reviewCases(paths, args.case_ids)
      const mechanism = cases[0].evidence.errorClass
      if (args.mechanism !== mechanism) throw new Error('proposed mechanism does not match reviewed evidence')
      if (!Number.isFinite(args.baseline_value) || args.baseline_value < 0) throw new Error('baseline_value must be a non-negative finite number')
      const catalog = parseStrategyCatalog(await readFile(strategyPath, 'utf8'))
      const existing = await readCandidateState(workspace, paths.candidates)
      const date = currentDate(now)
      const stamp = date.toISOString().slice(0, 10).replaceAll('-', '')
      const sequence = existing.candidates.filter((candidate) => candidate.id.startsWith(`EVO-${stamp}-`)).length + 1
      const candidateId = `EVO-${stamp}-${String(sequence).padStart(3, '0')}`
      const proposedRule = {
        id: nextRuleId(catalog, existing.candidates),
        status: 'candidate',
        appliesWhen: { taskKinds: args.task_kinds, failureMechanisms: [mechanism] },
        action: args.action,
        avoid: args.avoid,
        evidenceCaseIds: [...args.case_ids],
        primaryMetric: args.primary_metric,
        baselineValue: args.baseline_value,
        candidateValue: args.baseline_value,
        introducedBy: candidateId,
      }
      appendCandidateRule(catalog, proposedRule)
      const pattern = buildPattern({ skillName: cases[0].skillName, mechanism, caseIds: args.case_ids, proposedRule })
      const candidate = buildCandidate({ pattern, baselineCatalog: catalog, date, sequence })
      await updateCandidateState(workspace, paths.candidates, (state) => {
        if (state.candidates.some((item) => item.id === candidate.id)) throw new Error('candidate id already exists')
        state.candidates.push(candidate)
        return state
      })
      return { candidateId: candidate.id, state: candidate.state, stableChanged: false, baselineHash: candidate.baselineHash }
    },

    async validate({ candidate_id: candidateId }, exec) {
      assertObserverHealthy()
      const state = await readCandidateState(workspace, paths.candidates)
      const candidate = findCandidate(state, candidateId)
      if (candidate.state !== 'awaiting-validation') throw new Error('candidate is not awaiting validation')
      if (typeof evaluator !== 'function') {
        await updateCandidateState(workspace, paths.candidates, (next) => { const target = findCandidate(next, candidateId); target.validationAttempts += 1; target.state = 'rejected'; return next })
        return { candidateId, status: 'inconclusive', reason: 'paired evaluator unavailable', stableChanged: false }
      }
      let evaluationReport
      try {
        evaluationReport = await evaluator(structuredClone(candidate), exec)
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? error.code : 'EVALUATION_ERROR'
        await updateCandidateState(workspace, paths.candidates, (next) => { const target = findCandidate(next, candidateId); target.validationAttempts += 1; target.state = 'rejected'; return next })
        return { candidateId, status: 'inconclusive', reason: code, stableChanged: false }
      }
      const validation = validateCandidate({ candidateId, baselineHash: candidate.baselineHash, candidateHash: candidate.candidateHash, evaluationReport })
      if (!validation.pass) {
        await updateCandidateState(workspace, paths.candidates, (next) => { const target = findCandidate(next, candidateId); target.validationAttempts += 1; target.state = 'rejected'; return next })
        return { candidateId, status: 'rejected', reason: validation.reason, stableChanged: false }
      }
      const support = evaluationReport.fixtureResults.filter((result) => result.partition === 'support')
      await updateCandidateState(workspace, paths.candidates, (next) => {
        const target = findCandidate(next, candidateId)
        if (target.state !== 'awaiting-validation') throw new Error('candidate state changed during validation')
        target.state = 'awaiting-approval'
        target.validationAttempts += 1
        target.proposedRule.candidateValue = validation.scorecard.supportCandidate / validation.scorecard.supportCount
        target.validationReportHash = validation.reportHash
        target.validationReport = validation
        return next
      })
      return { candidateId, status: 'awaiting-approval', validationReportHash: validation.reportHash, stableChanged: false }
    },

    async promote({ candidate_id: candidateId }) {
      assertObserverHealthy()
      await assertAuthorityPaths()
      await loadReceipts(paths)
      const state = await readCandidateState(workspace, paths.candidates)
      const candidate = findCandidate(state, candidateId)
      if (candidate.state !== 'awaiting-approval') throw new Error('candidate is not awaiting approval')
      await ensureFile(workspace, paths.versions, '')
      const result = await promoteCandidate({
        candidate,
        validationReport: candidate.validationReport,
        strategyPath,
        versionsPath: paths.versions,
        backupDirectory,
        now: () => currentDate(now).getTime(),
      })
      await updateCandidateState(workspace, paths.candidates, (next) => {
        findCandidate(next, candidateId).state = 'promoted'
        return next
      })
      return { ...result, state: 'promoted' }
    },
  }
}
