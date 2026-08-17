import test from 'node:test'
import assert from 'node:assert/strict'

import { hashCanonical } from '../src/integrity.js'

test('hashCanonical is stable across object key order and changes with proposal content', () => {
  assert.equal(hashCanonical({ b: 2, a: 1 }), hashCanonical({ a: 1, b: 2 }))
  assert.notEqual(hashCanonical({ action: 'A' }), hashCanonical({ action: 'B' }))
})
