# Gavel Gate experimental deployment

This runbook packages the single canonical `packages/server` Gate process. It does **not** authorize Base mainnet activation, a Base Sepolia deployment, an AgentMail send, or issuance against an unverified splitter.

## Trust boundaries

- `docker-compose.server.yml` contains only PostgreSQL bootstrap/migration and the Gate process.
- The existing governance index/API deployment remains separate and read-only. Do not copy Gate database, signer, encryption, or AgentMail credentials into it.
- The browser and CLI receive only the public Gate URL. They never receive database, RPC, signer, encryption, or provider credentials.
- `gavel_gate` is the only runtime database role. The owner connection is migration-only.

## Prerequisites

1. Docker Compose with PostgreSQL 16 support.
2. A healthy canonical governance index API reachable from the Gate container.
3. Ethereum and Base RPC origins.
4. A migrated registry row whose environment, chain, splitter, token, signer, recipient, deployment block, and runtime code hash match the intended deployment.
5. A dedicated no-funds quote signer. Never reuse a payer, deployer, treasury, or operator key.
6. For `agentmail` mode only: a 32-byte AES key envelope configuration and approved sender inbox. The default deployment mode is `disabled`.

Base Sepolia additionally requires the explicit activation artifacts listed under **Activation gate**. Do not invent a token or splitter address.

## Prepare configuration

Compose itself needs only the database owner/bootstrap password:

```sh
umask 077
printf 'POSTGRES_PASSWORD=<owner-password>\nGAVEL_GATE_DB_PASSWORD=<gate-role-password>\n' > .env
cp .env.server.example .env.server.local
chmod 600 .env .env.server.local
```

Edit `.env.server.local` and replace every placeholder. For Compose, set:

```text
GAVEL_GATE_DATABASE_URL=postgres://gavel_gate:<URL-ENCODED-gate-role-password>@postgres:5432/gavel
GAVEL_GATE_INDEX_URL=<reachable canonical index origin>
GAVEL_GATE_HOST=0.0.0.0
GAVEL_GATE_PORT=8080
```

Use an exact URL-encoded database password. Keep `GAVEL_GATE_NOTIFIER_MODE=disabled` and leave all AgentMail/encryption variables absent unless notification activation is explicitly approved. Disabled mode rejects even empty provider variables, so do not add blank `AGENTMAIL_*` or `GAVEL_GATE_ENCRYPTION_KEY` entries.

For Base Sepolia, use exactly `GAVEL_GATE_ENVIRONMENT=test`, chain `84532`, the verified test EIP-3009 token, and a nonblank `GAVEL_GATE_TEST_TOKEN_LABEL`. Production accepts only Base `8453` and canonical native USDC.

## Build and start fail-closed

Validate the rendered service definition without printing its environment:

```sh
GAVEL_GATE_ENV_FILE=.env.server.local docker compose -f docker-compose.server.yml config --services
```

Expected services are only `postgres`, `migrate`, and `gate`.

Start PostgreSQL and migration first, then Gate:

```sh
GAVEL_GATE_ENV_FILE=.env.server.local docker compose -f docker-compose.server.yml up -d postgres migrate
GAVEL_GATE_ENV_FILE=.env.server.local docker compose -f docker-compose.server.yml up -d --build gate
```

The Gate listener is created only after:

- the database connection is the non-owner `gavel_gate` role with no superuser/create-role/create-db/bypass-RLS capability;
- Gate schema/function migration sentinels exist;
- the canonical index reports healthy Nouns sources;
- Ethereum RPC reports chain `1`;
- Base RPC chain and on-chain splitter/token immutables and EIP-712 domains match runtime configuration and the persisted registry.

Any mismatch exits without serving traffic. Startup emits only a stable `gate_startup_failed` event, not the upstream error or secret values.

## Smoke validation

The health response contains exactly two allowlisted fields and no dependency identifiers:

```sh
GAVEL_GATE_URL=http://127.0.0.1:8081 npm run smoke --workspace @gavel/server
```

Expected output:

```json
{"ok":true,"status":"ready"}
```

The smoke client uses a bounded request, refuses redirects and credential-bearing URLs, rejects extra response fields, and never relays an unexpected response body.

For AgentMail, the separate non-send probe is:

```sh
npm run probe:agentmail --workspace @gavel/server
```

It performs only a bounded inbox `GET`. It does not send mail or prove send-path idempotency.

## Observability

Gate writes newline-delimited JSON telemetry to stderr. The schema is default-deny: metric names, label keys/values, alert sources, and alert codes are allowlisted; wallet addresses, profile/submission/quote IDs, transaction hashes, destinations, signatures, request bodies, provider responses, and raw exceptions are never fields. Sink failures never affect quote, settlement, inbox, or notification state.

Follow only structured Gate telemetry (non-JSON process output is discarded):

```sh
GAVEL_GATE_ENV_FILE=.env.server.local docker compose -f docker-compose.server.yml logs -f --no-log-prefix gate \
  | jq -R 'fromjson? | select(.type == "counter" or .type == "gauge" or .type == "alert")'
```

Show cursor/overlap/confirmation lag and checkpoint failures:

```sh
GAVEL_GATE_ENV_FILE=.env.server.local docker compose -f docker-compose.server.yml logs --no-log-prefix gate \
  | jq -R 'fromjson? | select(.name == "gate_confirmation_lag_blocks" or .name == "gate_forward_cursor_lag_blocks" or .name == "gate_overlap_lag_blocks" or .name == "gate_forward_cursor_checkpoint_failure_total")'
```

Show monitor backlog, progress, final-check failures, and reorgs:

```sh
GAVEL_GATE_ENV_FILE=.env.server.local docker compose -f docker-compose.server.yml logs --no-log-prefix gate \
  | jq -R 'fromjson? | select(.name == "gate_monitor_queue_depth" or .name == "gate_monitor_oldest_age_seconds" or .name == "gate_monitor_progress_lag_blocks" or .name == "gate_monitor_final_check_failure_total" or .name == "gate_settlement_reorg_total")'
```

The remaining counters are `gate_quote_issued_total`, `gate_quote_rejected_total{reason}`, `gate_quote_expired_total`, `gate_settlement_pending_total`, `gate_settlement_verified_total`, `gate_settlement_mismatch_total`, `gate_settlement_unknown_quote_total`, `gate_inbox_created_total`, `gate_notification_attempt_total`, and `gate_notification_failure_total`. DAO health is reported as `gate_dao_freshness_age_seconds{health="healthy|stale|unhealthy"}`. Counters are event deltas, not database totals; ship the JSON stream to the approved metrics/log collector for durable aggregation and alert on any `type="alert"`, checkpoint/final-check failure increment, sustained lag/oldest-age growth, unhealthy freshness, unknown quote, mismatch, notification failure, or reorg.

When manual reconciliation proves a reorg outside the automatic overlap/monitor paths, emit the required operator-source event without passing an identifier or free text:

```sh
GAVEL_GATE_ENV_FILE=.env.server.local docker compose -f docker-compose.server.yml exec -T gate \
  npm run observe:reorg --workspace @gavel/server -- pre_acceptance
# or: post_acceptance
```

The command accepts only the phase literal and emits a redacted counter plus alert; record the private evidence separately in the restricted incident system.

## Operations

- Inspect status with `docker compose -f docker-compose.server.yml ps`; do not dump `docker inspect`, rendered Compose, or environment output into tickets or logs.
- graceful `SIGTERM`/`SIGINT` stops new polling, drains every active worker job, closes the HTTP listener, and only then closes the database pool.
- notification failures are isolated from paid settlement acceptance. Reconciliation alerts contain stable codes only.
- rotate the quote signer as a draining deployment migration: pause issuance on the old splitter; retain its splitter address, signer/token configuration, deployment block, scanner cursor, and RPC access in the read-only draining registry; wait for every old quote to expire **and reconcile**; deploy and verify the new splitter; switch only new quote issuance to it; and then resume issuance. Continue canonical scans for the old deployment until every accepted old-splitter monitor completes its final 64-confirmation check. Only then retire the old scanner configuration. No funds or contract state migrate.
- rotate the delivery encryption key only with a deliberate envelope migration/key-ring plan. Replacing it blindly makes existing destinations undecryptable.

## Recovery after downtime

1. Keep issuance paused while recovering. Restart the same reviewed image and let the durable settlement cursor resume; never hand-advance or delete a cursor or reorg monitor.
2. Recover a bounded backlog using the configured maximum block range and 64-block overlap. Observe successive durable cursor advances rather than widening an RPC scan without limit.
3. Verify all persisted exact observations and pending transaction hints reconcile. Keep capacity reservations frozen until their scanner evidence is durably resolved.
4. Run every due monitor post-downtime, including the final 64-confirmation check. A post-acceptance reorg never reverses public acceptance: preserve the accepted state, inbox item, and consumed capacity; record the private `settlementReorgedAt` marker and retain monitor evidence. Take no automatic payment action—no refund, clawback, recharge, or authorization retry. Resolve any missing canonical payout outside the protocol through private operator reconciliation.
5. Resume issuance only after the canonical index is current, the scanner cursor reaches the safe head, the bounded backlog is empty, and no due monitor remains leased or pending.
6. A reorg deeper than 64 confirmations is residual risk, not an automatically recoverable state. Pause issuance, preserve all evidence, alert the operator privately, and perform manual chain/provider reconciliation before any new activation decision.

## Rollback

1. Pause issuance before rolling back application code.
2. Stop `gate`; leave PostgreSQL and the canonical index intact.
3. Roll back to a previously reviewed image only if it understands the installed schema. Do not reverse or hand-edit the Gate migration.
4. Re-run startup attestation and smoke before resuming issuance.
5. Preserve accepted inbox items, consumed capacity, notification reconciliation state, and reorg monitors. Never “repair” a rollback by deleting settlement data.

## Activation gate

PR9 packaging alone is not activation evidence. Keep issuance disabled until all applicable gates are recorded:

- PostgreSQL 16 CI passes with required Gate tests and zero skips;
- Foundry tests, invariants, formatting, sizes, Slither, and independent reviews pass;
- Base Sepolia has an approved RPC, funded test identities, explicit EIP-3009 test token, deployed/verified splitter, source link, deployment transaction/block, runtime bytecode/code hash, immutable and domain readback, and matching registry row;
- positive quote → authorization → settlement → scanner → inbox flow and all frozen negative cases pass across restart/backlog;
- AgentMail remains non-send unless a test mailbox send is separately approved;
- Base mainnet additionally has canonical native-USDC fork/live-read evidence and the production activation checklist. Sepolia success is not mainnet evidence.
