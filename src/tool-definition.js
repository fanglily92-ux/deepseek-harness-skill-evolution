function valueSchema(spec) {
  const schema = { type: spec.type }
  if (typeof spec.description === 'string') schema.description = spec.description
  if (spec.type === 'array') schema.items = valueSchema(spec.items)
  return schema
}

export function defineEvolutionTool(options) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(options.parameters ?? {})) {
    properties[name] = valueSchema(spec)
    if (spec.required === true) required.push(name)
  }
  return {
    ...options,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
  }
}
