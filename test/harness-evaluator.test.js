import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createChildAgentArmRunner, createHarnessEvaluator } from '../src/harness-evaluator.js'
import { hashCanonical } from '../src/integrity.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Harness evaluator runs paired fixtures with identical environment and returns a validator report', async () => {
  const calls = []
  const workspace = await mkdtemp(join(tmpdir(), 'evolution-harness-evaluator-'))
  const authorityRoot = await mkdtemp(join(tmpdir(), 'evolution-harness-authority-'))
  const skillDirectory = join(authorityRoot, 'skills', 'optimize-work-strategy')
  await mkdir(join(skillDirectory, 'references'), { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), 'STABLE_SKILL_MARKER\n')
  await writeFile(join(skillDirectory, 'references', 'strategies.yaml'), '{"schemaVersion":1,"stableVersion":0,"rules":[]}\n')
  const evaluator = createHarnessEvaluator({
    ctx: {}, workspace, authorityRoot,
    fixturesDirectory: join(root, 'eval', 'fixtures'),
    policyPath: join(root, 'config', 'evaluation-policy.json'),
    runArm: async (call) => {
      calls.push(call)
      const isSupport = call.fixture.partition === 'support'
      return { criticalPass: true, primary: call.arm === 'candidate' && isSupport ? 0 : isSupport ? 1 : 0 }
    },
  })
  const prepared = await evaluator.prepareCandidateBinding()
  const evaluatorSources = await Promise.all([
    'harness-evaluator.js', 'evaluation-suite.js', 'validator.js', 'blind-comparator.js', 'shadow-runner.js', 'contracts.js',
  ].map((name) => readFile(join(root, 'src', name), 'utf8')))
  assert.equal(prepared.evaluatorCodeHash, hashCanonical(evaluatorSources))
  const candidate = {
    id: 'EVO-20260818-001', createdAt: 1786924800000,
    candidateHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64),
    proposedRule: { primaryMetric: 'golden-label-error-rate', appliesWhen: { failureMechanisms: ['UNCLEAR_APPROVAL'] } },
    evaluationBinding: { ...prepared, baselineCatalogHash: 'b'.repeat(64), candidateHash: 'a'.repeat(64) },
  }
  const report = await evaluator(candidate, { agent: { options: { provider: 'same-provider', model: 'same-model' } } })

  assert.equal(report.status, 'complete')
  assert.equal(report.fixtureResults.length, 15)
  assert.equal(report.allGoldenIncluded, true)
  assert.deepEqual(report.comparator, { disagreement: false, mode: 'sealed-blind-golden-label' })
  assert.equal(report.fixtureResults.every((result) => result.blindComparison?.sealedMappingHash?.length === 64), true)
  assert.equal(calls.length, 30)
  assert.deepEqual(report.binding, candidate.evaluationBinding)
  assert.equal(calls.every((call) => call.candidate.stableSkill === 'STABLE_SKILL_MARKER\n'), true)
  assert.deepEqual(new Set(calls.map((call) => JSON.stringify(call.environment))), new Set(['{"provider":"same-provider","model":"same-model"}']))

  await writeFile(join(skillDirectory, 'SKILL.md'), 'CHANGED_AFTER_PROPOSAL\n')
  await assert.rejects(evaluator(candidate, { agent: { options: { provider: 'same-provider', model: 'same-model' } } }), /evaluation binding changed/)
})

test('child-agent arm runner inherits the parent model, blocks tools, and returns only scored facts', async () => {
  let creationOptions
  let guard
  let contextText
  const events = []
  const childCtx = {
    tools: { guard(value) { guard = value; return () => undefined } },
    systemPrompt: { context(value) { contextText = value.text; return () => undefined } },
  }
  const evaluatorCtx = {
    agentPresets: { composeFrom(received, parent) { assert.equal(received, childCtx); assert.equal(parent, parentCtx) } },
  }
  const parentCtx = {
    agents: {
      async create(options) {
        creationOptions = options
        options.setup(childCtx)
        return {
          agent: {
            session: { events },
            cancel() {},
            followup() {
              events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"decision":"deny"}' }] } } })
            },
            async whenIdle() {},
          },
          async dispose() {},
        }
      },
    },
  }
  const parent = { id: 'parent', options: { provider: 'p', model: 'm', maxTokens: 100 }, ctx: parentCtx }
  const runArm = createChildAgentArmRunner(evaluatorCtx)
  const result = await runArm({
    arm: 'candidate', fixture: { input: 'continue', expectedDecision: 'deny' },
    candidate: { id: 'EVO-20260818-001', armRoots: { stable: '/tmp/stable', candidate: '/tmp/candidate' }, stableSkill: 'STABLE', stableStrategies: '{}', proposedRule: { id: 'STR-0001' } },
    exec: { agent: parent }, budget: { timeoutMs: 1000 },
  })
  assert.deepEqual(creationOptions.agentOptions, parent.options)
  assert.match(contextText, /STR-0001/)
  assert.doesNotMatch(contextText, /Additional candidate rule|NONE/)
  assert.equal(guard({}), 'evaluation agents cannot execute tools')
  assert.deepEqual(result, { criticalPass: true, primary: 0 })
})

test('child-agent arm runner cancels and fails closed on its per-run timeout', async () => {
  let cancelled = false
  let idleCalls = 0
  const childCtx = { tools: { guard() {} }, systemPrompt: { context() {} } }
  const evaluatorCtx = { agentPresets: { composeFrom() {} } }
  const parentCtx = { agents: { async create(options) {
    options.setup(childCtx)
    return { agent: {
      session: { events: [] }, followup() {},
      cancel() { cancelled = true },
      whenIdle() { idleCalls += 1; return idleCalls === 1 ? new Promise(() => {}) : Promise.resolve() },
    }, async dispose() {} }
  } } }
  const runArm = createChildAgentArmRunner(evaluatorCtx)
  await assert.rejects(runArm({
    arm: 'stable', fixture: { input: 'x', expectedDecision: 'deny' }, budget: { timeoutMs: 5 },
    candidate: { id: 'EVO-20260818-001', armRoots: { stable: '/tmp/stable', candidate: '/tmp/candidate' }, stableSkill: 'STABLE', stableStrategies: '{}', proposedRule: { id: 'STR-0001' } },
    exec: { agent: { id: 'parent', options: {}, ctx: parentCtx } },
  }), /timed out/)
  assert.equal(cancelled, true)
})
