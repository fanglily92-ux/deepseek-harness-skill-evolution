import { createHash } from 'node:crypto'

import { createCaseId } from './contracts.js'
import { classifyDirectUserSignal } from './redaction.js'

function sessionDigest(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex')
}

function validationTool(name) {
  return name === 'bash' || name === 'read_file' || name === 'read_video' || name.endsWith('doctor') || name.endsWith('validate')
}

export function createEventObserver({ ledger, whitelist, now = Date.now }) {
  if (!ledger || typeof ledger.append !== 'function') throw new TypeError('ledger.append is required')
  if (!(whitelist instanceof Set)) throw new TypeError('whitelist must be a Set')
  const turns = new Map()

  async function observe(session, event) {
    try {
      const turn = event?.data?.turn
      if (typeof session?.id !== 'string' || !Number.isInteger(turn)) return
      const sessionHash = sessionDigest(session.id)
      const key = `${sessionHash}:${turn}`
      let state = turns.get(key)
      if (!state) {
        state = {
          sessionHash,
          turn,
          skillName: null,
          active: false,
          userSignal: 'none',
          toolCalls: 0,
          toolFailures: 0,
          validationCalls: 0,
          calls: new Map(),
          startSeq: event.seq,
          startTime: event.time,
          endSeq: event.seq,
        }
        turns.set(key, state)
      }
      state.endSeq = event.seq

      if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
        state.userSignal = classifyDirectUserSignal(event.data.content)
      } else if (event.type === 'tool/call' && event.data?.name === 'skill') {
        let requested
        try {
          requested = JSON.parse(event.data.arguments)
        } catch {
          requested = null
        }
        if (requested && typeof requested.name === 'string' && whitelist.has(requested.name)) {
          state.active = true
          state.skillName = requested.name
        }
      } else if (event.type === 'tool/call' && state.active) {
        const name = typeof event.data?.name === 'string' ? event.data.name : ''
        state.calls.set(event.data.callId, name)
        state.toolCalls += 1
        if (validationTool(name)) state.validationCalls += 1
      } else if (event.type === 'tool/result' && state.active && state.calls.has(event.data?.callId)) {
        if (event.data?.isError === true) state.toolFailures += 1
        state.calls.delete(event.data.callId)
      } else if (event.type === 'turn/end') {
        turns.delete(key)
        if (!state.active) return
        const failed = state.userSignal === 'negative' || state.toolFailures > 0
        await ledger.append({
          schemaVersion: 1,
          caseId: createCaseId(session.id, turn, state.skillName),
          skillName: state.skillName,
          sessionHash: state.sessionHash,
          turn,
          outcome: failed ? 'failure' : 'success',
          evidence: {
            errorClass: state.userSignal === 'negative' ? 'REWORK' : state.toolFailures > 0 ? 'TOOL_FAILURE' : 'NONE',
            userSignal: state.userSignal,
            toolCalls: state.toolCalls,
            toolFailures: state.toolFailures,
            validationCalls: state.validationCalls,
            durationMs: Math.max(0, Number(event.time) - Number(state.startTime)),
            startSeq: state.startSeq,
            endSeq: state.endSeq,
          },
          createdAt: now(),
        })
      }
      observe.health = { ok: true, lastError: null }
    } catch (error) {
      observe.health = { ok: false, lastError: error instanceof Error ? error.name : 'UnknownError' }
    }
  }

  observe.health = { ok: true, lastError: null }
  return observe
}
