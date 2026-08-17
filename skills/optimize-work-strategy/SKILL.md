---
name: optimize-work-strategy
description: Use when a whitelisted DeepSeek Harness Skill receives repeated user correction, validation failure, avoidable rework, or a request to improve the workbench or Skill strategy.
---

# Optimize Work Strategy

## Overview

Turn repeated, verified failures into narrow strategy candidates without letting a proposal modify the stable Skill. Reflection fixes the current task; self-evolution additionally identifies the root cause, records reusable experience, evaluates a policy update, and changes later execution only after every gate passes. Reflection proposes; paired evidence evaluates; the user decides; the plugin enforces every gate.

## Apply stable experience

At the start of every invocation, read the protected user-Skill `references/strategies.yaml` installed under the plugin's authority root. Apply only `stable` rules whose `appliesWhen` conditions match the current task. Treat an unreadable, invalid, candidate-status, workspace-shadowed, or ambiguous rule as unavailable and keep the hard invariants in this file. Never treat an Obsidian/dashboard copy as authority, and never infer a broader scope than the rule declares.

## Hard invariants

- Stable is the default. Missing, conflicting, timed-out, quota-blocked, or subjective-only evidence means no promotion.
- Three independent `CASE-*` receipts are the minimum to propose, not proof that a candidate is better.
- “Independent” means distinct case ID, session hash, and turn coordinates; one failure split into multiple rows still counts once.
- Select the failure mechanism from the plugin's predeclared taxonomy and require matching structured evidence. Ambiguous, mixed, or model-inferred-only classification stays in observation and cannot count toward the three-case threshold; the plugin must enforce this deterministically.
- Stable/candidate paired runs, all golden fixtures, pre-existing held-out fixtures, deterministic safety checks, and strict primary-metric improvement are mandatory.
- One critical regression blocks promotion. Average improvement cannot offset safety, privacy, approval, or critical-quality loss.
- Candidate rules and evaluation reports stay in protected non-discovery state; only a journaled promotion may append one validated rule to the protected stable strategy reference.
- If a project `.dsh/skills/optimize-work-strategy` exists, or doctor cannot prove which copy Harness resolved, stop every evolution action except `evolution_status` and the read-only doctor. Never load rules from the project copy.
- Never bypass the tools by directly editing `strategies.yaml` or another stable Skill reference.
- Never edit this stable core, plugin source, tool registrations, permissions, provider/model settings, credentials, Harness official files, or model parameters.

## Workflow

1. Call `evolution_status` before any mutating tool. Stop if health or ledger integrity is degraded.
2. Call `evolution_review` only with at least three independent receipt IDs for the same failure mechanism. Keep unknown, duplicate, or contradictory cases in observation.
3. Call `evolution_propose` once for one narrow, non-overlapping mechanism. Lock the lower-is-better primary metric before any candidate result is visible; do not switch metrics after evaluation or generalize beyond the evidence scope.
4. Call `evolution_validate`. The plugin must compare stable and candidate under identical model, provider, tools, permissions, input, and budget. Treat `inconclusive`, tie, disagreement, omitted golden cases, or any regression as failure.
5. Show the generated `EVO-*` approval card: exact diff, content/baseline/report hashes, support and held-out results, guardrails, cost, uncertainty, and rollback condition.
6. Do not call `evolution_promote` until the user explicitly approves that exact `EVO-*` identifier in the current task. “可以”“继续”“通过” without the identifier is not promotion approval.
7. Pass only `candidate_id` to `evolution_promote`. The promoter must recheck the receipt chain and head/count anchor, candidate content hash, stable Skill/catalog/fixture/policy/evaluator binding, complete validation-report hash, baseline hash, lock, journal, backup, and postcondition because state may have changed after `evolution_status`. Harness's mounted `tools/pre-execute` approval prompt is the final one-time execution gate; if doctor has not proved the hook is mounted, stop. Never simulate or bypass it.
8. Report code completion, tests, installation, Harness mounting, real-call validation, promotion, observation, quarantine, and rollback as separate states.

## V1 layer boundary

- Memory: privacy-minimized receipts and append-only experience ledgers.
- Policy: evidence-bound append-only strategy rules.
- Skill: validated rules become stable only after exact human approval.
- Tool: never self-register or self-modify tools; a tool change can only be a future proposal requiring separate code review and authorization.
- Model: no SFT, RL, weight update, provider change, or model switch.

## Stop conditions

Stop and keep stable when there are fewer than three cases, no pre-existing held-out/golden coverage, a stale baseline hash, an unknown lock, an evaluation budget failure, comparator disagreement, or an unverified critical result. Model self-evaluation and one reflection never constitute self-evolution.

“We can roll back later,” “it is only a small append,” “the proposer says it is better,” and “the user is in a hurry” never replace pre-promotion evidence or exact approval.
