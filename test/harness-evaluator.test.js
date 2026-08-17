import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChildAgentArmRunner, createHarnessEvaluator } from '../src/harness-evaluator.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Harness evaluator runs paired fixtures with identical environment and returns a validator report', async () => {
  const calls = []
  const evaluator = createHarnessEvaluator({
    ctx: {}, workspace: '/tmp/evolution-workspace',
    fixturesDirectory: join(root, 'eval', 'fixtures'),
    policyPath: join(root, 'config', 'evaluation-policy.json'),
    runArm: async (call) => {
      calls.push(call)
      const isSupport = call.fixture.partition === 'support'
      return { criticalPass: true, primary: call.arm === 'candidate' && isSupport ? 0 : isSupport ? 1 : 0 }
    },
  })
  const report = await evaluator({
    id: 'EVO-20260818-001', createdAt: 1786924800000,
    proposedRule: { appliesWhen: { failureMechanisms: ['UNCLEAR_APPROVAL'] } },
  }, { agent: { options: { provider: 'same-provider', model: 'same-model' } } })

  assert.equal(report.status, 'complete')
  assert.equal(report.fixtureResults.length, 5)
  assert.equal(report.allGoldenIncluded, true)
  assert.equal(calls.length, 10)
  assert.deepEqual(new Set(calls.map((call) => JSON.stringify(call.environment))), new Set(['{"provider":"same-provider","model":"same-model"}']))
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
    candidate: { id: 'EVO-20260818-001', workspace: '/tmp/workspace', proposedRule: { id: 'STR-0001' } },
    exec: { agent: parent },
  })
  assert.deepEqual(creationOptions.agentOptions, parent.options)
  assert.match(contextText, /STR-0001/)
  assert.equal(guard({}), 'evaluation agents cannot execute tools')
  assert.deepEqual(result, { criticalPass: true, primary: 0 })
})
