# Gavel agent rules

Gavel is an npm-workspaces monorepo: governance CLI/TUI, Gate paid-attention server, self-hosted governance index, Gate web app, Base splitter contract, and Bankr/Hermes skill packages.

## Repository authority

- Forgejo `origin` (`ssh://forgejo/gramajo/gavel.git`, web `http://eros:3003/gramajo/gavel`) is authoritative. Branch, push, open PRs, and review there.
- GitHub `github` (`jgramajo4/gavel`) is the publication mirror only. Publish reviewed Forgejo `main` to it; never develop against it or pull GitHub-only commits into Forgejo. Public install docs correctly point at GitHub.
- Forgejo PR numbers are not GitHub PR numbers or plan-slice numbers. Do not use `gh` for development PRs.
- Check parity with `scripts/repo-sync-status.sh`; read a PR with `scripts/forgejo-pr.sh <n>`.

## Checkouts

- `/home/pi/workspace/gavel` is a long-lived, dirty, non-`main` checkout. Never implement, review, stash, reset, or check out branches there.
- New work: `git -C /home/pi/workspace/gavel fetch origin && git -C /home/pi/workspace/gavel worktree add -b <branch> /home/pi/workspace/gavel-<slug> origin/main`, then `npm ci` in the new worktree.
- Reviews: reuse a clean worktree at the exact PR head, or create a detached one.

## Map

| Path | What lives there |
|---|---|
| `packages/server` | Canonical Gate HTTP server, workers, PostgreSQL store, `migrations/001_gate.sql` |
| `packages/gate` | Pure Gate domain: quote/EIP-712, enrollment, submission policy, settlement log decoding |
| `packages/governance-index` | Indexer worker, read-only index API, `IndexApiClient`, its migrations |
| `packages/cli`, `packages/tui`, `packages/core` | Voter CLI, Ink TUI, voter/profile/prediction/execution core |
| `apps/gate-web` | Gate React app (Vitest) |
| `contracts/gate` | Foundry `GavelGateSplitter` |
| `integrations/bankr`, `integrations/hermes` | Shipped agent skills; Bankr payer client |

Use `docs/CODEMAP.md` to find a file or symbol before opening large files.

## Canonical docs

1. `docs/GAVEL_GATE_TECHNICAL_SPEC.md` and `docs/GAVEL_GATE_MVP_DECISIONS.md` are normative for Gate. They beat `docs/plans/*`; report conflicts instead of following the plan.
2. `docs/gate/INVARIANTS.md`: durable Gate security, persistence, and migration rules.
3. `docs/TESTING.md`: suites, environment variables, disposable PostgreSQL.
4. `docs/deployment/*`: operator runbooks. Deployment is outside coding work.
5. `packages/governance-index/README.md`: index configuration and operations.

## Tests

- No database: `npm test` (root glob) plus `npm test --workspace @gavel/cli`, `npm run tui:typecheck`, and `npm run gate-web:test`, `gate-web:typecheck`, `gate-web:build`.
- Gate PostgreSQL and governance-index PostgreSQL suites need attested disposable databases (in practice a throwaway container). They **skip and still exit 0** without the variables. Read the `# skipped` count; see `docs/TESTING.md`.
- `.github/workflows/test.yml` is the authoritative release matrix.

## Rules

- Read source, tests, migrations, and call sites before changing behavior. Fail closed on ambiguous identity, provenance, chain, or authorization.
- Payment, quote issuance, settlement verification, and inbox creation stay in `packages/server`. CLI, web, Hermes, and Bankr are thin HTTP clients.
- `packages/cli/bin/gavel.js` must not require `../src/...`; `test/architecture-boundaries.test.js` enforces this.
- Schema changes require disposable-PostgreSQL proof and checksum/manifest updates. Never touch staging or production from development work.
- Never log or commit secrets. Use non-secret placeholders such as `CHANGE_ME` in env examples, not `***`.
- Do not merge, publish to GitHub, or deploy without explicit authorization.
