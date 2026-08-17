# Strategy catalog schema v1

`strategies.yaml` deliberately uses the strict JSON subset of YAML 1.2. The workbench rejects comments, aliases, tags, duplicate keys, unknown fields, and other permissive YAML features so the machine-managed file has one deterministic interpretation.

The catalog contains exactly:

- `schemaVersion`: must be `1`.
- `stableVersion`: non-negative integer, incremented only after an approved atomic promotion.
- `rules`: ordered array of stable strategy rules.

Each rule contains exactly:

- `id`: `STR-NNNN`.
- `status`: `stable` in the formal catalog; an isolated proposal uses `candidate` until promotion.
- `appliesWhen.taskKinds`: non-empty, unique task-kind list.
- `appliesWhen.failureMechanisms`: non-empty, unique failure-mechanism list.
- `action`: one narrow action to add.
- `avoid`: the corresponding anti-pattern.
- `evidenceCaseIds`: at least three unique, independent `CASE-*` receipts sharing the same mechanism.
- `primaryMetric`: the predeclared error or rework metric.
- `baselineValue`: stable-version value; lower is better.
- `candidateValue`: candidate value; it must be strictly lower before promotion.
- `introducedBy`: exact `EVO-YYYYMMDD-NNN` candidate id.

## Monotonic rules

1. Stable rules are immutable: no deletion, reordering, weakening, field change, or status change.
2. V1 may append only one candidate rule at a time.
3. A new rule must not share both a task kind and a failure mechanism with an existing stable rule.
4. Three real receipts are a proposal threshold, not proof of improvement.
5. Promotion also requires paired stable/candidate evaluation, at least three sanitized support fixtures, at least two pre-existing held-out fixtures, all golden fixtures, non-inferior safety/quality guardrails, and strict primary-metric improvement.
6. Missing, ambiguous, contradictory, or non-reproducible evidence keeps the current stable catalog unchanged.

## Evidence classes

- `confirmed`: deterministic assertion, reproducible external check, or explicit human confirmation.
- `supported`: repeated receipts with the same mechanism, sufficient to propose but not promote.
- `subjective`: blind model comparison; useful only with the deterministic gates and human approval.
- `unknown`: incomplete or conflicting evidence; observe only.

This file contains no credentials, user prompts, tool arguments, private source content, external account data, or absolute machine paths.
