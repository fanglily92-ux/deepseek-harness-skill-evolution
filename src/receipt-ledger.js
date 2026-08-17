import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { assertReceipt, SCHEMA_VERSION } from './contracts.js'

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashRow(rowWithoutHash) {
  return createHash('sha256').update(canonicalJson(rowWithoutHash)).digest('hex')
}

export class ReceiptLedger {
  #handle
  #path
  #tail = Promise.resolve()
  #lastHash = '0'.repeat(64)
  #integrityChecked = false

  static async open(paths) {
    if (!paths || typeof paths.receipts !== 'string') throw new TypeError('paths.receipts is required')
    await mkdir(dirname(paths.receipts), { recursive: true })
    const handle = await open(paths.receipts, 'a+')
    const ledger = new ReceiptLedger(paths.receipts, handle)
    const existing = await readFile(paths.receipts, 'utf8')
    const lines = existing.trimEnd() ? existing.trimEnd().split('\n') : []
    if (lines.length > 0) {
      const last = JSON.parse(lines.at(-1))
      if (typeof last.hash === 'string') ledger.#lastHash = last.hash
    }
    return ledger
  }

  constructor(path, handle) {
    this.#path = path
    this.#handle = handle
  }

  append(receipt) {
    const operation = this.#tail.then(async () => {
      if (!this.#integrityChecked) await this.#verifyFile()
      assertReceipt(receipt)
      const core = {
        schemaVersion: SCHEMA_VERSION,
        previousHash: this.#lastHash,
        payload: receipt,
      }
      const hash = hashRow(core)
      await this.#handle.appendFile(`${JSON.stringify({ ...core, hash })}\n`, 'utf8')
      await this.#handle.sync()
      this.#lastHash = hash
      return hash
    })
    this.#tail = operation.catch(() => undefined)
    return operation
  }

  async verify() {
    await this.#tail
    return this.#verifyFile()
  }

  async #verifyFile() {
    const content = await readFile(this.#path, 'utf8')
    const lines = content.trimEnd() ? content.trimEnd().split('\n') : []
    let previousHash = '0'.repeat(64)
    for (let index = 0; index < lines.length; index += 1) {
      let row
      try {
        row = JSON.parse(lines[index])
        assertReceipt(row.payload)
      } catch {
        throw new Error(`receipt hash chain mismatch at line ${index + 1}`)
      }
      const expected = hashRow({
        schemaVersion: row.schemaVersion,
        previousHash: row.previousHash,
        payload: row.payload,
      })
      if (row.schemaVersion !== SCHEMA_VERSION || row.previousHash !== previousHash || row.hash !== expected) {
        throw new Error(`receipt hash chain mismatch at line ${index + 1}`)
      }
      previousHash = row.hash
    }
    this.#integrityChecked = true
    this.#lastHash = previousHash
    return { ok: true, count: lines.length, lastHash: previousHash }
  }

  async close() {
    await this.#tail
    await this.#handle.close()
  }
}
