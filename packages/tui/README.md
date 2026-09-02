# TUI consolidation boundary

The Ink TUI currently lives in `jgramajo4/Gavel-TUI`. Its interface components,
screens, navigation, polling, and presentation helpers can move here after the
headless package contracts settle.

Do not migrate its separate subgraph models, PASS/FAIL predictor, cache,
addresses/ABIs, direct private-key vote/delegation code, or proposal-state
logic. Replace those modules with `@gavel/core`, `@gavel/nouns-adapter`, or
structured `gavel` CLI calls. See
[`../../docs/architecture/MONOREPO_AUDIT_AND_PLAN.md`](../../docs/architecture/MONOREPO_AUDIT_AND_PLAN.md).
