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

The root `gavel` executable remains the canonical CLI. This package exposes
`gavel-tui` when built, avoiding a binary-name collision.

See [TUI_MIGRATION.md](../../docs/architecture/TUI_MIGRATION.md) for provenance,
current limitations, and the replacement sequence.

