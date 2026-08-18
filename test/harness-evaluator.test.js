import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { createChildAgentArmRunner, createHarnessEvaluator } from '../src/harness-evaluator.js'
import { hashCanonical } from '../src/integrity.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Harness evaluator runs paired fixtures with identical environment and returns a validator report', async () => {
  const calls = []
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-evaluator-')))
  const authorityRoot = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-authority-')))
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
      return { criticalPass: true, primary: call.arm === 'candidate' && isSupport ? 0 : isSupport ? 1 : 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
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
  assert.equal(calls.every((call) => call.budget.maxOutputTokensPerArm === 32), true)
  assert.equal(calls.every((call) => call.budget.maxPromptCharsPerArm === 8000), true)
  assert.equal(report.budget.maxMeteredTokens, 100000)
  assert.deepEqual(new Set(calls.map((call) => JSON.stringify(call.environment))), new Set(['{"provider":"same-provider","model":"same-model"}']))

  await writeFile(join(skillDirectory, 'SKILL.md'), 'CHANGED_AFTER_PROPOSAL\n')
  await assert.rejects(evaluator(candidate, { agent: { options: { provider: 'same-provider', model: 'same-model' } } }), /evaluation binding changed/)
})

test('Harness evaluator stops after the 10-arm preflight when the candidate does not strictly improve', async () => {
  const calls = []
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-preflight-workspace-')))
  const authorityRoot = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-preflight-authority-')))
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
      return { criticalPass: true, primary: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
    },
  })
  const prepared = await evaluator.prepareCandidateBinding()
  const candidate = {
    id: 'EVO-20260818-001', createdAt: 1786924800000,
    candidateHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64),
    proposedRule: { primaryMetric: 'golden-label-error-rate', appliesWhen: { failureMechanisms: ['UNCLEAR_APPROVAL'] } },
    evaluationBinding: { ...prepared, baselineCatalogHash: 'b'.repeat(64), candidateHash: 'a'.repeat(64) },
  }

  const report = await evaluator(candidate, { agent: { options: { provider: 'same-provider', model: 'same-model' } } })

  assert.equal(report.status, 'complete')
  assert.equal(report.stage, 'preflight-rejected')
  assert.equal(report.fixtureResults.length, 5)
  assert.equal(report.budget.actualRuns, 10)
  assert.equal(calls.length, 10)
})

test('Harness evaluator carries the candidate token budget across preflight and confirmation', async () => {
  const calls = []
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-token-workspace-')))
  const authorityRoot = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-token-authority-')))
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
      return {
        criticalPass: true,
        primary: call.arm === 'candidate' && isSupport ? 0 : isSupport ? 1 : 0,
        usage: { inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0 },
      }
    },
  })
  const prepared = await evaluator.prepareCandidateBinding()
  const candidate = {
    id: 'EVO-20260818-001', createdAt: 1786924800000,
    candidateHash: 'a'.repeat(64), baselineHash: 'b'.repeat(64),
    proposedRule: { primaryMetric: 'golden-label-error-rate', appliesWhen: { failureMechanisms: ['UNCLEAR_APPROVAL'] } },
    evaluationBinding: { ...prepared, baselineCatalogHash: 'b'.repeat(64), candidateHash: 'a'.repeat(64) },
  }

  const report = await evaluator(candidate, { agent: { options: { provider: 'same-provider', model: 'same-model' } } })

  assert.equal(report.status, 'inconclusive')
  assert.equal(report.stage, 'confirmation-inconclusive')
  assert.equal(report.reason, 'token budget exhausted')
  assert.equal(report.budget.maxMeteredTokens, 100000)
  assert.equal(report.budget.actualRuns, 20)
  assert.equal(report.budget.usage.meteredTokens, 100000)
  assert.equal(calls.length, 20)
})

test('Harness evaluator rejects an incomplete evaluation policy before candidate binding', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-policy-workspace-')))
  const authorityRoot = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-policy-authority-')))
  const skillDirectory = join(authorityRoot, 'skills', 'optimize-work-strategy')
  await mkdir(join(skillDirectory, 'references'), { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), 'STABLE_SKILL_MARKER\n')
  await writeFile(join(skillDirectory, 'references', 'strategies.yaml'), '{"schemaVersion":1,"stableVersion":0,"rules":[]}\n')
  const policy = JSON.parse(await readFile(join(root, 'config', 'evaluation-policy.json'), 'utf8'))
  delete policy.maxMeteredTokensPerCandidate
  const invalidPolicyPath = join(workspace, 'invalid-policy.json')
  await writeFile(invalidPolicyPath, `${JSON.stringify(policy)}\n`)
  const evaluator = createHarnessEvaluator({
    ctx: {}, workspace, authorityRoot,
    fixturesDirectory: join(root, 'eval', 'fixtures'),
    policyPath: invalidPolicyPath,
    runArm: async () => { throw new Error('must not run') },
  })

  await assert.rejects(evaluator.prepareCandidateBinding(), /invalid evaluation policy: maxMeteredTokensPerCandidate/)
})

test('Harness evaluator rejects token limits above the fixed safety contract', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-policy-cap-workspace-')))
  const authorityRoot = await realpath(await mkdtemp(join(tmpdir(), 'evolution-harness-policy-cap-authority-')))
  const skillDirectory = join(authorityRoot, 'skills', 'optimize-work-strategy')
  await mkdir(join(skillDirectory, 'references'), { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), 'STABLE_SKILL_MARKER\n')
  await writeFile(join(skillDirectory, 'references', 'strategies.yaml'), '{"schemaVersion":1,"stableVersion":0,"rules":[]}\n')
  const policy = JSON.parse(await readFile(join(root, 'config', 'evaluation-policy.json'), 'utf8'))
  policy.maxOutputTokensPerArm = 33
  const invalidPolicyPath = join(workspace, 'unsafe-policy.json')
  await writeFile(invalidPolicyPath, `${JSON.stringify(policy)}\n`)
  const evaluator = createHarnessEvaluator({
    ctx: {}, workspace, authorityRoot,
    fixturesDirectory: join(root, 'eval', 'fixtures'), policyPath: invalidPolicyPath,
    runArm: async () => { throw new Error('must not run') },
  })

  await assert.rejects(evaluator.prepareCandidateBinding(), /invalid evaluation policy: maxOutputTokensPerArm/)
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
              events.push({
                type: 'assistant/message',
                data: {
                  usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 20 },
                  message: { content: [{ type: 'text', text: '{"decision":"deny"}' }] },
                },
              })
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
    exec: { agent: parent }, budget: { timeoutMs: 1000, maxOutputTokensPerArm: 32, maxPromptCharsPerArm: 1000 },
  })
  assert.deepEqual(creationOptions.agentOptions, { provider: 'p', model: 'm', maxTokens: 32 })
  assert.match(contextText, /STR-0001/)
  assert.doesNotMatch(contextText, /Additional candidate rule|NONE/)
  assert.equal(guard({}), 'evaluation agents cannot execute tools')
  assert.deepEqual(result, {
    criticalPass: true,
    primary: 0,
    usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 20 },
  })
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
    arm: 'stable', fixture: { input: 'x', expectedDecision: 'deny' }, budget: { timeoutMs: 5, maxOutputTokensPerArm: 32, maxPromptCharsPerArm: 1000 },
    candidate: { id: 'EVO-20260818-001', armRoots: { stable: '/tmp/stable', candidate: '/tmp/candidate' }, stableSkill: 'STABLE', stableStrategies: '{}', proposedRule: { id: 'STR-0001' } },
    exec: { agent: { id: 'parent', options: {}, ctx: parentCtx } },
  }), /timed out/)
  assert.equal(cancelled, true)
})

test('child-agent arm runner fails closed when the provider omits token usage', async () => {
  const childCtx = { tools: { guard() {} }, systemPrompt: { context() {} } }
  const evaluatorCtx = { agentPresets: { composeFrom() {} } }
  const events = []
  const parentCtx = { agents: { async create(options) {
    options.setup(childCtx)
    return { agent: {
      session: { events },
      followup() { events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"decision":"deny"}' }] } } }) },
      async whenIdle() {},
    }, async dispose() {} }
  } } }
  const runArm = createChildAgentArmRunner(evaluatorCtx)

  await assert.rejects(runArm({
    arm: 'stable', fixture: { input: 'x', expectedDecision: 'deny' },
    budget: { timeoutMs: 1000, maxOutputTokensPerArm: 32, maxPromptCharsPerArm: 1000 },
    candidate: { id: 'EVO-20260818-001', armRoots: { stable: '/tmp/stable', candidate: '/tmp/candidate' }, stableSkill: 'STABLE', stableStrategies: '{}', proposedRule: { id: 'STR-0001' } },
    exec: { agent: { id: 'parent', options: {}, ctx: parentCtx } },
  }), (error) => error.code === 'TOKEN_USAGE_UNAVAILABLE')
})

test('child-agent arm runner fails closed when reported output exceeds its configured cap', async () => {
  const childCtx = { tools: { guard() {} }, systemPrompt: { context() {} } }
  const evaluatorCtx = { agentPresets: { composeFrom() {} } }
  const events = []
  const parentCtx = { agents: { async create(options) {
    options.setup(childCtx)
    return { agent: {
      session: { events },
      followup() { events.push({ type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 33, cacheReadTokens: 0 }, message: { content: [{ type: 'text', text: '{"decision":"deny"}' }] } } }) },
      async whenIdle() {},
    }, async dispose() {} }
  } } }
  const runArm = createChildAgentArmRunner(evaluatorCtx)

  await assert.rejects(runArm({
    arm: 'stable', fixture: { input: 'x', expectedDecision: 'deny' },
    budget: { timeoutMs: 1000, maxOutputTokensPerArm: 32, maxPromptCharsPerArm: 1000 },
    candidate: { id: 'EVO-20260818-001', armRoots: { stable: '/tmp/stable', candidate: '/tmp/candidate' }, stableSkill: 'STABLE', stableStrategies: '{}', proposedRule: { id: 'STR-0001' } },
    exec: { agent: { id: 'parent', options: {}, ctx: parentCtx } },
  }), (error) => error.code === 'TOKEN_BUDGET')
})

test('child-agent arm runner rejects an oversized fixture before creating a child agent', async () => {
  let creations = 0
  const evaluatorCtx = { agentPresets: { composeFrom() {} } }
  const parentCtx = { agents: { async create() { creations += 1; throw new Error('must not create') } } }
  const runArm = createChildAgentArmRunner(evaluatorCtx)

  await assert.rejects(runArm({
    arm: 'stable', fixture: { input: 'x'.repeat(1000), expectedDecision: 'deny' },
    budget: { timeoutMs: 1000, maxOutputTokensPerArm: 32, maxPromptCharsPerArm: 1000 },
    candidate: { id: 'EVO-20260818-001', armRoots: { stable: '/tmp/stable', candidate: '/tmp/candidate' }, stableSkill: 'STABLE', stableStrategies: '{}', proposedRule: { id: 'STR-0001' } },
    exec: { agent: { id: 'parent', options: {}, ctx: parentCtx } },
  }), (error) => error.code === 'TOKEN_BUDGET')
  assert.equal(creations, 0)
})
