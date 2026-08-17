const NEGATIVE = /(?:不对|错了|重做|重新做|没有完成|越改越差|not correct|redo|try again)/iu
const POSITIVE = /(?:通过|可以了|确认无误|做得好|looks good|approved)/iu
const APPROVAL_WORD = /(?:继续|可以|通过|确认|批准|approve|approved|proceed)/iu
const APPROVAL_REJECTION = /(?:不批准|拒绝|不要晋升|reject|do not approve)/iu
const CANDIDATE_ID = /\bEVO-\d{8}-\d{3}\b/u

export function classifyDirectUserSignal(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return 'none'
  let positive = false
  let negative = false
  for (const block of contentBlocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    positive ||= POSITIVE.test(block.text)
    negative ||= NEGATIVE.test(block.text)
  }
  if (positive === negative) return 'none'
  return positive ? 'positive' : 'negative'
}

export function classifyPromotionApproval(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return 'none'
  let hasApproval = false
  let hasCandidateId = false
  let rejected = false
  for (const block of contentBlocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    hasApproval ||= APPROVAL_WORD.test(block.text)
    hasCandidateId ||= CANDIDATE_ID.test(block.text)
    rejected ||= APPROVAL_REJECTION.test(block.text)
  }
  if (rejected || !hasApproval) return 'none'
  return hasCandidateId ? 'exact' : 'generic'
}

export function safeEventSummary(event) {
  if (!event || typeof event !== 'object') return null
  const base = {
    type: event.type,
    seq: event.seq,
    time: event.time,
  }
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  if (event.type === 'tool/call' || event.type === 'tool/result') {
    return {
      ...base,
      turn: data.turn,
      step: data.step,
      callId: data.callId,
      tool: data.name,
      ...(event.type === 'tool/result' ? { isError: data.isError === true } : {}),
    }
  }
  if (event.type === 'turn/end') return { ...base, turn: data.turn }
  if (event.type === 'user/message') {
    return { ...base, turn: data.turn, source: data.source?.kind }
  }
  return null
}
