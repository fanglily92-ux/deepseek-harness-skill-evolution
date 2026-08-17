import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ReceiptLedger } from '../src/receipt-ledger.js'

function receipt(number) {
  return {
    schemaVersion: 1,
    caseId: `CASE-${String(number).padStart(16, '0')}`,
    skillName: 'optimize-work-strategy',
    sessionHash: String(number).padStart(64, 'a'),
    turn: number,
    outcome: number % 2 === 0 ? 'success' : 'failure',
    evidence: {
      errorClass: number % 2 === 0 ? 'NONE' : 'REWORK',
      userSignal: number % 2 === 0 ? 'positive' : 'negative',
      toolCalls: number,
      toolFailures: 0,
      validationCalls: 1,
      durationMs: 100 + number,
      startSeq: number * 10,
      endSeq: number * 10 + 9,
    },
    createdAt: 1786924800000 + number,
  }
}

test('ReceiptLedger serializes concurrent appends into a valid hash chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-ledger-'))
  const path = join(root, 'receipts.jsonl')
  const ledger = await ReceiptLedger.open({ receipts: path })

  await Promise.all([ledger.append(receipt(1)), ledger.append(receipt(2)), ledger.append(receipt(3))])
  const result = await ledger.verify()
  await ledger.close()

  assert.equal(result.ok, true)
  assert.equal(result.count, 3)
  assert.match(result.lastHash, /^[a-f0-9]{64}$/)
})

test('two ReceiptLedger instances serialize appends through the filesystem lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-ledger-'))
  const paths = { workspace: root, receipts: join(root, 'receipts.jsonl') }
  const first = await ReceiptLedger.open(paths)
  const second = await ReceiptLedger.open(paths)
  await Promise.all([first.append(receipt(1)), second.append(receipt(2))])
  const result = await first.verify()
  await Promise.all([first.close(), second.close()])
  assert.equal(result.count, 2)
})

test('ReceiptLedger refuses a symlink leaf instead of writing through it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-ledger-'))
  const outside = join(await mkdtemp(join(tmpdir(), 'evolution-outside-')), 'outside.jsonl')
  await writeFile(outside, '')
  const receipts = join(root, 'receipts.jsonl')
  await symlink(outside, receipts)
  await assert.rejects(ReceiptLedger.open({ workspace: root, receipts }), /symlink|ELOOP/)
  assert.equal(await readFile(outside, 'utf8'), '')
})

test('ReceiptLedger detects corruption in the middle of the chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-ledger-'))
  const path = join(root, 'receipts.jsonl')
  const ledger = await ReceiptLedger.open({ receipts: path })
  await ledger.append(receipt(1))
  await ledger.append(receipt(2))
  await ledger.append(receipt(3))
  await ledger.close()

  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
  const second = JSON.parse(lines[1])
  second.payload.evidence.durationMs = 999999
  lines[1] = JSON.stringify(second)
  await writeFile(path, `${lines.join('\n')}\n`)

  const reopened = await ReceiptLedger.open({ receipts: path })
  await assert.rejects(reopened.verify(), /receipt hash chain mismatch at line 2/)
  await reopened.close()
})

test('ReceiptLedger refuses to append after opening a corrupted chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-ledger-'))
  const path = join(root, 'receipts.jsonl')
  const ledger = await ReceiptLedger.open({ receipts: path })
  await ledger.append(receipt(1))
  await ledger.close()

  const row = JSON.parse((await readFile(path, 'utf8')).trim())
  row.payload.evidence.durationMs = 999999
  await writeFile(path, `${JSON.stringify(row)}\n`)

  const reopened = await ReceiptLedger.open({ receipts: path })
  await assert.rejects(reopened.append(receipt(2)), /receipt hash chain mismatch at line 1/)
  assert.equal((await readFile(path, 'utf8')).trimEnd().split('\n').length, 1)
  await reopened.close()
})

test('ReceiptLedger anchor detects whole-chain truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolution-ledger-anchor-'))
  const paths = {
    authorityRoot: root,
    receipts: join(root, 'receipts.jsonl'),
    receiptAnchor: join(root, 'receipts.anchor.json'),
  }
  const ledger = await ReceiptLedger.open(paths)
  await ledger.append(receipt(1))
  await ledger.append(receipt(2))
  await ledger.close()

  await truncate(paths.receipts, 0)

  const reopened = await ReceiptLedger.open(paths)
  await assert.rejects(reopened.verify(), /anchor mismatch/)
  await reopened.close()
})
