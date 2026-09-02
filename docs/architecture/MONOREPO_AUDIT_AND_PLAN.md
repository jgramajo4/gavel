# Monorepo audit and staged implementation plan

Audit date: 2026-09-02

Gavel baseline: `8401667` (`main`)

TUI baseline: `jgramajo4/Gavel-TUI@claude/spec-based-build-q9zwci`

The pre-refactor baseline passes 65 tests; the opt-in mainnet-fork test is
skipped without its fixture environment. This document records the audit made
before changing package boundaries.

## Current ownership map

### `packages/core`

Move the existing governance-neutral modules from `src/core/` without rewriting
their behavior:

- `backtest/`: chronology, calibration, metrics, and the expanding-window runner;
- `history/adapter.js`: the governance history port;
- `operations/failure.js`: safe operational error classification;
- `predict/`: confidence, precedent similarity/retrieval, vote prediction, and reason drafting;
- `profile/`: onboarding, profile construction, policy layering, recency, features, and voice;
- `schema/`: governance, profile, prediction, security, backtest, and preparation schemas;
- `security/content.js`: governance-neutral untrusted-content handling.

The one existing inward-dependency violation is
`src/core/predict/predict.js -> src/adapters/nouns/security.js`. Replace it with
an injected proposal inspection result/callback so core remains DAO-neutral.

Add the smallest cross-cutting abstractions here: explicit address roles, DAO
capabilities/registry, immutable prepared transactions, readiness calculation,
executor status/result types, and configurable private-state paths.

### `packages/nouns-adapter`

Move `src/adapters/nouns/{history,freshness,security,vote}.js` here. They already
contain the canonical Nouns subgraph normalization, proposal-event freshness,
action inspection, contract addresses/ABIs, receipt checks, snapshot voting
power, delegation checks, simulation, and client ID 38 vote calldata.

Add a stable `NounsDaoAdapter` facade and unsigned delegation preparation. Keep
legacy scripts only as compatibility entry points; do not use their direct
private-key broadcast model as the new executor foundation.

### `packages/cli`

Move `bin/gavel.js` here and preserve `bin/gavel.js` as a compatibility shim.
The existing commands are already JSON-producing and should remain compatible.
Add `GAVEL_DATA_DIR`, `execution-status`, and `prepare-delegation`. The CLI calls
core and registered DAO adapters; it must not contain governance logic.

### `integrations/bankr`

The Bankr-specific material is currently `nouns-dao/SKILL.md`,
`nouns-dao/references/bankr-runtime.md`, the `/cli/gavel` command examples in the
remaining references, and Bankr-specific UX/routing tests. Create a thin
integration package that owns installation/persistence guidance and points to
the canonical CLI. Preserve the root `nouns-dao/` skill for installed-user
compatibility during the migration.

The scripts under `nouns-dao/scripts/` mix read-only Nouns utilities with legacy
direct signing (`AGENT_PRIVATE_KEY`). They remain clearly marked legacy; new
prediction, validation, preparation, and execution code must not call them.

### `integrations/hermes`

Create `SKILL.md`, installation and persistent-state instructions, a CLI health
check, executor environment guidance, and a documented smoke flow:

`history -> profile -> proposal -> predict -> prepare-vote -> unsigned/Safe`.

It must shell out to the stable `gavel` CLI and store state in a Hermes-selected
`GAVEL_DATA_DIR`; it owns no prediction, storage, Nouns, or transaction logic.

### `packages/tui`

The separate GPL-3.0-or-later TUI is an Ink/TypeScript interface and can be
consolidated without an obvious license conflict once this repository adopts
GPL-3.0. It currently duplicates canonical functionality in these files:

- `src/data/subgraph.ts`: proposal ingestion and delegate/vote history;
- `src/data/prediction.ts`: a separate PASS/FAIL model and private cache path;
- `src/data/votes.ts`: Nouns proposal state/tally contract reads;
- `src/actions/vote.ts`: direct vote calldata selection and private-key broadcast;
- `src/actions/delegate.ts`: delegation reads and private-key broadcast;
- `src/constants.ts` and `src/chain/abis.ts`: canonical addresses, client ID, and ABIs;
- `src/config.ts` and `src/chain/clients.ts`: `GAVEL_PRIVATE_KEY` signing authority;
- `src/types.ts`: proposal, prediction, vote, and delegate domain models.

During consolidation, keep Ink components, screens, navigation, polling, and
formatting in `packages/tui`; replace the items above with canonical package APIs
or structured CLI calls. Passport/EAS and rewards UI are separate product-scope
decisions and must not leak into core governance intelligence.

### `packages/server` and `tools/admin`

Reserve a minimal optional server package; do not make core depend on it.
`tools/admin/nouns-rewards` is already correctly isolated and retains its
explicit `GAVEL_ADMIN_MODE=1` boundary.

## Safe migration sequence

1. Establish npm workspaces and physically move core, Nouns, and CLI code.
2. Keep the root CLI shim and all command names while updating tests to canonical paths.
3. Remove the core-to-Nouns import through dependency injection and add a boundary test.
4. Introduce `GAVEL_DATA_DIR` while retaining `./data/private` as the default.
5. Add explicit address roles and Nouns readiness/delegation preparation.
6. Add immutable executor inputs, unsigned, Safe proposer-only, and policy-gated WaaP executors.
7. Add Bankr/Hermes integration smoke and regression tests.
8. Scaffold TUI/server package boundaries; migrate the TUI later, screen by screen.
9. Keep legacy direct-signing scripts available but excluded from canonical execution.

Each boundary lands with tests before the next boundary. RPC, proposal freshness,
delegation, voting power, executor mutation, unsupported actions, and unsupported
autonomy all fail closed.
