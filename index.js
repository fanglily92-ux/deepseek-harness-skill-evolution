import { defineTool } from '@deepseek-ai/dsh-tools'

import { createEvolutionTools } from './src/tools.js'

export const name = 'deepseek-skill-evolution'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  if (!config.services) throw new Error('deepseek-skill-evolution requires runtime services')
  const disposers = []
  for (const tool of createEvolutionTools({ defineTool, services: config.services })) {
    disposers.push(ctx.tools.register(tool))
  }
  disposers.push(ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'evolution_promote') return next()
    const candidateId = exec.arguments?.candidate_id
    return {
      kind: 'ask',
      reason: `Promote ${candidateId} to the stable optimize-work-strategy catalog after all monotonic checks passed.`,
    }
  }))
  if (typeof config.observer === 'function') {
    disposers.push(ctx.on('session/event', config.observer))
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
