# Terra Deployment Handoff — Gavel Governance Index

## Release boundary

- Repository: `jgramajo4/gavel`
- Implementation branch: `feat/governance-index`
- Baseline: `3055ec140e9eaf3295ce8168213d3ee18714f8fa`
- Deployment rule: deploy the merged commit, never a mutable working tree

The canonical deployment artifacts are owned by the Gavel repository:

- `Dockerfile`
- `docker-compose.yml`
- `.env.example`
- `packages/governance-index/README.md`
- `packages/governance-index/migrations/001_initial.sql`
- `packages/governance-index/bin/gavel-indexer.js`

Terra may adapt environment values and external ingress/backup configuration. Do not fork application logic into `/srv/docker` scripts.

## 1. What Changed

### New package

`packages/governance-index/` owns:

- PostgreSQL migrations and storage
- source adapters for ENS Governor logs, Railgun Voting logs, and the Nouns subgraph
- restart-safe backfill and incremental synchronization
- trailing replay/reorg reconciliation
- normalized proposal/vote materialization
- paginated read-only HTTP API
- index API client used by Gavel CLI
- structured logging and credential redaction
- operational CLI: `migrate`, `ensure-roles`, `verify-permissions`, `backfill`, `sync`, `status`, `health`, `reconcile`, `serve`, `run`

### Modified packages

- `packages/cli`: DAO-scoped `history`, index API consumption, ENS indexed proposal lookup
- `packages/ens-adapter`: indexed proposal loading plus live Governor verification and fail-closed proposal hash/content checks
- root workspace: package/bin wiring and PostgreSQL dependency lock

### Database migration

`migrate` applies `001_initial.sql`, reconciles the application roles, applies
`002_roles.sql`, and then verifies the resulting privileges before reporting
`"roles": "granted"`. See *Role lifecycle* in section 7.

`001_initial.sql` creates:

- `daos`
- `governance_sources`
- `raw_governance_records`
- `proposals`
- `proposal_actions`
- `vote_events`
- `delegation_events`
- `sync_checkpoints`

`002_roles.sql` applies the least-privilege grants: write access for
`gavel_indexer`, `SELECT` and nothing else for `gavel_api`, and no `CREATE` on
schema `public` for either. It is rerunnable and revokes before it grants, so a
stale write grant cannot survive a redeploy.

### New services

- `postgres`
- one-shot `migrate`
- `api`
- `indexer` with Nouns/ENS/Railgun workers in one process

## 2. Final Architecture

```text
Ethereum logs ───────┐
Nouns subgraph ──────┼──> source adapters ──> raw canonical records
Railgun proposal RPC ┘                │
                                      └──> normalized proposals/vote events
                                                    │
                                                    v
                                               PostgreSQL
                                                    │
                                  ┌─────────────────┴─────────────────┐
                                  v                                   v
                         read-only HTTP API                  indexer operations CLI
                                  │
                         Gavel CLI/core
                                  │
               historyDocumentSchema / normalizedProposalSchema
                                  │
                  private voter model outside this service
                                  │
                    live canonical safety verification
                                  │
                       unsigned vote preparation
```

The index contains public governance data only. Gavel private profiles and signing/execution remain separate.

## 3. Database Schema

- `daos`: DAO identity, chain, governance type, current governor, start block, configuration.
- `governance_sources`: sanitized public source provenance; credential-bearing transport URLs are never persisted.
- `raw_governance_records`: immutable canonical/source payloads sufficient for re-normalization. Onchain identity is `(chain_id, contract_address, transaction_hash, log_index)`; source-native records use `(dao_id, source_id, source_record_key)`.
- `proposals`: normalized proposal document, canonical content hash, state/tallies, timing, first-seen block.
- `proposal_actions`: ordered targets, values, signatures, and calldata.
- `vote_events`: immutable vote events. Railgun events are never collapsed by voter/proposal.
- `delegation_events`: schema exists; ingestion is not implemented.
- `sync_checkpoints`: monotonic next block/finalized head and sanitized last error.

Important indexes cover DAO/proposal lookup, voter history, proposal votes, status, raw external IDs, raw proposal joins, and block replay.

## 4. DAO Coverage

| Capability | Nouns | ENS | Railgun |
|---|---|---|---|
| historical proposals | COMPLETE | COMPLETE | COMPLETE |
| historical vote events | COMPLETE | COMPLETE | COMPLETE |
| delegation history | NOT IMPLEMENTED | NOT IMPLEMENTED | NOT IMPLEMENTED |
| proposal lookup | COMPLETE | COMPLETE | COMPLETE |
| incremental sync | COMPLETE | COMPLETE | COMPLETE |
| raw records | COMPLETE | COMPLETE | PARTIAL — votes canonical; proposal views normalized from live contract |
| normalized records | COMPLETE | COMPLETE | COMPLETE |
| history materialization | COMPLETE | COMPLETE | COMPLETE |
| canonical verification | COMPLETE — existing Nouns path | COMPLETE — hash + Governor views | COMPLETE — existing Railgun live checks |

## 5. External Dependencies

| DAO | Required | Optional / unused |
|---|---|---|
| Nouns | Nouns governance subgraph | Ethereum RPC remains used by existing live vote-safety paths |
| ENS | Ethereum mainnet JSON-RPC with historical log coverage | Tally is not implemented and not required; Snapshot excluded |
| Railgun | Ethereum mainnet JSON-RPC; Voting creation block pinned to `15505853` | `RAILGUN_FROM_BLOCK` may override the pin; IPFS expansion is not implemented |

Tally variables are reserved only. Tally is not a durable or required source in this release.

## 6. RPC Efficiency

Two distinct passes:

**Full enumeration** — every proposal is re-read. Runs on `backfill`, on any
`sync --full`, and otherwise at most once per `INDEXER_FULL_SCAN_INTERVAL_SECONDS`
(default 21600, six hours). This is the only pass that may conclude a proposal
has disappeared, so it is the only pass permitted to delete indexed rows.
For ENS it walks `ProposalCreated` from block 13699665 in
`ENS_PROPOSAL_BLOCK_BATCH_SIZE` steps, falling back to `INDEXER_BLOCK_BATCH_SIZE`
and then to 5000: roughly 1870 `eth_getLogs` calls at current mainnet height with
the 5000-block default, or 470 if the provider is confirmed to allow 20000.

**Incremental sync** — the steady state, every `--interval-ms` (default 60s).
Discovery is scoped to the checkpoint range plus the 64-block trailing replay,
and mutable state is re-read only for proposals that are not in a terminal
state (`EXECUTED`, `CANCELLED`, `VETOED`, `EXPIRED`, `DEFEATED`,
`SPONSORSHIP_EXPIRED`). A cycle with 1000 new blocks costs one `eth_getLogs`
plus five view calls per still-open proposal — not a historical rescan.

**Request time** — proposal lookup, proposal lists, vote lists, voter histories,
DAO metadata and sync status are served entirely from PostgreSQL. No API request
and no `gavel history` invocation triggers an RPC call or a historical scan.

**Transaction time** — `prepareVote` still performs full live canonical
verification against the chain for all three DAOs. The index never substitutes
for it.

Budget accordingly: the sustained cost is the incremental figure; the full
enumeration spike happens on backfill and every six hours.

### Block ranges and RPC provider limits

Hosted RPC providers cap the span a single `eth_getLogs` may cover. 10,000 blocks
is the common free-tier ceiling and the repository-default `https://eth.drpc.org`
enforces it, so no scan in the indexer carries a hard-coded range any more.

| Scan | Setting | Default |
|---|---|---|
| ENS `VoteCast` + `ProposalCreated` range replay | `INDEXER_BLOCK_BATCH_SIZE` | 5000 |
| Railgun `VoteCast` range replay | `INDEXER_BLOCK_BATCH_SIZE` | 5000 |
| ENS `ProposalCreated` discovery and backfill | `ENS_PROPOSAL_BLOCK_BATCH_SIZE`, else `INDEXER_BLOCK_BATCH_SIZE` | 5000 |
| Nouns | none — subgraph pagination, not `eth_getLogs` | `pageSize` 500 |

Effective precedence for ENS proposal discovery:

```
ENS_PROPOSAL_BLOCK_BATCH_SIZE  ->  INDEXER_BLOCK_BATCH_SIZE  ->  5000
```

Rules that apply to both variables:

- an unset or empty value falls through to the next source
- a value that is set but is not a positive decimal integer aborts startup with
  the offending variable named; it never falls through
- the resolved values are emitted once per process as the `rpc_block_ranges`
  structured log line, so the deployed configuration is observable

Example ENS backfill request ranges at the 5000-block default, from the safe
lower bound 13699665:

```
eth_getLogs fromBlock=13699665 toBlock=13704664
eth_getLogs fromBlock=13704665 toBlock=13709664
eth_getLogs fromBlock=13709665 toBlock=13714664
...
eth_getLogs fromBlock=<finalized head - remainder> toBlock=<finalized head>
```

Every span is 5000 blocks except the final partial one, which is clamped to the
finalized head. Railgun requires no setting of its own: its only log query is the
shared range replay above, and its proposal enumeration reads `proposalsLength`
and per-proposal views, which carry no block range. Nouns uses the subgraph and is
unaffected by RPC log limits.

`packages/nouns-adapter/src/freshness.js` performs the one remaining log scan
outside the indexer, during `prepareVote`. Its window spans proposal creation to
the checked-at block, which exceeds 10,000 blocks for a normal Nouns voting
period, so it is walked in the same `INDEXER_BLOCK_BATCH_SIZE` spans (default
5000). Splitting the window cannot change its result: the events are re-sorted by
block and log index before the canonical version is derived.

Raise `INDEXER_BLOCK_BATCH_SIZE` only against a provider whose documented limit
you have confirmed. Lowering it costs proportionally more requests and nothing
else; checkpointing, idempotency and reorg replay are independent of it.

## 7. Deployment

### Required configuration

Copy `.env.example` to an operator-owned `.env`, permissions `0600`, and set:

```dotenv
POSTGRES_PASSWORD=<strong-random-secret>
GAVEL_INDEXER_DB_PASSWORD=<different-strong-random-secret>
GAVEL_API_DB_PASSWORD=<different-strong-random-secret>
ETHEREUM_RPC_URL=<credential-bearing-mainnet-rpc-url>
INDEXER_ENABLED_DAOS=nouns,ens
INDEXER_CONFIRMATION_DEPTH=64
INDEXER_BLOCK_BATCH_SIZE=5000
# Optional. Narrows ENS ProposalCreated discovery only; leave unset to inherit
# INDEXER_BLOCK_BATCH_SIZE.
# ENS_PROPOSAL_BLOCK_BATCH_SIZE=
INDEXER_RPC_CONCURRENCY=4
INDEXER_DB_POOL_SIZE=10
INDEXER_FULL_SCAN_INTERVAL_SECONDS=21600
INDEXER_MAX_CHECKPOINT_AGE_SECONDS=900
GAVEL_INDEX_MAX_STALENESS_SECONDS=3600
NOUNS_SUBGRAPH_URL=https://www.nouns.camp/subgraphs/nouns
API_HOST=0.0.0.0
API_PORT=8080
LOG_LEVEL=info
```

To enable Railgun, set:

```dotenv
RAILGUN_FROM_BLOCK=15505853
INDEXER_ENABLED_DAOS=nouns,ens,railgun-eth
```

### Role lifecycle

Two roles carry the least-privilege contract: `gavel_indexer` writes, `gavel_api`
only reads. They are created by two different mechanisms, and both converge on
the same state.

`docker/init-db.sh` runs **only when the PostgreSQL data directory is first
created**. It is the fresh-volume path and nothing else.

Every other deployment — a redeploy, an upgrade, a restore, a reused
`postgres-data` volume — reaches the roles through `migrate`, which:

1. applies the schema,
2. creates any missing application role from `GAVEL_INDEXER_DB_PASSWORD` and
   `GAVEL_API_DB_PASSWORD` (both are passed to the `migrate` service), which is
   why a reused volume no longer has to be wiped or hand-patched,
3. applies `002_roles.sql`,
4. verifies the resulting privileges and only then reports `"roles": "granted"`.

`migrate` never changes the password of a role that already exists, and it never
drops or reassigns one. It is safe to run repeatedly.

The role state is always one of three explicit values:

| `roles` | Meaning | `migrate` exit code |
|---|---|---|
| `granted` | Both roles exist and the verified privileges match the contract | 0 |
| `skipped` | A role is missing and could not be created here; `reason` says why | 2 |
| `invalid` | The grants ran but the resulting privileges are wrong; `violations` lists them | 2 |

`migrate` exits 2 for anything other than `granted`, so a deployment cannot
proceed on a database whose least-privilege roles are not actually configured.
`--allow-missing-roles` suppresses only the exit code, never the reported state.

Verification is performed by acting as the role: inside a transaction that is
always rolled back, `SET LOCAL ROLE` is followed by real `SELECT`, `INSERT`,
`UPDATE`, `DELETE`, and `CREATE TABLE` statements. Only PostgreSQL error
`42501` counts as a refusal; a constraint violation means the privilege was
held. Catalog privileges (`TRUNCATE`, `REFERENCES`, `TRIGGER`, table ownership,
role attributes) are checked alongside, and both have to be clean. Output
reports `"method": "effective"` when the statements were executed as the role,
and `"method": "catalog"` when the connection was not permitted to `SET ROLE`.
A catalog-only result **fails** `verify-permissions` unless
`--allow-catalog-fallback` is passed, because an unproven claim is not a pass.
The compose `migrate` service connects as the bootstrap superuser, so the
normal deployment path always produces `"method": "effective"`.

If a role has to be created out of band, `gavel-indexer ensure-roles` does
exactly the creation step and nothing else:

```bash
docker compose run --rm migrate ensure-roles   # exits 2 if it could not create them
```

### Exact fresh-host sequence

```bash
git clone https://github.com/jgramajo4/gavel.git /srv/docker/gavel-index
cd /srv/docker/gavel-index
git checkout <merged-commit-sha>
cp .env.example .env
chmod 600 .env
# provision values above using Terra's normal secret workflow

docker compose up -d --build postgres
# Applies the schema, reconciles the roles, verifies the grants.
# Must print "roles":"granted"; exits 2 otherwise.
docker compose run --rm migrate

# Prove the API role is read-only before anything is served. Exits 0 only if
# gavel_api could not write when the check actually tried to.
docker compose run --rm migrate verify-permissions --role gavel_api

# Optional: confirm the writer role kept the grants it needs.
docker compose run --rm migrate verify-permissions --role gavel_indexer --expect read-write

# INDEXER_ENABLED_DAOS gates which backfills are possible. With the default
# (nouns,ens) the railgun line below will fail; set the variable first if you
# want Railgun indexed.
docker compose run --rm indexer backfill --dao nouns
docker compose run --rm indexer backfill --dao ens
# INDEXER_ENABLED_DAOS=nouns,ens,railgun-eth docker compose run --rm indexer backfill --dao railgun-eth

docker compose run --rm indexer sync --all
docker compose up -d api indexer

docker compose ps
curl --fail http://127.0.0.1:${API_PORT:-8080}/health
docker compose run --rm indexer status
docker compose run --rm indexer health     # exits 2 if a checkpoint stalled
```

### Update procedure

```bash
cd /srv/docker/gavel-index
docker compose exec -T postgres pg_dump -U gavel -Fc gavel > pre-update-$(date +%F).dump
git fetch origin && git checkout <new-commit-sha>
docker compose build
docker compose run --rm migrate            # creates missing roles, then verifies
docker compose run --rm migrate verify-permissions --role gavel_api
docker compose up -d api indexer
docker compose run --rm indexer health
```

This is also the reused-volume path. A `postgres-data` volume created before the
roles existed does **not** need to be deleted: `migrate` creates them from the
passwords already in `.env` and reports `"rolesCreated"`, leaving indexed data
untouched. The only case needing a manual step is a database whose migration
connection is not a superuser and lacks `CREATEROLE`; `migrate` then reports
`"roles": "skipped"` with the reason, and the roles are created once by hand:

```bash
docker compose exec -T postgres psql -U gavel -d gavel -c \
  "CREATE ROLE gavel_indexer LOGIN PASSWORD '<indexer-secret>';" -c \
  "CREATE ROLE gavel_api LOGIN PASSWORD '<api-secret>';" -c \
  "GRANT CONNECT ON DATABASE gavel TO gavel_indexer, gavel_api;"
docker compose run --rm migrate
```

If the roles exist but their passwords no longer match `.env`, reset them
explicitly — `migrate` will not silently rewrite a credential:

```bash
docker compose exec -T postgres psql -U gavel -d gavel -c \
  "ALTER ROLE gavel_api PASSWORD '<api-secret>';"
```

### Rollback procedure

The index holds only public, rebuildable governance data, so rollback is a
code rollback plus either a restore or a re-backfill.

```bash
cd /srv/docker/gavel-index
docker compose down                        # leaves the postgres-data volume intact
git checkout <previous-known-good-sha>
docker compose build

# Schema rollback is only needed if the new commit changed migrations.
docker compose exec -T postgres pg_restore -U gavel -d gavel --clean --if-exists \
  < pre-update-YYYY-MM-DD.dump

docker compose up -d postgres
docker compose run --rm migrate
docker compose run --rm migrate verify-permissions --role gavel_api
docker compose up -d api indexer
docker compose run --rm indexer health
```

If the dump is unusable, rebuild from scratch instead — nothing in the index is
irreplaceable:

```bash
docker compose down -v                     # destroys the volume and all indexed data
docker compose up -d --build postgres
docker compose run --rm migrate
docker compose run --rm indexer backfill --dao nouns
docker compose run --rm indexer backfill --dao ens
docker compose up -d api indexer
```

Railgun's pin is verified from creation receipt `0xcf73b70bbbc9a4fc322c1d0ed6cdb7ed1728681fbcdb2b44fd8c6812df381cb0`, the official Railgun deployment package, and L2BEAT. Postgres has no host port. The API is the only published service.

### Backup / restore

```bash
cd /srv/docker/gavel-index
docker compose exec -T postgres pg_dump -U gavel -Fc gavel > gavel-$(date +%F).dump

docker compose exec -T postgres pg_restore \
  -U gavel -d gavel --clean --if-exists < gavel-YYYY-MM-DD.dump
```

Backups contain public, rebuildable governance data and checkpoints only. Test restoration before calling backups operational.

## 8. Security Review

Confirmed in code/review:

- no wallet private keys, seed phrases, Safe signers, or signing credentials in the index stack
- no wallet signing or autonomous transaction submission
- no private voter profiles in PostgreSQL
- no Docker socket mount
- no arbitrary shell API
- no public mutation routes; non-GET/HEAD requests return `405`
- no published Postgres port
- database network is internal; indexer has a separate egress network
- app containers run as non-root `node`
- credential-bearing RPC/subgraph transport URLs stay in process environment only; PostgreSQL, backups, logs, checkpoints, and the public API retain only explicit or origin-only public provenance
- upstream errors are redacted before structured logs/checkpoints and masked in public status responses
- the API role's read-only property is proven by exercise, not assumed: `gavel-indexer verify-permissions` executes SELECT/INSERT/UPDATE/DELETE/CREATE as `gavel_api` inside a rolled-back transaction and exits 2 if any write or DDL statement is not refused, if the catalog shows an INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grant, if the role owns a public table or holds a privileged role attribute, or if the check could not act as the role at all
- `migrate` reports the role state it verified (`granted`, `skipped`, or `invalid`) and exits 2 unless the least-privilege roles are genuinely in place
- the CLI refuses to build a history document from an index that has no checkpoint, is reporting a sync error, or is staler than `GAVEL_INDEX_MAX_STALENESS_SECONDS`

These are self-hosting choices for this deployment, not requirements for using Gavel. Ordinary clients — Bankr, Hermes, BYOH harnesses — read the public index at `https://index.gavel.vote` over plain outbound HTTPS, with no Tailscale, no tunnel, no shared secret, and no network configuration of any kind. Nothing in this section applies to them.

For Terra specifically: expose API ingress through Cloudflare Tunnel or the normal reverse proxy rather than a forwarded router port, and keep admin operations (SSH, `gavel-indexer` commands, database access) on Tailscale/SSH only. Clients that should read this deployment instead of the public index set `GAVEL_INDEX_API_URL` to its base URL. That URL carries no credentials: the client sends no authentication and has no header or token mechanism, so any authentication has to be enforced by the ingress boundary itself.

## 9. Tests

Latest coding-host results:

- full repository suite with a real PostgreSQL 16 server: **179 passed, 1 skipped, 0 failed** (180 total)
- same suite without a database: **163 passed, 17 skipped, 0 failed** — the
  PostgreSQL tests skip loudly rather than passing vacuously
- PostgreSQL integration suite: **16 passed** against a real PostgreSQL 16 server
  (`GAVEL_TEST_DATABASE_URL=... node --test test/governance-index-postgres.test.js`),
  covering migration execution, canonical uniqueness, ingest idempotency,
  checkpoint atomicity under a failed batch, reorg replay deletion, credential
  redaction, role provisioning on a fresh database, role recovery on an existing
  database with indexed rows preserved, honest reporting when roles cannot be
  created, the `verify-permissions` exit codes for a correct and for an
  overprivileged `gavel_api`, refusal to pass on catalog-only evidence, and a
  wire-level proof that `gavel_api` receives `permission denied` on
  INSERT/UPDATE/DELETE/TRUNCATE/CREATE/ALTER/DROP while SELECT succeeds
- skipped without that variable set, so a run without a database does not
  silently pass; GitHub Actions now starts a `postgres:16-alpine` service and
  sets `GAVEL_TEST_DATABASE_URL`, so these tests run on every pull request
- `npm audit`: zero vulnerabilities
- clean production dependency tree after `npm ci --omit=dev`
- API smoke: `/health` returned `200`; mutation request returned `405`
- Compose static checks: private Postgres, internal DB network, external indexer egress, consistent credentials, health checks
- `git diff --check`: passed

Skipped without external infrastructure: the live mainnet-fork test, and the sixteen PostgreSQL integration tests when `GAVEL_TEST_DATABASE_URL` is unset.

Terra must still execute real Docker/PostgreSQL migration, backfill, API, reboot, backup/restore, and network-isolation tests.

## 10. Known Limitations

- Terra runtime deployment is not yet validated.
- The incremental Nouns discovery query uses the subgraph filters
  `createdBlock_gte` and `id_in`. These still could not be exercised against the
  live subgraph from the coding host — egress to `www.nouns.camp` is refused by
  the network policy there — so they remain fixture-tested only. The query is
  unchanged by this patch. The full enumeration path is unchanged and known
  good, and a rejected filter fails the sync loudly rather than returning
  partial data — but this remains a real deployment gate: confirm the first
  incremental Nouns cycle succeeds on Terra before leaving it unattended.
- `INDEXER_CONFIRMATION_DEPTH` defaults to 64. A reorg deeper than the
  confirmation depth plus the 64-block replay window would leave orphaned rows
  that no incremental pass detects; recover with
  `gavel-indexer backfill --dao <dao> --from-block <before the reorg>`.
- The Nouns raw vote `log_index` is derived from a hash of the subgraph vote id
  rather than a real receipt log index. Two Nouns votes in one transaction whose
  hashes collide now raise a unique-violation sync error instead of dropping a
  vote silently, but the synthetic value should be replaced with the real one.
- `GET /v1/daos/:dao/proposals` returns full proposal descriptions, so a
  `limit=100` request can return several megabytes. Put the public API behind a
  rate limit as well as a reverse proxy.
- Railgun indexes the current Voting contract from its verified creation block; legacy governor `0xfc4B580C9bda2EEf4E94D9Fb4bcB1F7a61660cf9` is outside this release.
- delegation-event ingestion is not implemented.
- Tally enrichment/bootstrap is not implemented.
- IPFS content expansion is not implemented; canonical Railgun CID behavior is preserved.
- Snapshot ENS votes remain excluded because v1 IDs are decimal.
- `source.subgraphBlock` remains the legacy compatibility field; future schema should add generic `source.checkpointBlock`.
- Railgun multiple events remain separate behavioral precedents; future modeling may derive `(voter, proposal)` aggregates without mutating raw events.

## 11. Engineering Decisions Made

- **Tally:** reserved but unused; canonical ENS logs are the durable source.
- **ENS backfill:** bounded log-range scan from the safe Governor-era lower bound in `ENS_PROPOSAL_BLOCK_BATCH_SIZE`/`INDEXER_BLOCK_BATCH_SIZE` spans (default 5000), persistent `ProposalCreated` index, decimal proposal IDs, hash verification.
- **Reorgs:** ingest only through `head - confirmationDepth`, replay 64 trailing blocks, compare canonical material, remove orphaned records transactionally, never advance a failed checkpoint.
- **Railgun votes:** preserve every `VoteCast`; no voter/proposal deduplication; reason always `null`; bool maps to FOR/AGAINST.
- **Nouns migration:** retain the Nouns subgraph source, ingest raw source-keyed votes/proposals, independently enumerate all proposals at a pinned snapshot, refresh mutable normalized status/tallies.
- **Compose ownership:** canonical template stays in the repository; Terra owns environment values, ingress, filesystem permissions, monitoring, and backups.

## 11a. Deployment gates

Three gates, in order. None of them may be assumed:

1. **Roles.** `docker compose run --rm migrate` reports `"roles": "granted"` and
   exits 0. Any other role state exits 2 and names the reason.
2. **Least privilege.** `docker compose run --rm migrate verify-permissions
   --role gavel_api` exits 0 with `"method": "effective"`, `"write": false`,
   `"ddl": false`. Exit 2 means `gavel_api` could write, could run DDL, or could
   not be verified by acting as it.
3. **Live incremental Nouns cycle.** After a Nouns backfill,
   `docker compose run --rm indexer sync --dao nouns` exits 0 against the
   production subgraph and the checkpoint advances. This one cannot be proven
   off Terra and has not been.

## 12. Recommended Next Task

**Deploy the merged commit on Terra and complete a recorded operational acceptance test covering real PostgreSQL migration, all three backfills, incremental sync, API queries, reboot persistence, network isolation, and backup restore.**

## Terra acceptance checklist

- [ ] merged commit SHA pinned in `/srv/docker/gavel-index`
- [ ] `.env` provisioned outside git with mode `0600`
- [x] Railgun creation block independently verified and pinned to `15505853`
- [ ] Postgres volume persists and has no host port
- [ ] API ingress uses Cloudflare Tunnel/reverse proxy; no router forwarding
- [ ] operator admin path is SSH/Tailscale only (an operator choice; irrelevant to clients using the public index)
- [ ] migrations complete against real PostgreSQL and report `"roles": "granted"` (exit 0)
- [ ] `verify-permissions --role gavel_api` exits 0 and reports `"method": "effective"`, `"write": false`, `"ddl": false`
- [ ] Nouns, ENS, Railgun backfills complete
- [ ] `sync --all` resumes cleanly and remains idempotent
- [ ] API queries return indexed records
- [ ] private RPC URL absent from API and logs
- [ ] health monitoring and Pushover alert configured (`indexer health` exits 2 on a stalled checkpoint)
- [ ] first incremental Nouns cycle succeeds (`indexer sync --dao nouns` after a backfill, exit 0, checkpoint advanced)
- [ ] steady-state RPC volume observed for one hour and matches the incremental figure in section 6
- [ ] `rpc_block_ranges` startup log shows block spans within the configured provider's documented `eth_getLogs` limit
- [ ] rollback rehearsed once from the pre-update dump
- [ ] backup scheduled and restore tested
- [ ] host reboot preserves volume and restarts healthy services
- [ ] Docker network inspection confirms Postgres isolation
