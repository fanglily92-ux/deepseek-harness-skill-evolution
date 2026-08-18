function outputContract() {
  return {
    schema: { type: 'object', additionalProperties: true, properties: {} },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function makeTool({ defineTool, name, description, parameters, service, concurrencySafe }) {
  return defineTool({
    name,
    description,
    parameters,
    output: outputContract(),
    isConcurrencySafe: () => concurrencySafe,
    async execute(args, exec) {
      return service(args, exec)
    },
  })
}

export function createEvolutionTools({ defineTool, services }) {
  if (typeof defineTool !== 'function') throw new TypeError('defineTool is required')
  for (const name of ['status', 'review', 'propose', 'validate', 'promote']) {
    if (typeof services?.[name] !== 'function') throw new TypeError(`services.${name} is required`)
  }
  return [
    makeTool({
      defineTool,
      name: 'evolution_status',
      description: 'Read the local Skill evolution workbench health, stable version, evidence counts, and pending candidate states.',
      parameters: {},
      service: services.status,
      concurrencySafe: true,
    }),
    makeTool({
      defineTool,
      name: 'evolution_review',
      description: 'Review three or more privacy-bounded case receipts for one repeated failure mechanism without changing a Skill.',
      parameters: {
        case_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Three or more exact CASE-* identifiers.' },
      },
      service: services.review,
      concurrencySafe: false,
    }),
    makeTool({
      defineTool,
      name: 'evolution_propose',
      description: 'Create an isolated append-only strategy candidate from reviewed evidence; never changes the stable Skill.',
      parameters: {
        mechanism: { type: 'string', required: true, description: 'The reviewed failure mechanism.' },
        case_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Supporting CASE-* identifiers.' },
        task_kinds: { type: 'array', required: true, items: { type: 'string' }, description: 'Narrow task kinds supported by the evidence.' },
        action: { type: 'string', required: true, description: 'One concrete behavior to add.' },
        avoid: { type: 'string', required: true, description: 'The old behavior this rule prevents.' },
      },
      service: services.propose,
      concurrencySafe: false,
    }),
    makeTool({
      defineTool,
      name: 'evolution_validate',
      description: 'High-token operation: after explicit user approval, run staged isolated stable/candidate evaluation and fail closed on uncertainty, budget exhaustion, or regression.',
      parameters: {
        candidate_id: { type: 'string', required: true, description: 'Exact EVO-YYYYMMDD-NNN identifier.' },
      },
      service: services.validate,
      concurrencySafe: false,
    }),
    makeTool({
      defineTool,
      name: 'evolution_promote',
      description: 'Promote one fully validated candidate after Harness asks the user for one-time approval.',
      parameters: {
        candidate_id: { type: 'string', required: true, description: 'Exact validated EVO-YYYYMMDD-NNN identifier.' },
      },
      service: services.promote,
      concurrencySafe: false,
    }),
  ]
}
