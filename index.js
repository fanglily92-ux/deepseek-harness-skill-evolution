import { defineTool } from '@deepseek-ai/dsh-tools'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEvolutionTools } from './src/tools.js'
import { createRuntimeServices } from './src/runtime.js'
import { createEventObserver } from './src/event-observer.js'
import { ReceiptLedger } from './src/receipt-ledger.js'
import { resolveWorkbenchPaths } from './src/paths.js'
import { createHarnessEvaluator } from './src/harness-evaluator.js'

export const name = 'deepseek-skill-evolution'
export const inject = ['tools', 'agents', 'agentPresets']

export function apply(ctx, config = {}) {
  if (!config.services && typeof config.workspace !== 'string') {
    throw new Error('deepseek-skill-evolution requires an absolute workspace path')
  }
  const pluginRoot = dirname(fileURLToPath(import.meta.url))
  const evaluator = config.evaluator ?? (config.workspace ? createHarnessEvaluator({
    ctx,
    workspace: config.workspace,
    fixturesDirectory: join(pluginRoot, 'eval', 'fixtures'),
    policyPath: join(pluginRoot, 'config', 'evaluation-policy.json'),
  }) : undefined)
  const services = config.services ?? createRuntimeServices({ workspace: config.workspace, evaluator })
  const disposers = []
  for (const tool of createEvolutionTools({ defineTool, services })) {
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
  } else if (config.workspace) {
    const paths = resolveWorkbenchPaths(config.workspace)
    let ledgerPromise
    let observerPromise
    const listener = async (session, event) => {
      try {
        ledgerPromise ??= ReceiptLedger.open(paths)
        observerPromise ??= Promise.all([
          ledgerPromise,
          readWhitelist(join(pluginRoot, 'config', 'whitelist.json')),
        ]).then(([ledger, whitelist]) => createEventObserver({ ledger, whitelist }))
        return await (await observerPromise)(session, event)
      } catch {
        return undefined
      }
    }
    disposers.push(ctx.on('session/event', listener))
    disposers.push(async () => { if (ledgerPromise) await (await ledgerPromise).close() })
  }
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}

async function readWhitelist(path) {
  const { readFile } = await import('node:fs/promises')
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.skills)) throw new Error('invalid evolution whitelist')
  return new Set(parsed.skills)
}
