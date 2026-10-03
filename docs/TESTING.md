# Testing

`.github/workflows/test.yml` is the authoritative release matrix. This file explains how to reproduce it locally and which suites need PostgreSQL.

> **Skips exit 0.** Node's test runner treats a skipped test as passing. Without the database variables below, `npm test` reports green with about 30 skipped PostgreSQL and live-network tests. Always read `# skipped` in the TAP summary. On an unchanged `origin/main` with no database, `npm test` reports `# tests 1445 / # pass 1415 / # fail 0 / # skipped 30` (Node 22, 2026-10-02). Making these skips fail loudly is follow-up work; see the end of this file.

## No database required

Run from the repository root after `npm ci`.

| Suite | Command | Notes |
|---|---|---|
| Root and package Node tests | `npm test` | Glob: `test/*.test.js packages/*/test/*.test.js integrations/*/test/*.test.js`. Includes the Gate server and Bankr tests. PostgreSQL files skip. |
| Gate server only | `node --test packages/server/test/*.test.js` | Same PostgreSQL skips (19) |
| Single file | `node --test packages/server/test/observability.test.js` | Fastest inner loop |
| CLI workspace | `npm test --workspace @gavel/cli` | Also matched by the root glob; CI runs it separately |
| TUI | `npm run tui:typecheck` | TypeScript only, no tests |
| Gate web | `npm run gate-web:test && npm run gate-web:typecheck && npm run gate-web:build` | Vitest. **Not** covered by the root glob. |
| Contracts | `cd contracts/gate && forge test -vvv && forge fmt --check && forge build --sizes` | Foundry; not in the Node workflow |
| CI shape guard | `node --test packages/server/test/postgres-ci.test.js` | Fails if the workflow's PostgreSQL gate is weakened |

## PostgreSQL required

There are two independent guards with different variables. Both suites are **destructive**: they create schemas and roles and run migrations. Only point them at a dedicated, throwaway database.

### Gate store suites (`packages/server`)

Files (CI runs them serialized in one step):

- `packages/server/test/gate-store-postgres.test.js`
- `packages/server/test/gate-reservation-lifecycle-postgres.test.js`
- `packages/server/test/durable-persistence.test.js`
- `packages/server/test/auth-session-environment.test.js`

There are two gates, and both must pass.

1. **Skip gate**, in each file. Every test skips unless `GAVEL_GATE_TEST_DATABASE_URL` is set, `GAVEL_GATE_TEST_DATABASE_DISPOSABLE=yes`, and the database name ends in `_test` or `_disposable`.
2. **Attestation gate.** Most of these tests open their pool through `attestedPool(url, …, "gavel_gate")` in `test/disposable-database.js`. Passing the skip gate is therefore **not enough**. With partial setup, the tests run and fail with `refusing destructive PostgreSQL tests: disposable target proof missing`.

The full requirements:

| Variable | Requirement |
|---|---|
| `GAVEL_GATE_TEST_DATABASE_URL` | `postgres://` or `postgresql://`. Host must be `127.0.0.1` or `postgres`. Database matching `^gavel_gate_[a-z0-9_]+_disposable$`. **No query string**, so Unix-socket `?host=` URLs are rejected. |
| `GAVEL_GATE_TEST_DATABASE_DISPOSABLE` | Exactly `yes` |
| `GAVEL_TEST_DISPOSABLE_OPT_IN` | Exactly `I_UNDERSTAND_DISPOSABLE_DB` |
| `GAVEL_TEST_DATABASE_NONCE` | 32 hex characters; the database comment must be `gavel-disposable:<nonce>` |
| `GAVEL_TEST_CLUSTER_ID` | `pg_control_system().system_identifier` of the cluster that answers |
| Cluster file | `$PGDATA/gavel-disposable-cluster.attestation` containing the nonce, readable through `pg_read_file` |

Writing into `$PGDATA` means a throwaway PostgreSQL 16 **container**, not the host cluster. Reproduce the CI steps "Create disposable Gate database" and "Attest isolated Gate and governance test databases" from `.github/workflows/test.yml`, then run:

```bash
# after exporting the attestation variables above, against the container on 127.0.0.1:5432
GAVEL_GATE_TEST_DATABASE_URL='postgres://postgres:<password>@127.0.0.1:5432/gavel_gate_ci_disposable' \
GAVEL_GATE_TEST_DATABASE_DISPOSABLE=yes \
node --test --test-concurrency=1 \
  packages/server/test/gate-store-postgres.test.js \
  packages/server/test/gate-reservation-lifecycle-postgres.test.js \
  packages/server/test/durable-persistence.test.js \
  packages/server/test/auth-session-environment.test.js
```

- Keep `--test-concurrency=1`. These files reset the same schema, and running them in parallel produces bogus auth or catalog failures.
- Tests that `SET ROLE` need the runner to be a member of the Gate application roles.
- Pass criterion: exit 0 **and** `# skipped 0`. CI enforces this with `grep -Eq '# skipped [1-9]|# SKIP'`.
- Verified on 2026-10-02: a host-cluster Unix-socket URL with only the two `GAVEL_GATE_*` variables gave `# pass 15 / # fail 19`, all failures being the attestation refusal. Older agent instructions recommending `postgresql:///db?host=/var/run/postgresql` for this suite are stale.

### Governance index suite (`test/governance-index-postgres.test.js`)

It uses `test/disposable-database.js` (`attestedPool`), which proves both the database and the cluster before running any DDL.

| Variable | Requirement |
|---|---|
| `GAVEL_TEST_DATABASE_URL` | Host `127.0.0.1` or `postgres`, database name `gavel_test_<x>_disposable`, no query string |
| `GAVEL_TEST_DISPOSABLE_OPT_IN` | Exactly `I_UNDERSTAND_DISPOSABLE_DB` |
| `GAVEL_TEST_DATABASE_NONCE` | 32 hex characters, equal to the database comment `gavel-disposable:<nonce>` |
| `GAVEL_TEST_CLUSTER_ID` | `pg_control_system().system_identifier`; the cluster must contain `$PGDATA/gavel-disposable-cluster.attestation` holding the nonce |

- If `GAVEL_TEST_DATABASE_URL` is unset, the suite skips (9 tests).
- If it is set but the opt-in or URL shape is wrong, the module throws at load. A wrong nonce or cluster id fails each test with `cluster attestation mismatch`. Either way the exit is nonzero.
- Both guards also reject URLs containing a `#fragment`.
- The setup requires writing into `$PGDATA`, so in practice use a container rather than the host cluster. Reproduce with the "Attest isolated Gate and governance test databases" step in `test.yml`.
- `test/e2e_postgres_guard.py` runs the same suite in isolated Docker containers. It expects a prebuilt image named in the script.

### Full local release order

1. No-database matrix above.
2. Gate PostgreSQL step with zero skips.
3. `npm test` with **only** the governance-index `GAVEL_TEST_*` variables set, as CI does. About 21 skips remain: 19 Gate PostgreSQL tests (already proven in step 2) and 2 live-network tests. Do **not** export `GAVEL_GATE_*` for root `npm test`, because the root glob would then run the destructive Gate files concurrently.
4. Gate web test, typecheck and build; Foundry.

## Live-network suites (opt-in, not in CI)

| File | Opt-in |
|---|---|
| `test/safe-live-integration.test.js` | `GAVEL_SAFE_INTEGRATION_TEST=1` plus `GAVEL_SAFE_TEST_*` (RPC, Safe service, reviewed fixture) |
| `test/mainnet-fork.test.js` | `MAINNET_FORK_RPC_URL` plus `GAVEL_FORK_*` |

Never run these against funded production identities as part of ordinary development.

## Follow-up (not in this change)

- Add `npm run test:pg:gate` / `test:pg:index` scripts that default the disposable names, refuse to run when PostgreSQL is unreachable, and fail on any `# skipped`.
- Have the plain `npm test` print a loud banner, or fail under `CI=true`, when PostgreSQL suites skip.
