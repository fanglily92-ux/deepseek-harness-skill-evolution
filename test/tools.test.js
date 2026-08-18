import test from 'node:test'
import assert from 'node:assert/strict'
import { createEvolutionTools } from '../src/tools.js'
import { defineEvolutionTool as defineTool } from '../src/tool-definition.js'

function services() {
  return {
    status: async () => ({ state: 'healthy' }),
    review: async ({ case_ids }) => ({ reviewed: case_ids.length }),
    propose: async ({ mechanism }) => ({ mechanism }),
    validate: async ({ candidate_id }) => ({ candidate_id, pass: true }),
    promote: async ({ candidate_id }) => ({ candidate_id, promoted: true }),
  }
}

test('createEvolutionTools exposes exactly five schemas and no model approval bypass', () => {
  const tools = createEvolutionTools({ defineTool, services: services() })

  assert.deepEqual(tools.map((tool) => tool.name), [
    'evolution_status', 'evolution_review', 'evolution_propose', 'evolution_validate', 'evolution_promote',
  ])
  const promote = tools.find((tool) => tool.name === 'evolution_promote')
  assert.deepEqual(Object.keys(promote.parameters.properties), ['candidate_id'])
  assert.deepEqual(promote.parameters.required, ['candidate_id'])
  assert.equal('approved' in promote.parameters.properties, false)
  const propose = tools.find((tool) => tool.name === 'evolution_propose')
  assert.equal('primary_metric' in propose.parameters.properties, false)
  assert.equal('baseline_value' in propose.parameters.properties, false)
  const validate = tools.find((tool) => tool.name === 'evolution_validate')
  assert.match(validate.description, /high-token operation/i)
  assert.match(validate.description, /explicit user approval/i)
})

test('only evolution_status declares itself concurrency safe', () => {
  const tools = createEvolutionTools({ defineTool, services: services() })

  for (const tool of tools) {
    assert.equal(tool.isConcurrencySafe({}), tool.name === 'evolution_status')
  }
})

test('tool output renders canonical indented JSON', async () => {
  const [status] = createEvolutionTools({ defineTool, services: services() })
  const value = await status.execute({}, { signal: new AbortController().signal })
  assert.deepEqual(status.output.render({}, value), [{ type: 'text', text: '{\n  "state": "healthy"\n}' }])
})
