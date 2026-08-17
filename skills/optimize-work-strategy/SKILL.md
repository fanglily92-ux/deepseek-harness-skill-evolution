---
name: optimize-work-strategy
description: Use when a whitelisted DeepSeek Harness Skill receives repeated user correction, validation failure, avoidable rework, or a request to improve the workbench or Skill strategy.
---

# Optimize Work Strategy

Turn repeated, verified failures into narrow strategy candidates without letting a proposal modify the stable Skill. Reflection fixes the current task; self-evolution additionally identifies the root cause, records reusable experience, evaluates a policy update, and changes later execution only after every gate passes.

## Hard invariants

- Stable is the default. Missing, conflicting, timed-out, quota-blocked, or subjective-only evidence means no promotion.
- Three independent `CASE-*` receipts are the minimum to propose, not proof that a candidate is better.
- Independent cases must have distinct case IDs, session hashes, and turn coordinates.
- Stable/candidate paired runs, all golden fixtures, pre-existing held-out fixtures, deterministic safety checks, and strict primary-metric improvement are mandatory.
- One critical regression blocks promotion. Average improvement cannot offset safety, privacy, approval, or critical-quality loss.
- Candidate material stays outside every Harness Skill discovery directory until atomic promotion.
- Never bypass the tools by directly editing `strategies.yaml`.
- Never edit plugin source, tool registrations, permissions, provider/model settings, credentials, Harness official files, or model parameters.

## Workflow

1. Call `evolution_status`. Stop if health or ledger integrity is degraded.
2. Call `evolution_review` with at least three independent receipt IDs for the same deterministic failure mechanism.
3. Call `evolution_propose` for one narrow, non-overlapping rule and precommit a lower-is-better primary metric before viewing candidate results.
4. Call `evolution_validate`. Stable and candidate must use identical model, provider, tools, permissions, input, and budget. `inconclusive`, tie, disagreement, omitted golden cases, or any regression means no update.
5. Show the exact `EVO-*` candidate, bounded diff, support/held-out results, guardrails, cost, uncertainty, and rollback condition.
6. Do not call `evolution_promote` until the user explicitly approves that exact `EVO-*` identifier in the current task. Generic continuation language is not approval.
7. Pass only `candidate_id` to `evolution_promote`. The promoter rechecks ledger integrity, validation hash, baseline hash, lock, backup, and postcondition. Harness's `tools/pre-execute` prompt is the final execution gate.
8. Report code completion, tests, installation, Harness mounting, real-call validation, promotion, observation, quarantine, and rollback as separate states.

## V1 layer boundary

- Memory: privacy-minimized receipts and append-only experience ledgers.
- Policy: evidence-bound append-only strategy rules.
- Skill: validated rules become stable only after exact human approval.
- Tool: never self-register or self-modify tools; a tool change can only be a future proposal requiring separate code review and authorization.
- Model: no SFT, RL, weight update, provider change, or model switch.

## Stop conditions

Keep stable when there are fewer than three cases, no pre-existing held-out/golden coverage, a stale baseline, an unknown lock, a budget failure, comparator disagreement, or an unverified critical result. Model self-evaluation and one reflection never constitute self-evolution.
