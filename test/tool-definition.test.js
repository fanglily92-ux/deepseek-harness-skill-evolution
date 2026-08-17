import test from 'node:test'
import assert from 'node:assert/strict'

import { defineEvolutionTool } from '../src/tool-definition.js'

test('defineEvolutionTool converts local parameter specs to strict Harness JSON Schema', () => {
  const tool = defineEvolutionTool({
    name: 'example',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'string' }, description: 'ids' },
      note: { type: 'string' },
    },
  })
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: {
      ids: { type: 'array', description: 'ids', items: { type: 'string' } },
      note: { type: 'string' },
    },
    required: ['ids'],
    additionalProperties: false,
  })
})
