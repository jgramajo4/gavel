# Gavel governance index

A self-hosted, read-only PostgreSQL index for Nouns, ENS and Railgun Ethereum governance. Raw source records and normalized proposals/votes are stored separately. The HTTP API has no mutation routes.

## Configure

Copy `.env.example` to `.env`. PostgreSQL accepts either `DATABASE_URL` or libpq's native `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`. Compose creates three roles: the bootstrap `gavel` owner for migrations, `gavel_indexer` for ingestion, and SELECT-only `gavel_api` for the HTTP service. Set distinct strong values for `POSTGRES_PASSWORD`, `GAVEL_INDEXER_DB_PASSWORD`, and `GAVEL_API_DB_PASSWORD`. Other variables are `ETHEREUM_RPC_URL`, `INDEXER_ENABLED_DAOS`, `INDEXER_CONFIRMATION_DEPTH` (default 64), `INDEXER_BLOCK_BATCH_SIZE`, `INDEXER_RPC_CONCURRENCY`, `INDEXER_DB_POOL_SIZE`, `INDEXER_FULL_SCAN_INTERVAL_SECONDS` (default 21600), `INDEXER_MAX_CHECKPOINT_AGE_SECONDS` (default 900), `GAVEL_INDEX_MAX_STALENESS_SECONDS` (default 3600), `API_HOST`, `API_PORT`, and `LOG_LEVEL`. `TALLY_API_KEY` and `TALLY_API_URL` are reserved; Tally ingestion is **not implemented**. Railgun defaults to its verified Voting creation block `15505853`; `RAILGUN_FROM_BLOCK` is an optional override. Nouns depends on the Nouns Camp subgraph. ENS uses canonical Governor logs from the documented safe lower bound 13699665.

Node does not load `.env` implicitly. Export it before using the npm CLI:

```bash
set -a; . ./.env; set +a
```

Docker Compose loads `.env` automatically and supplies its own container database host. Keep credentials in environment variables. The indexer uses private transport URLs only in memory and persists explicit or origin-only public provenance, so database backups do not contain RPC/subgraph credentials.

## Migrate, backfill and run

```bash
npm ci
npm run indexer -- migrate
npm run indexer -- verify-permissions --role gavel_api
npm run indexer -- backfill --dao nouns
npm run indexer -- backfill --dao ens
npm run indexer -- backfill --dao railgun-eth
npm run indexer -- sync --dao ens
npm run indexer -- sync --all
npm run indexer -- status
npm run indexer -- health
npm run indexer -- sync --all --full
npm run indexer -- reconcile --dao ens
npm run indexer -- serve
```

`backfill` performs a **full** proposal enumeration; `sync` performs an **incremental** one unless `--full` is passed or `INDEXER_FULL_SCAN_INTERVAL_SECONDS` has elapsed since the last full pass. Only a full enumeration is authoritative about which proposals exist, so only a full pass may delete indexed rows; an incremental pass discovers proposals created in the synced block range and re-reads mutable state solely for proposals that are not in a terminal state. This is what keeps a steady-state cycle from rescanning DAO history.

`backfill --dao nouns` paginates Nouns subgraph votes and independently enumerates every proposal at one pinned snapshot, preserving immutable source records while refreshing mutable status and tallies. ENS ProposalCreated and VoteCast logs persist proposals and votes; a VoteCast with unavailable ProposalCreated metadata remains stored but cannot form a complete history document until its proposal exists. Railgun VoteCast ingestion calls the existing `RailgunDaoAdapter.fetchProposal` and persists the materialized proposal. Delegation tables/API counts exist, but delegation ingestion is not implemented (coverage is PARTIAL).

## Fresh-host Docker deployment

```bash
git clone https://github.com/jgramajo4/gavel.git
cd gavel
cp .env.example .env
# Edit .env: set all three database passwords, ETHEREUM_RPC_URL, and enabled DAOs.
docker compose up -d --build postgres
docker compose run --rm migrate
docker compose run --rm migrate verify-permissions --role gavel_api
docker compose run --rm indexer backfill --dao nouns
docker compose run --rm indexer backfill --dao ens
# Railgun requires INDEXER_ENABLED_DAOS to include railgun-eth.
docker compose run --rm indexer sync --all
docker compose up -d api indexer
docker compose ps
curl --fail http://localhost:${API_PORT:-8080}/health
docker compose run --rm indexer status
```

`docker/init-db.sh` creates the `gavel_indexer` and `gavel_api` roles, and only runs when the PostgreSQL volume is first created. On a reused volume the roles are absent and `migrate` reports `"roles": "skipped"` with the roles it needs; create them and re-run. `verify-permissions` proves `gavel_api` holds no write privilege and exits 2 if it does — run it before serving. The one-shot `migrate` service must finish successfully before API/indexer startup. Re-running backfill or sync is safe; source locking, unique event identities, and transactional checkpoints make ingestion restart-safe.

## API

```bash
curl http://localhost:8080/health
curl http://localhost:8080/v1/daos
curl http://localhost:8080/v1/daos/ens
curl 'http://localhost:8080/v1/daos/ens/proposals?limit=25'
curl http://localhost:8080/v1/daos/ens/proposals/80619211450810140112687536515944199882433060764177806587986222097717655810120
curl 'http://localhost:8080/v1/daos/ens/voters/0x0000000000000000000000000000000000000001/history?limit=25'
curl 'http://localhost:8080/v1/daos/ens/votes?limit=25'
curl http://localhost:8080/v1/daos/ens/sync-status
```

Lists use `limit` (1–100) and opaque `cursor` values. The history endpoint is the paginated indexed-event API consumed by `IndexApiClient`, which joins proposals and validates the existing `historyDocumentSchema`. Configure the normal CLI with `GAVEL_INDEX_API_URL=http://localhost:8080`.

## Operations and security

`docker compose up --build` runs a one-shot migration before API/indexer startup. Only the API port is published; Postgres is on an internal network and persistent volume, while the indexer also has public egress for RPC and subgraph access. App containers run as the unprivileged `node` user. Keep RPC endpoints, database credentials and Tally keys out of git. Proposal content is untrusted data. Back up with `docker compose exec -T postgres pg_dump -U gavel -Fc gavel > gavel.dump`; restore into an empty database with `docker compose exec -T postgres pg_restore -U gavel -d gavel --clean --if-exists < gavel.dump`.

Checkpoints advance only in the same transaction as a successful batch and never move backward; a failed replay still records its latest error. Sync serializes each source, replays a trailing window, rejects changed material under the same canonical event identity, and transactionally removes orphaned raw, vote, and delegation events. A proposal is removed only when its canonical proposal-creation record disappeared and no canonical proposal record remains. Deep reorg recovery: stop workers, restore a backup or delete the affected normalized/raw rows plus checkpoint, then backfill from a known canonical block. Source endpoints, observed heads, external IDs, content hashes and ingestion times preserve private provenance; API responses sanitize source endpoints.

The API `/health` endpoint is a process liveness check. `gavel-indexer health` is the operational check used by Compose: it exits nonzero if any enabled DAO lacks its expected checkpoint or has a checkpoint error. During the first backfill it remains unhealthy until each enabled DAO has committed a batch.

## Limitations and extension

No Tally ingestion, Snapshot proposals, IPFS expansion, or delegation-event ingestion is implemented. ENS proposal bodies require ProposalCreated coverage. Railgun Voting is pinned to creation block `15505853`. For DAO #4, add a DAO config, verified source/ABI/deployment block, source normalizer, proposal materializer, fixtures, and schema-compatible CLI ID; do not overload global DAO policy. Future schema migrations should be new numbered, rerunnable SQL files and preserve raw records.
