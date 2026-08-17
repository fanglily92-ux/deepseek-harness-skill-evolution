import test from 'node:test'
import assert from 'node:assert/strict'

import { createBlindPair, compareBlind, revealBlindVerdict } from '../src/blind-comparator.js'

test('blind comparison hides source labels until after a sealed verdict', async () => {
  const pair = createBlindPair({ stableOutput: { score: 2 }, candidateOutput: { score: 1 }, nonce: 'nonce-001' })
  let judgeInput
  const verdict = await compareBlind({
    rubric: { lowerScoreWins: true },
    outputs: pair.outputs,
    judge: async (input) => {
      judgeInput = input
      return { winner: input.outputs.A.score < input.outputs.B.score ? 'A' : 'B', confidence: 1 }
    },
  })

  assert.equal('mapping' in judgeInput, false)
  assert.equal(JSON.stringify(judgeInput).includes('stable'), false)
  assert.equal(JSON.stringify(judgeInput).includes('candidate'), false)
  const revealed = revealBlindVerdict({ verdict, mapping: pair.mapping, nonce: 'nonce-001', sealedMappingHash: pair.sealedMappingHash })
  assert.equal(revealed.winner, 'candidate')
})

test('revealBlindVerdict rejects a mapping that does not match the precommitted seal', () => {
  const pair = createBlindPair({ stableOutput: { score: 2 }, candidateOutput: { score: 1 }, nonce: 'nonce-001' })
  assert.throws(
    () => revealBlindVerdict({ verdict: { winner: 'A' }, mapping: { A: 'stable', B: 'candidate' }, nonce: 'different', sealedMappingHash: pair.sealedMappingHash }),
    /mapping seal mismatch/,
  )
})
