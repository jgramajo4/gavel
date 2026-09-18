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

## Base Sepolia test-only contracts

These contracts are isolated from the unchanged Base-mainnet deployment script:

- `DeployBaseSepoliaTestUSDC3009.s.sol` deploys the dedicated `BaseSepoliaTestUSDC3009` only on chain `84532`. It reports `USD Coin` / version `2` / `USDC` / 6 decimals, uses the exact `ReceiveWithAuthorization` type hash, caller-is-payee check, time window, per-signer nonce replay state, signature and balance checks, and a chain/address-bound EIP-712 domain. Its unrestricted `mint` is solely for test funding. **It is intentionally test-only, is not production-safe, and must never represent real value.** The existing fault-injection test mock remains test-suite-only.
- `DeployBaseSepoliaGavelGateSplitter.s.sol` accepts `BASE_SEPOLIA_TEST_TOKEN`, `GAVEL_RECIPIENT`, and `QUOTE_SIGNER`; requires chain `84532`, nonzero configuration, token code, exact token name/version/decimals/domain, and post-deploy splitter immutable/domain readback. It deploys the existing `GavelGateSplitter` unchanged with fee `250000`.
- `DeployGavelGateSplitter.s.sol` remains the only Base-mainnet path and still requires chain `8453` plus canonical native USDC.

Prerequisites for a future approved broadcast are Foundry (`forge` and `cast`), an approved encrypted Base Sepolia RPC, a funded deployer, and reviewed nonzero Gavel-recipient and dedicated no-funds quote-signer addresses. Do not put a private key or RPC URL in an artifact, command argument, shell tracing, or repository file. Use a Foundry keystore/hardware/KMS signer. This change does not broadcast anything.

From `contracts/gate`, first simulate both scripts without `--broadcast`. Only after approval, use the same reviewed source commit and signer to create Foundry's ignored broadcast records:

```sh
export BASE_SEPOLIA_RPC_URL='<secret-bearing RPC from the approved secret store>'
export GAVEL_RECIPIENT='0x...'
export QUOTE_SIGNER='0x...'

forge script script/DeployBaseSepoliaTestUSDC3009.s.sol:DeployBaseSepoliaTestUSDC3009 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account <foundry-keystore-account>
# Approved broadcast only; omitted during review:
forge script script/DeployBaseSepoliaTestUSDC3009.s.sol:DeployBaseSepoliaTestUSDC3009 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account <foundry-keystore-account> --broadcast

export BASE_SEPOLIA_TEST_TOKEN='<address from the confirmed token deployment>'
forge script script/DeployBaseSepoliaGavelGateSplitter.s.sol:DeployBaseSepoliaGavelGateSplitter \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account <foundry-keystore-account>
# Approved broadcast only; omitted during review:
forge script script/DeployBaseSepoliaGavelGateSplitter.s.sol:DeployBaseSepoliaGavelGateSplitter \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account <foundry-keystore-account> --broadcast
```

### Deployment evidence artifact

The machine-readable schema is `contracts/gate/deployments/base-sepolia/deployment.schema.json`. It enforces the artifact's structural shape only. The executable `script/capture-base-sepolia-deployment.mjs` validator requires `sourceCommit` to equal the current reviewed checkout's `HEAD`, compiles creation bytecode from that checkout, fetches both deployment transactions, requires contract-creation transactions, and compares each full transaction input byte-for-byte with the local creation bytecode plus the splitter's ABI-encoded constructor arguments. It also enforces receipts, deployed code and locally recomputed code hashes, metadata, immutable bindings, fee, and both EIP-712 domains. Write the actual ignored artifact to `contracts/gate/deployments/base-sepolia/<splitter-address>.json`; the writer rejects existing files, confines production output through canonical parent paths, and creates evidence with mode `0600`. Review and then publish it through the approved release-evidence channel. It contains public chain evidence only and never RPC URLs, credentials, signer keys, or database ciphertext.

After both receipts are confirmed, capture and validate the artifact from Foundry's broadcast JSON plus independent on-chain reads. Keep shell tracing disabled because the RPC variable can contain credentials:

```sh
set -eu
TOKEN_RUN=broadcast/DeployBaseSepoliaTestUSDC3009.s.sol/84532/run-latest.json
SPLITTER_RUN=broadcast/DeployBaseSepoliaGavelGateSplitter.s.sol/84532/run-latest.json
ARTIFACT="deployments/base-sepolia/0x<splitter-address>.json"
node script/capture-base-sepolia-deployment.mjs capture \
  --token-run "$TOKEN_RUN" --splitter-run "$SPLITTER_RUN" --output "$ARTIFACT"
node script/capture-base-sepolia-deployment.mjs validate "$ARTIFACT"
```

The artifact's splitter deployment block is the scanner start block. The capture and validation commands fail closed unless the RPC reports Base Sepolia and all recorded receipt and on-chain evidence matches; do not trust only the local broadcast file.

### Base Sepolia registry and runtime configuration

Do not alter SQL constraints. Configure the existing store with `environment: "test"`, chain `84532`, a nonblank `testTokenLabel`, artifact splitter deployment block/code hash, exact quote signer/token/Gavel recipient, encrypted RPC access ciphertext, and `issuanceActive: false`. From the repository root, with the migrated database and ciphertext supplied from approved secret stores:

```sh
export DEPLOYMENT_ARTIFACT="$PWD/contracts/gate/deployments/base-sepolia/0x....json"
export GAVEL_GATE_DATABASE_URL='<controlled operator/bootstrap database connection>'
export GAVEL_GATE_RPC_ACCESS_CIPHERTEXT='enc:v1:<key-id>:<base64url-nonce-ciphertext-tag>'
node - <<'NODE'
const fs = require('node:fs');
const { PostgresGateStore } = require('./packages/server/src/gate/store');
const { validateRpcAccessEnvelope } = require('./scripts/validate-gate-rpc-access-envelope');
const artifact = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT_ARTIFACT, 'utf8'));
const rpcAccess = validateRpcAccessEnvelope(process.env.GAVEL_GATE_RPC_ACCESS_CIPHERTEXT);
const store = new PostgresGateStore({ connectionString: process.env.GAVEL_GATE_DATABASE_URL });
(async () => {
  try {
    const expected = {
      id: `base-sepolia-${artifact.splitter.address.toLowerCase()}`,
      chainId: '84532',
      splitter: artifact.splitter.address,
      signer: artifact.splitter.quoteSigner,
      token: artifact.token.address,
      gavelRecipient: artifact.splitter.gavelRecipient,
      deploymentBlock: artifact.splitter.deployment.block,
      contractCodeHash: artifact.splitter.code.runtimeCodeHash,
      config: { environment: 'test', testTokenLabel: artifact.token.label, overlap: 64 },
      rpcAccess,
      issuanceActive: false,
    };
    await store.configureDeployment(expected);
    const row = await store.getDeployment({ chainId: expected.chainId, splitter: expected.splitter });
    if (!row || row.id !== expected.id || row.chainId !== expected.chainId
        || row.splitter.toLowerCase() !== expected.splitter.toLowerCase()
        || row.signer.toLowerCase() !== expected.signer.toLowerCase()
        || row.token.toLowerCase() !== expected.token.toLowerCase()
        || row.gavelRecipient.toLowerCase() !== expected.gavelRecipient.toLowerCase()
        || row.deploymentBlock !== expected.deploymentBlock
        || row.contractCodeHash.toLowerCase() !== expected.contractCodeHash.toLowerCase()
        || row.config?.environment !== 'test'
        || row.config?.testTokenLabel !== artifact.token.label
        || row.issuanceActive !== false) {
      throw new Error('deployment registry readback mismatch');
    }
  } finally {
    await store.close();
  }
})().catch(() => { console.error('deployment registry configuration failed'); process.exitCode = 1; });
NODE
```

This is a controlled operator/bootstrap action through the existing supported `PostgresGateStore`, using separately provisioned database credentials. The repository defines no dedicated registry-writer role. `GAVEL_GATE_RPC_ACCESS_CIPHERTEXT` is an operator-provisioned opaque encrypted envelope with the exact shape `enc:v1:<key-id>:<base64url payload>`: the key ID is 1–64 ASCII alphanumeric/`.`/`_`/`-` characters, and the canonical unpadded base64url payload is 29–8192 decoded bytes (enough for a 12-byte nonce, ciphertext, and 16-byte tag). Encryption, key lookup, authentication, and decryption are external and operator-managed; this bootstrap validates only the closed envelope shape, not cryptographic authenticity. Plaintext URLs, `rpc=https://...`, JSON-wrapped URLs, raw API keys, placeholders, blanks, unknown versions, malformed base64url, and short/oversized payloads fail before `configureDeployment`, without printing the value. The registry stores the envelope as opaque ciphertext and initial issuance remains disabled.

Read the exact row back without selecting `rpc_access_ciphertext`, and compare it to the artifact before startup:

```sql
SELECT id, chain_id, splitter, signer, token, gavel_recipient,
       deployment_block, contract_code_hash, config, issuance_active
FROM gate.splitter_deployments
WHERE chain_id = 84532 AND splitter = '<artifact splitter address>';
```

Set the server secret store to the matching values below. `GAVEL_GATE_BASE_RPC_URL` is decrypted/injected at runtime; never put it in the artifact. Keep initial issuance disabled in the registry until the activation gate is complete.

```text
GAVEL_GATE_ENVIRONMENT=test
GAVEL_GATE_BASE_CHAIN_ID=84532
GAVEL_GATE_TEST_TOKEN_LABEL=base-sepolia-test-usdc3009-unrestricted-mint
GAVEL_GATE_BASE_USDC=<artifact token.address>
GAVEL_GATE_SPLITTER=<artifact splitter.address>
GAVEL_GATE_QUOTE_SIGNER_ADDRESS=<artifact splitter.quoteSigner>
GAVEL_GATE_OWNER_RECIPIENT=<artifact splitter.gavelRecipient>
GAVEL_GATE_BASE_RPC_URL=<decrypted secret injection>
```

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
