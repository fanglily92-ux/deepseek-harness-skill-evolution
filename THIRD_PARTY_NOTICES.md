# Third-party inspiration and dependencies

This repository contains an independent Node.js implementation. It does not copy source code, prompts, templates, fixtures, or model weights from the inspiration repositories below.

## Design inspiration

| Project | Upstream license | Mechanism studied | What this project does not adopt |
|---|---|---|---|
| [DSPy / GEPA](https://github.com/stanfordnlp/dspy) | MIT | Candidate lineage, per-example scores, bounded evaluation | No DSPy runtime or training-score promotion |
| [Anthropic Skills](https://github.com/anthropics/skills) | See upstream repository and per-skill notices | Baseline comparison, positive/negative examples, blind review | No copied Skill text, scripts, templates, or Claude-specific command layout |
| [LangMem](https://github.com/langchain-ai/langmem) | MIT | Hot-path capture separated from background consolidation | No vector database or agent-direct stable writes |
| [Reflexion](https://github.com/noahshinn/reflexion) | MIT | Bounded reflection, durable attempt history, recovery points | No single self-score treated as success |
| [Microsoft PromptWizard](https://github.com/microsoft/PromptWizard) | MIT | Train/test separation and explicit iteration budgets | No Python framework or synthetic-only generalization claims |

The isolation rule was also informed by [Anthropic Skills issue #1260](https://github.com/anthropics/skills/issues/1260), which describes candidate files becoming visible through a live command-discovery directory. This project keeps candidates outside Skill discovery roots.

## Compatibility references

- `@deepseek-ai/dsh-tools@0.1.0-rc.6` — MIT; its public tool shape was inspected during compatibility work, but it is not imported or shipped.
- `@deepseek-ai/dsh-agent-presets@0.1.0-rc.6` — MIT; its public preset contract was inspected during compatibility work, but it is not imported or shipped.
- `@deepseek-ai/dsh-sandbox-local@0.1.0-rc.6` — MIT; the optional host verification script dynamically loads the copy already installed with Harness to execute a real confinement probe. It is not downloaded, bundled, or declared as a project dependency.

The runtime dependency set is empty. `package-lock.json` and the runtime import graph are still checked at the release gate. This notice is not legal advice; the upstream license files remain authoritative.
