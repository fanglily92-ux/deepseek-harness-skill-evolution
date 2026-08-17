import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
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
  #anchorPath
  #tail = Promise.resolve()

  static async open(paths, { create = true } = {}) {
    if (!paths || typeof paths.receipts !== 'string') throw new TypeError('paths.receipts is required')
    const root = paths.authorityRoot ?? paths.workspace ?? dirname(paths.receipts)
    const anchorPath = paths.receiptAnchor ?? `${paths.receipts}.anchor.json`
    await assertContainedPathNoSymlinks(root, paths.receipts, { allowMissingLeaf: create })
    await assertContainedPathNoSymlinks(root, anchorPath, { allowMissingLeaf: create })
    await mkdir(dirname(paths.receipts), { recursive: true })
    await assertContainedPathNoSymlinks(root, dirname(paths.receipts))
    const noFollow = constants.O_NOFOLLOW ?? 0
    const flags = create ? constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | noFollow : constants.O_RDONLY | noFollow
    const handle = await open(paths.receipts, flags, 0o600)
    await handle.close()
    if (create) {
      try {
        await writeFile(anchorPath, `${JSON.stringify({ schemaVersion: 1, count: 0, lastHash: '0'.repeat(64) })}\n`, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    return new ReceiptLedger(root, paths.receipts, anchorPath)
  }

  constructor(root, path, anchorPath) {
    this.#root = root
    this.#path = path
    this.#anchorPath = anchorPath
  }

  async #readAnchor() {
    await assertContainedPathNoSymlinks(this.#root, this.#anchorPath)
    const anchor = JSON.parse(await readFile(this.#anchorPath, 'utf8'))
    if (anchor?.schemaVersion !== 1 || !Number.isInteger(anchor.count) || anchor.count < 0 || !/^[a-f0-9]{64}$/.test(anchor.lastHash ?? '')) throw new Error('invalid receipt anchor')
    return anchor
  }

  async #verifyAnchor(verified) {
    const anchor = await this.#readAnchor()
    if (anchor.count !== verified.count || anchor.lastHash !== verified.lastHash) throw new Error('receipt anchor mismatch')
  }

  async #writeAnchor(previous, next) {
    const handle = await open(this.#anchorPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const current = JSON.parse(await handle.readFile('utf8'))
      if (current.count !== previous.count || current.lastHash !== previous.lastHash) throw new Error('receipt anchor changed during append')
      await handle.truncate(0)
      await handle.write(`${JSON.stringify({ schemaVersion: 1, count: next.count, lastHash: next.lastHash })}\n`, 0, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  append(receipt) {
    const operation = this.#tail.then(async () => {
      assertReceipt(receipt)
      return withExclusiveLock(`${this.#path}.lock`, async () => {
        await assertContainedPathNoSymlinks(this.#root, this.#path)
        const handle = await open(this.#path, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
        try {
          const verified = await this.#verifyHandle(handle)
          await this.#verifyAnchor(verified)
          const core = { schemaVersion: SCHEMA_VERSION, previousHash: verified.lastHash, payload: receipt }
          const hash = hashRow(core)
          await handle.appendFile(`${JSON.stringify({ ...core, hash })}\n`, 'utf8')
          await handle.sync()
          await this.#writeAnchor(verified, { count: verified.count + 1, lastHash: hash })
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
        const verified = await this.#verifyHandle(handle)
        await this.#verifyAnchor(verified)
        return verified
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
        const verified = this.#verifyContent(content)
        await this.#verifyAnchor(verified)
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
