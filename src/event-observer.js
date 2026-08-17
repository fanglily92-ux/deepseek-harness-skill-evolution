import { createHash } from 'node:crypto'

import { createCaseId } from './contracts.js'
import { classifyDirectUserSignal, classifyPromotionApproval } from './redaction.js'

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
  const openTurns = new Map()
  const pendingSkills = new Map()

  async function observe(session, event) {
    try {
      if (typeof session?.id !== 'string') return
      const sessionHash = sessionDigest(session.id)
      if (event?.type === 'turn/start' && Number.isInteger(event.data?.turn)) {
        openTurns.set(sessionHash, event.data.turn)
      }
      const turn = Number.isInteger(event?.data?.turn) ? event.data.turn : openTurns.get(sessionHash)
      if (!Number.isInteger(turn)) return
      const key = `${sessionHash}:${turn}`
      let state = turns.get(key)
      if (!state) {
        state = {
          sessionHash,
          turn,
          skillName: null,
          active: false,
          userSignal: 'none',
          promotionApproval: 'none',
          promotionAttempted: false,
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
        state.promotionApproval = classifyPromotionApproval(event.data.content)
      } else if (event.type === 'tool/call' && event.data?.name === 'skill') {
        let requested
        try {
          requested = JSON.parse(event.data.arguments)
        } catch {
          requested = null
        }
        if (requested && typeof requested.name === 'string' && whitelist.has(requested.name)) pendingSkills.set(event.data.callId, requested.name)
      } else if (event.type === 'tool/call' && state.active) {
        const name = typeof event.data?.name === 'string' ? event.data.name : ''
        if (name === 'evolution_promote') state.promotionAttempted = true
        state.calls.set(event.data.callId, name)
        state.toolCalls += 1
        if (validationTool(name)) state.validationCalls += 1
      } else if (event.type === 'tool/result') {
        const callId = event.data?.message?.source?.callId
        const failed = Boolean(event.data?.error)
          || event.data?.message?.content?.some((block) => block.type === 'tool-result' && block.isError === true)
        if (pendingSkills.has(callId)) {
          if (!failed) {
            state.active = true
            state.skillName = pendingSkills.get(callId)
          }
          pendingSkills.delete(callId)
        } else if (state.active && state.calls.has(callId)) {
          if (failed) state.toolFailures += 1
          state.calls.delete(callId)
        }
      } else if (event.type === 'turn/end') {
        turns.delete(key)
        openTurns.delete(sessionHash)
        if (!state.active) return
        const unclearApproval = state.promotionAttempted && state.promotionApproval !== 'exact'
        const failed = unclearApproval || state.userSignal === 'negative' || state.toolFailures > 0
        await ledger.append({
          schemaVersion: 1,
          caseId: createCaseId(session.id, turn, state.skillName),
          skillName: state.skillName,
          sessionHash: state.sessionHash,
          turn,
          outcome: failed ? 'failure' : 'success',
          evidence: {
            errorClass: unclearApproval ? 'UNCLEAR_APPROVAL' : state.userSignal === 'negative' ? 'REWORK' : state.toolFailures > 0 ? 'TOOL_FAILURE' : 'NONE',
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
      throw error
    }
  }

  observe.health = { ok: true, lastError: null }
  return observe
}
