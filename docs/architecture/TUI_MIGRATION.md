# TUI migration

## Baseline

- Source repository: `jgramajo4/Gavel-TUI`
- Source commit: `39ddf1e8fbb2f378b0b62c44df206dcfa4900466`
- Target package: `packages/tui`
- License: GPL-3.0-only at the monorepo distribution boundary

The standalone repository remains untouched during this migration.

## Phase 1: source import

This phase imports the application into the existing workspace and keeps its
`gavel-tui` binary distinct from the canonical `gavel` CLI. The legacy
Foundry wizard is not imported because it exports a private key into the
application process.

Direct signing is disabled in `packages/tui/src/config.ts`: application
configuration never loads `GAVEL_PRIVATE_KEY`. The existing action modules are
retained only as migration references while the UI is rewired to canonical
preparation and a canonical wallet handoff.

## Replacement checklist

- [x] Import Ink screens, components, navigation, hooks, and formatting.
- [x] Import the TypeScript build and workspace dependency metadata.
- [x] Disable environment-private-key loading.
- [x] Add TUI typechecking to pull-request CI.
- [ ] Replace proposal ingestion and tally reads with `@gavel/nouns-adapter`.
- [ ] Replace PASS/FAIL prediction wiring with personalized Gavel analysis;
      retain outcome forecasting only as a separately labeled signal.
- [ ] Replace duplicated addresses and ABIs with the canonical adapter.
- [ ] Replace vote/delegation actions with canonical preparation plus an
      explicit local wallet handoff.
- [ ] Decide whether Passport/EAS and rewards UI remain in Gavel's product scope.
- [ ] Remove transitional data, chain, and action modules after their consumers
      use canonical package contracts.
- [ ] Archive the standalone repository only after feature and release parity.

## Safety boundary

A TUI interaction may request analysis or transaction preparation, but it is not
authorization to submit a transaction. Unknown RPC state, proposal drift,
delegation mismatch, or a canonical preparation block must stop the flow.
