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
- operational CLI: `migrate`, `backfill`, `sync`, `status`, `health`, `reconcile`, `serve`, `run`

### Modified packages

- `packages/cli`: DAO-scoped `history`, index API consumption, ENS indexed proposal lookup
- `packages/ens-adapter`: indexed proposal loading plus live Governor verification and fail-closed proposal hash/content checks
- root workspace: package/bin wiring and PostgreSQL dependency lock

### Database migration

`001_initial.sql` creates:

- `daos`
- `governance_sources`
- `raw_governance_records`
- `proposals`
- `proposal_actions`
- `vote_events`
- `delegation_events`
- `sync_checkpoints`

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

- Scanned once: ENS `ProposalCreated`/`VoteCast`; Railgun `VoteCast`; Nouns historical votes/proposals through paginated pinned subgraph queries.
- Incremental: only finalized blocks after the checkpoint, plus a 64-block trailing replay window.
- Live RPC: proposal refresh/materialization where required and transaction-time vote safety checks.
- Served from PostgreSQL: proposal lookup, proposal lists, vote lists, voter histories, DAO metadata, and sync status.
- No per-history-request historical RPC reconstruction.

## 7. Deployment

### Required configuration

Copy `.env.example` to an operator-owned `.env`, permissions `0600`, and set:

```dotenv
POSTGRES_PASSWORD=<strong-random-secret>
GAVEL_INDEXER_DB_PASSWORD=<different-strong-random-secret>
GAVEL_API_DB_PASSWORD=<different-strong-random-secret>
ETHEREUM_RPC_URL=<credential-bearing-mainnet-rpc-url>
INDEXER_ENABLED_DAOS=nouns,ens
INDEXER_CONFIRMATION_DEPTH=12
INDEXER_BLOCK_BATCH_SIZE=20000
INDEXER_RPC_CONCURRENCY=4
INDEXER_DB_POOL_SIZE=10
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

### Exact fresh-host sequence

```bash
git clone https://github.com/jgramajo4/gavel.git /srv/docker/gavel-index
cd /srv/docker/gavel-index
git checkout <merged-commit-sha>
cp .env.example .env
chmod 600 .env
# provision values above using Terra's normal secret workflow

docker compose up -d --build postgres
docker compose run --rm migrate
docker compose run --rm indexer backfill --dao nouns
docker compose run --rm indexer backfill --dao ens
docker compose run --rm indexer backfill --dao railgun-eth
docker compose run --rm indexer sync --all
docker compose up -d api indexer

docker compose ps
curl --fail http://127.0.0.1:${API_PORT:-8080}/health
docker compose run --rm indexer status
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

Terra must put API ingress behind Cloudflare Tunnel or the normal reverse proxy. Admin operations should remain Tailscale/SSH-only.

## 9. Tests

Latest coding-host results:

- focused governance suites: **55 passed, 0 failed**
- full repository suite: **156 passed, 1 skipped, 0 failed**
- `npm audit`: zero vulnerabilities
- clean production dependency tree after `npm ci --omit=dev`
- API smoke: `/health` returned `200`; mutation request returned `405`
- Compose static checks: private Postgres, internal DB network, external indexer egress, consistent credentials, health checks
- `git diff --check`: passed

Skipped test: live mainnet-fork test requiring external fork infrastructure.

Terra must still execute real Docker/PostgreSQL migration, backfill, API, reboot, backup/restore, and network-isolation tests. Docker and PostgreSQL were unavailable on the coding Pi.

## 10. Known Limitations

- Terra runtime deployment is not yet validated.
- Railgun indexes the current Voting contract from its verified creation block; legacy governor `0xfc4B580C9bda2EEf4E94D9Fb4bcB1F7a61660cf9` is outside this release.
- delegation-event ingestion is not implemented.
- Tally enrichment/bootstrap is not implemented.
- IPFS content expansion is not implemented; canonical Railgun CID behavior is preserved.
- Snapshot ENS votes remain excluded because v1 IDs are decimal.
- `source.subgraphBlock` remains the legacy compatibility field; future schema should add generic `source.checkpointBlock`.
- Railgun multiple events remain separate behavioral precedents; future modeling may derive `(voter, proposal)` aggregates without mutating raw events.

## 11. Engineering Decisions Made

- **Tally:** reserved but unused; canonical ENS logs are the durable source.
- **ENS backfill:** bounded log-range scan from the safe Governor-era lower bound, persistent `ProposalCreated` index, decimal proposal IDs, hash verification.
- **Reorgs:** ingest only through `head - confirmationDepth`, replay 64 trailing blocks, compare canonical material, remove orphaned records transactionally, never advance a failed checkpoint.
- **Railgun votes:** preserve every `VoteCast`; no voter/proposal deduplication; reason always `null`; bool maps to FOR/AGAINST.
- **Nouns migration:** retain the Nouns subgraph source, ingest raw source-keyed votes/proposals, independently enumerate all proposals at a pinned snapshot, refresh mutable normalized status/tallies.
- **Compose ownership:** canonical template stays in the repository; Terra owns environment values, ingress, filesystem permissions, monitoring, and backups.

## 12. Recommended Next Task

**Deploy the merged commit on Terra and complete a recorded operational acceptance test covering real PostgreSQL migration, all three backfills, incremental sync, API queries, reboot persistence, network isolation, and backup restore.**

## Terra acceptance checklist

- [ ] merged commit SHA pinned in `/srv/docker/gavel-index`
- [ ] `.env` provisioned outside git with mode `0600`
- [x] Railgun creation block independently verified and pinned to `15505853`
- [ ] Postgres volume persists and has no host port
- [ ] API ingress uses Cloudflare Tunnel/reverse proxy; no router forwarding
- [ ] admin path is SSH/Tailscale only
- [ ] migrations complete against real PostgreSQL
- [ ] Nouns, ENS, Railgun backfills complete
- [ ] `sync --all` resumes cleanly and remains idempotent
- [ ] API queries return indexed records
- [ ] private RPC URL absent from API and logs
- [ ] health monitoring and Pushover alert configured
- [ ] backup scheduled and restore tested
- [ ] host reboot preserves volume and restarts healthy services
- [ ] Docker network inspection confirms Postgres isolation
