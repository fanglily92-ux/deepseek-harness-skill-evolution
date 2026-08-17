import { createHash } from 'node:crypto'

function seal(mapping, nonce) {
  return createHash('sha256').update(JSON.stringify({ mapping, nonce })).digest('hex')
}

export function createBlindPair({ stableOutput, candidateOutput, nonce }) {
  if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('nonce is required')
  const candidateFirst = createHash('sha256').update(nonce).digest()[0] % 2 === 0
  const mapping = candidateFirst ? { A: 'candidate', B: 'stable' } : { A: 'stable', B: 'candidate' }
  const outputs = candidateFirst
    ? { A: structuredClone(candidateOutput), B: structuredClone(stableOutput) }
    : { A: structuredClone(stableOutput), B: structuredClone(candidateOutput) }
  return { outputs, mapping, sealedMappingHash: seal(mapping, nonce) }
}

export async function compareBlind({ rubric, outputs, judge }) {
  const verdict = await judge({ rubric: structuredClone(rubric), outputs: structuredClone(outputs) })
  if (!verdict || !['A', 'B', 'tie'].includes(verdict.winner)) throw new Error('blind judge returned an invalid winner')
  return structuredClone(verdict)
}

export function revealBlindVerdict({ verdict, mapping, nonce, sealedMappingHash }) {
  if (seal(mapping, nonce) !== sealedMappingHash) throw new Error('mapping seal mismatch')
  return { ...structuredClone(verdict), winner: verdict.winner === 'tie' ? 'tie' : mapping[verdict.winner] }
}
