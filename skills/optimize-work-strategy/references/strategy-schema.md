# Strategy catalog schema v1

`strategies.yaml` uses the strict JSON subset of YAML 1.2 for deterministic parsing.

The catalog contains `schemaVersion`, non-negative `stableVersion`, and an ordered `rules` array. Every stable rule has an `STR-NNNN` identifier, narrow task kinds and failure mechanisms, one action, one anti-pattern, at least three independent evidence case IDs, a precommitted lower-is-better primary metric, baseline/candidate values, and its exact `EVO-*` source candidate.

Stable rules are immutable. V1 may append only one non-overlapping rule per approved promotion. Missing or ambiguous evidence leaves the catalog unchanged.
