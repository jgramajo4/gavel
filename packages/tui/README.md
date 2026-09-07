# Gavel terminal UI

This package is the in-progress monorepo migration of
[`jgramajo4/Gavel-TUI`](https://github.com/jgramajo4/Gavel-TUI), imported from
commit `39ddf1e8fbb2f378b0b62c44df206dcfa4900466`.

The first slice preserves the Ink screens, navigation, polling, formatting, and
supporting modules so they can be migrated incrementally. It is intentionally
read-only: `src/config.ts` does not load `GAVEL_PRIVATE_KEY`, and the legacy
direct vote, delegation, and attestation actions must not be re-enabled.

```bash
npm run tui:typecheck
npm run tui
```

## Data sources

| Variable | Effect |
| --- | --- |
| `GAVEL_INDEX_API_URL` | Governance index for the proposal list. Defaults to the public index; set it empty to opt back to the subgraph |
| `SUBGRAPH_URL` | Subgraph used by the delegate view, and by the proposal list when the index is opted out |
| `RPC_URL` | Ethereum endpoint for live tallies and contract reads |

Indexed reads fail closed: an index with no checkpoint, a source reporting a
sync error, or a checkpoint older than one hour surfaces as an error instead of
a silently short proposal list. Delegation is not ingested by the index, so the
delegate view stays on the subgraph.

The proposal list is the batchable, indexed read; live tallies and transaction
construction stay on RPC. The delegate view stays on the subgraph because the
index does not ingest delegation. `DEFAULTS.INDEX_API_URL` must match
`DEFAULT_INDEX_API_URL` in `packages/governance-index`; a test enforces that.

The root `gavel` executable remains the canonical CLI. This package exposes
`gavel-tui` when built, avoiding a binary-name collision.

See [TUI_MIGRATION.md](../../docs/architecture/TUI_MIGRATION.md) for provenance,
current limitations, and the replacement sequence.

