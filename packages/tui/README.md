# Gavel terminal UI

This package is the in-progress monorepo migration of
[`jgramajo4/Gavel-TUI`](https://github.com/jgramajo4/Gavel-TUI), imported from
commit `39ddf1e8fbb2f378b0b62c44df206dcfa4900466`.

It is now a multi-DAO governance client rather than a Nouns TUI: the home
screen is a unified inbox across whichever DAOs you follow, and every
DAO-specific behaviour comes from the catalog and the adapters rather than
from the screens. See
[MULTI_DAO_CLIENT.md](../../docs/architecture/MULTI_DAO_CLIENT.md).

It holds no signing material. `src/config.ts` has no key field at all and the
old `makeSigner()` is gone; signing authority reaches the TUI only through a
wallet provider in `@gavel/core`, which holds a reference to a signer the host
already has.

```bash
npm run tui:typecheck
npm run tui
```

## Configuration

Followed DAOs, wallet connection, execution mode, inference, privacy and
notifications live in the shared Gavel config under `GAVEL_DATA_DIR`, which
the CLI reads and writes too:

```bash
gavel daos list --json          # the same catalog the wizard shows
gavel daos follow ens
gavel wallet status --json
gavel readiness --json          # runtime + per-DAO monitor/analyze/vote
gavel config show --json        # redacted
```

On first launch the TUI runs the setup wizard; afterwards the same settings
are editable from `s` on the inbox. Changing which DAOs you follow never
requires re-running the wizard.

## What is DAO-specific, and where

Most of the package is DAO-agnostic. The exceptions are explicit and confined:

| Module | Scope |
| --- | --- |
| `chain/daoReaders.ts` | which DAOs this build can read directly from chain |
| `data/votes.ts`, `data/subgraph.ts`, `actions/*.ts` | Nouns contracts and the Nouns subgraph |
| `components/RewardsBadge.tsx` | the Nouns client-rewards balance, rendered only when Nouns is followed |
| `screens/Passport*.tsx` | the Nouns builder passport (EAS) |

A DAO with no chain reader is not broken: its proposals, tallies and state
come from the governance index, and its votes and delegation are prepared
through the canonical CLI path. What is missing is the live in-terminal poll,
and the detail screen says so rather than reading another DAO's governor. A
test enforces that no other module mentions a DAO by name.

## Data sources

| Variable | Effect |
| --- | --- |
| `GAVEL_DATA_DIR` | Private data directory: preferences, followed DAOs, local history. Never secrets |
| `GAVEL_INDEX_API_URL` | Governance index, read per followed DAO. Defaults to the public index; set it empty to opt back to the Nouns subgraph |
| `SUBGRAPH_URL` | Nouns subgraph, used by the Nouns delegate view and as the index opt-out |
| `RPC_URL` | Ethereum endpoint for live tallies and contract reads |

Indexed reads fail closed: an index with no checkpoint, a source reporting a
sync error, or a checkpoint older than one hour surfaces as an error instead of
a silently short proposal list. Each followed DAO is read independently, so one
failing indexer shows as one unavailable row in the inbox rather than an empty
client. Delegation is not ingested by the index, so the delegate view stays on
the subgraph.

The proposal list is the batchable, indexed read; live tallies and transaction
construction stay on RPC. The delegate view stays on the subgraph because the
index does not ingest delegation. `DEFAULTS.INDEX_API_URL` must match
`DEFAULT_INDEX_API_URL` in `packages/governance-index`; a test enforces that.

The root `gavel` executable remains the canonical CLI. This package exposes
`gavel-tui` when built, avoiding a binary-name collision.

See [TUI_MIGRATION.md](../../docs/architecture/TUI_MIGRATION.md) for provenance,
current limitations, and the replacement sequence.

