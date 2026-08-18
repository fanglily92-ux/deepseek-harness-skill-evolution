import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEvolutionTools } from './src/tools.js'
import { createRuntimeServices } from './src/runtime.js'
import { createEventObserver } from './src/event-observer.js'
import { ReceiptLedger } from './src/receipt-ledger.js'
import { assertAuthorityRootOutsideSandboxTemp, assertProjectSkillAbsent, resolveWorkbenchPaths } from './src/paths.js'
import { createHarnessEvaluator } from './src/harness-evaluator.js'
import { defineEvolutionTool } from './src/tool-definition.js'

export const name = 'deepseek-skill-evolution'
export const inject = ['tools', 'agents', 'agentPresets', 'shell', 'fs', 'sandboxPolicy']

export function recordObserverSuccess(observerHealth, seq) {
  if (observerHealth.status === 'degraded') return
  observerHealth.status = 'healthy'
  observerHealth.lastErrorCode = null
  observerHealth.lastSuccessSeq = Number.isFinite(seq) ? seq : observerHealth.lastSuccessSeq
}

function containedBy(root, target) {
  const relation = relative(resolve(root), resolve(target))
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

export function apply(ctx, config = {}) {
  if (!config.services && typeof config.workspace !== 'string') {
    throw new Error('deepseek-skill-evolution requires an absolute workspace path')
  }
  const pluginRoot = dirname(fileURLToPath(import.meta.url))
  let authorityPaths
  let sandboxPolicy
  if (config.workspace) {
    authorityPaths = resolveWorkbenchPaths(config.workspace, { authorityRoot: config.authorityRoot })
    assertAuthorityRootOutsideSandboxTemp(authorityPaths.authorityRoot)
    assertProjectSkillAbsent(authorityPaths.projectSkill)
    if (!containedBy(authorityPaths.authorityRoot, pluginRoot)) throw new Error('plugin code must be installed under authorityRoot outside the agent workspace')
    sandboxPolicy = ctx.sandboxPolicy ?? ctx.get?.('sandboxPolicy')
    if (!sandboxPolicy || typeof sandboxPolicy.resolve !== 'function') throw new Error('sandboxPolicy service is required')
    for (const [name, mode] of [['shell', ctx.shell?.sandboxMode], ['fs', ctx.fs?.sandboxMode], ['policy', sandboxPolicy.defaultMode]]) {
      if (!['read-only', 'workspace-write'].includes(mode)) throw new Error(`${name} must enforce read-only or workspace-write mode`)
    }
  }
  const observerHealth = { status: config.workspace ? 'initializing' : 'healthy', lastErrorCode: null, lastSuccessSeq: null }
  const evaluator = config.evaluator ?? (config.workspace ? createHarnessEvaluator({
    ctx,
    workspace: config.workspace,
    authorityRoot: config.authorityRoot,
    fixturesDirectory: join(pluginRoot, 'eval', 'fixtures'),
    policyPath: join(pluginRoot, 'config', 'evaluation-policy.json'),
  }) : undefined)
  const services = config.services ?? createRuntimeServices({ workspace: config.workspace, authorityRoot: config.authorityRoot, evaluator, observerHealth })
  const disposers = []
  for (const tool of createEvolutionTools({ defineTool: defineEvolutionTool, services })) {
    disposers.push(ctx.tools.register(tool))
  }
  disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
    if (authorityPaths) {
      if (exec.name.startsWith('evolution_')) {
        try {
          assertProjectSkillAbsent(authorityPaths.projectSkill)
        } catch {
          return { kind: 'deny', reason: 'A project Skill shadows the protected optimize-work-strategy Skill.' }
        }
      }
      const policy = await sandboxPolicy.resolve(exec.agent?.session ? { session: exec.agent.session } : {})
      if (!['read-only', 'workspace-write'].includes(policy?.mode) || resolve(policy.workspaceRoot) !== authorityPaths.workspace) {
        return { kind: 'deny', reason: 'Skill evolution requires a workspace-confined agent session.' }
      }
      if (exec.arguments?.sandbox_permissions !== undefined) {
        return { kind: 'deny', reason: 'Sandbox escalation is disabled while the Skill evolution authority is mounted.' }
      }
    }
    if (config.workspace && !exec.name.startsWith('evolution_')) {
      const serialized = JSON.stringify(exec.arguments ?? {}).replaceAll('\\', '/')
      const protectedFragments = [
        '.dsh/skills/optimize-work-strategy/references/strategies.yaml',
        'logs/DeepSeek-Harness自进化/state/receipts.jsonl',
        'logs/DeepSeek-Harness自进化/state/candidates.json',
        'logs/DeepSeek-Harness自进化/state/versions.jsonl',
      ]
      if (protectedFragments.some((fragment) => serialized.includes(fragment))) {
        return { kind: 'deny', reason: 'Authority state may be changed only through evolution tools.' }
      }
    }
    const candidateId = exec.arguments?.candidate_id
    if (exec.name === 'evolution_validate') {
      return {
        kind: 'ask',
        reason: `Validate ${candidateId} with a 10-arm preflight and up to 20 confirmation arms (30 maximum; stop after reported metered usage reaches 100000 tokens). This is a high-token operation and requires explicit user approval.`,
      }
    }
    if (exec.name !== 'evolution_promote') return next()
    return {
      kind: 'ask',
      reason: `Promote ${candidateId} to the stable optimize-work-strategy catalog after all monotonic checks passed.`,
    }
  }))
  if (typeof config.observer === 'function') {
    disposers.push(ctx.on('session/event', config.observer))
  } else if (config.workspace) {
    const paths = authorityPaths
    let ledgerPromise
    let observerPromise
    const listener = async (session, event) => {
      try {
        ledgerPromise ??= ReceiptLedger.open(paths)
        observerPromise ??= Promise.all([
          ledgerPromise,
          readWhitelist(join(pluginRoot, 'config', 'whitelist.json')),
        ]).then(([ledger, whitelist]) => createEventObserver({ ledger, whitelist }))
        const result = await (await observerPromise)(session, event)
        recordObserverSuccess(observerHealth, event?.seq)
        return result
      } catch (error) {
        observerHealth.status = 'degraded'
        observerHealth.lastErrorCode = typeof error?.code === 'string' ? error.code : 'OBSERVER_ERROR'
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
