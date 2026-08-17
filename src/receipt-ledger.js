import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

import { withExclusiveLock } from './atomic-files.js'
import { assertReceipt, SCHEMA_VERSION } from './contracts.js'
import { assertContainedPathNoSymlinks } from './paths.js'

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
  #root
  #path
  #tail = Promise.resolve()

  static async open(paths, { create = true } = {}) {
    if (!paths || typeof paths.receipts !== 'string') throw new TypeError('paths.receipts is required')
    const root = paths.workspace ?? dirname(paths.receipts)
    await assertContainedPathNoSymlinks(root, paths.receipts, { allowMissingLeaf: create })
    await mkdir(dirname(paths.receipts), { recursive: true })
    await assertContainedPathNoSymlinks(root, dirname(paths.receipts))
    const noFollow = constants.O_NOFOLLOW ?? 0
    const flags = create ? constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | noFollow : constants.O_RDONLY | noFollow
    const handle = await open(paths.receipts, flags, 0o600)
    await handle.close()
    return new ReceiptLedger(root, paths.receipts)
  }

  constructor(root, path) {
    this.#root = root
    this.#path = path
  }

  append(receipt) {
    const operation = this.#tail.then(async () => {
      assertReceipt(receipt)
      return withExclusiveLock(`${this.#path}.lock`, async () => {
        await assertContainedPathNoSymlinks(this.#root, this.#path)
        const handle = await open(this.#path, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
        try {
          const verified = await this.#verifyHandle(handle)
          const core = { schemaVersion: SCHEMA_VERSION, previousHash: verified.lastHash, payload: receipt }
          const hash = hashRow(core)
          await handle.appendFile(`${JSON.stringify({ ...core, hash })}\n`, 'utf8')
          await handle.sync()
          return hash
        } finally {
          await handle.close()
        }
      }, { waitMs: 2000 })
    })
    this.#tail = operation.catch(() => undefined)
    return operation
  }

  async verify() {
    await this.#tail
    return withExclusiveLock(`${this.#path}.lock`, async () => {
      await assertContainedPathNoSymlinks(this.#root, this.#path)
      const handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        return await this.#verifyHandle(handle)
      } finally {
        await handle.close()
      }
    }, { waitMs: 2000 })
  }

  async readPayloads() {
    await this.#tail
    return withExclusiveLock(`${this.#path}.lock`, async () => {
      await assertContainedPathNoSymlinks(this.#root, this.#path)
      const handle = await open(this.#path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const content = await handle.readFile('utf8')
        this.#verifyContent(content)
        return content.trimEnd() ? content.trimEnd().split('\n').map((line) => JSON.parse(line).payload) : []
      } finally {
        await handle.close()
      }
    }, { waitMs: 2000 })
  }

  async #verifyHandle(handle) {
    const content = await handle.readFile('utf8')
    return this.#verifyContent(content)
  }

  #verifyContent(content) {
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
    return { ok: true, count: lines.length, lastHash: previousHash }
  }

  async close() {
    await this.#tail
  }
}
