# Gavel Gate PR9 integration-gap report

**Branch/base inspected:** `feat/gavel-gate-pr9` at `7676c3868d43672e952238c4edc876a274018cfe`, equal to `origin/main` (merged PR8 / GitHub PR #38).

**Scope:** read-only integration audit of merged PR5–PR8. This report does not claim a deployment, live PostgreSQL proof, network transaction, AgentMail send, or Base RPC probe. The frozen technical specification is authoritative (`docs/GAVEL_GATE_TECHNICAL_SPEC.md:3-7`); the PR9 gates are in `docs/plans/2026-09-13_191719-gavel-gate-mvp.md:673-745`.

## Executive disposition

PR9 is **not activation-ready**. The merged code contains substantial unit/static coverage, but the following are hard blockers:

1. Base Sepolia cannot issue quotes through the PostgreSQL production store: runtime configuration accepts `84532`, while quote validation and the database require `8453` (`packages/server/src/gate/runtime.js:30-61`, `packages/server/src/gate/store.js:446-449`, `packages/server/migrations/001_gate.sql:378-397`).
2. The scanner returns before settling already-durable observations whenever the safe head is behind the cursor window (`packages/gate/src/settlement.js:62-70`, `packages/server/src/gate/settlement-service.js:151-185`).
3. All five Gate real-PostgreSQL tests are skipped in CI because CI supplies the governance-index variable, not the Gate variables, and its database name does not satisfy the Gate destructive-test suffix guard (`.github/workflows/test.yml:22-45`, `packages/server/test/gate-store-postgres.test.js:10-17`, `packages/server/test/durable-persistence.test.js:161-172`).
4. AgentMail fails open on an invalid/missing idempotency key and treats provider conflict `409` as a successful send (`packages/server/src/gate/notifiers/email.js:30-52`).
5. The notification runtime is not composable from environment: there is no destination decryptor, AgentMail configuration, encryption-key handling, or startup validation (`packages/server/README.md:36-58`, `packages/server/src/gate/runtime.js:64-118`, `.env.server.example:30-44`).
6. The committed deployment script is Base-mainnet-only and explicitly rejects Base Sepolia (`contracts/gate/script/DeployGavelGateSplitter.s.sol:20-37`). There is no `Dockerfile.server`, `docker-compose.server.yml`, Gate server entry point, PR9 deployment document, or smoke script. The existing `Dockerfile` starts the governance index only (`Dockerfile:1-10`), and the existing Compose file has postgres/migrate/index API/indexer but no Gate server (`docker-compose.yml:1-109`).
7. No live Base Sepolia E2E, Base-native-USDC fork, USDC pause/blacklist/cancel test, immutable deployment verification, AgentMail probe, or mainnet smoke evidence exists. These remain explicit frozen gates (`docs/plans/2026-09-13_191719-gavel-gate-mvp.md:716-745`).

## A. Inherited PR5–PR8 blockers

| Source | Current evidence | Disposition for PR9 |
|---|---|---|
| PR5 quote issuance, dedupe, and resume | PostgreSQL issuance still hard-requires Base `8453` (`packages/server/src/gate/store.js:446-491`). Owner-bound hash lookup/resume has a real-SQL test, but it is opt-in and currently skipped (`packages/server/test/gate-store-postgres.test.js:402-475`). | **Open.** Make deployment chain an exact registry-bound invariant that permits a labeled `84532` test deployment and `8453` production deployment; then run the owner-bound/race suite on PostgreSQL 16. |
| PR6 settlement/scanner | Atomic settlement writes quote/reservation/inbox/notification/monitor in one transaction (`packages/server/src/gate/store.js:850-907`); generation replay and concurrent settlement assertions exist in the disposable suite (`packages/server/test/gate-store-postgres.test.js:237-288`). | **Open.** Real PostgreSQL proof is absent; scanner liveness defect remains; CI never enables the Gate DB suite. |
| PR7 checkout | Browser derives chain from the signed quote, switches wallet chain, reads token `name`, `version`, and `DOMAIN_SEPARATOR`, and signs only `ReceiveWithAuthorization` (`apps/gate-web/src/wallet.ts:121-163`, `apps/gate-web/src/wallet.ts:182-218`, `apps/gate-web/src/wallet.ts:283-313`). | **Partially complete.** Client is test-chain-capable, but backend issuance/schema and deployment script are not. No browser/wallet or network E2E has run. README backend-gap text is stale about private inbox after PR8 (`apps/gate-web/README.md:57-77`). |
| PR8 inbox/CLI | Server requires `dao_inbox`; owner profile is derived from session wallet; missing/foreign items return the same 404 (`packages/server/src/gate/http.js:148-171`, `packages/server/src/gate/inbox-service.js:48-81`). CLI constructs allowlisted projections (`packages/cli/gate-client.js:1-39`). | **Implemented locally; integration unproven.** Real DB owner isolation and deployed API/CLI fixture remain unexercised. |
| PR8 notifier | Worker requires provider-level durable idempotency and passes only key, opaque destination reference, and trusted summary (`packages/server/src/gate/notification-worker.js:28-63`). Email wrapper does not receive signing/wallet objects (`packages/server/src/gate/notifiers/email.js:59-91`). | **Open hardening/composition gaps.** Invalid keys, `409`, 24-hour expiry, decryption, environment composition, startup validation, and live non-send probe remain unresolved. |
| PR2/contract items deferred to PR9 | Mock contract tests cover replay, wrong domains, copied-signature resistance, forbidden transfer path, and invariants (`contracts/gate/test/GavelGateSplitter.t.sol:94-120`, `contracts/gate/test/GavelGateSplitter.t.sol:377-405`; `contracts/gate/test/GavelGateSplitterInvariant.t.sol:136-149`). | **Not real-USDC evidence.** Base native USDC compatibility, pause/blacklist, canceled authorization, Slither, and independent reviews remain gates. |

## B. Base mainnet `8453` versus Base Sepolia `84532`

### Current assumptions

- Frozen contract: production is `8453`; tests use their configured Base test chain (`docs/GAVEL_GATE_TECHNICAL_SPEC.md:413-438`). Canonical production token/domain is Base native USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, `USD Coin`, version `2` (`docs/GAVEL_GATE_MVP_DECISIONS.md:31-36`).
- Schema: `splitter_deployments.chain_id` accepts any positive chain and is unique with splitter, but `quotes.base_chain_id` has `CHECK(base_chain_id=8453)` (`packages/server/migrations/001_gate.sql:351-360`, `packages/server/migrations/001_gate.sql:378-397`). The migration catalog guard also explicitly requires the `8453` check (`packages/server/migrations/001_gate.sql:48-51`).
- Store: issuance independently rejects any quote not on `8453` (`packages/server/src/gate/store.js:446-449`). It then binds deployment chain/splitter/token/code hash (`packages/server/src/gate/store.js:487-491`).
- Runtime/adapter: runtime accepts any positive decimal chain, including a unit-tested `84532`, and adapter verifies the RPC-reported chain equals it (`packages/server/src/gate/runtime.js:30-61`, `packages/server/test/runtime-composition.test.js:32-56`, `packages/server/src/gate/base-settlement-adapter.js:81-108`). This is inconsistent with quote issuance/schema.
- Quote domain logic is chain/deployment-bound and has explicit `8453` versus `84532` digest/signature separation tests (`packages/gate/test/quote.test.js:97-129`).
- Settlement checks quote chain/splitter against the configured adapter and stored evidence (`packages/server/src/gate/settlement-service.js:28-42`), but can only encounter persisted quotes allowed by the schema/store.
- Splitter deployment: current script hard-codes mainnet chain/token and rejects any other chain (`contracts/gate/script/DeployGavelGateSplitter.s.sol:20-37`).
- UI/wallet: no hard-coded chain; chain/token/splitter come from owner-bound persisted quote; token domain is read and reproduced before signing (`apps/gate-web/src/wallet.ts:8-16`, `apps/gate-web/src/wallet.ts:121-163`, `apps/gate-web/src/wallet.ts:227-242`). This is the correct client behavior.
- Environment example defaults to mainnet chain and canonical token (`.env.server.example:30-35`) and has no explicit environment/test-token label.

### Required distinction without weakening invariants

Do **not** replace the `8453` check with unconstrained `chain_id > 0`. Introduce an explicit deployment class, for example `production | test`, in the authoritative splitter registry and enforce a closed relation:

- production: chain `8453`, canonical Base native-USDC address, runtime metadata/domain evidence, production signer/recipient, real immutable fee;
- test: chain `84532`, explicitly labeled test token address and its observed domain metadata/separator, test-only signer/recipient;
- quotes continue to reference deployment by the existing composite FK `(deployment_id, base_chain_id, splitter, token)` (`packages/server/migrations/001_gate.sql:397`), so a quote cannot mix environment, chain, splitter, or token;
- startup must require an explicit environment, compare RPC chain, configured chain/token/splitter, registry row, deployed bytecode/code hash, and signer/recipient immutables, and refuse cross-environment combinations;
- settlement workers remain keyed by exact chain + splitter; no cross-chain migration or fallback is allowed;
- public UI may display the signed quote chain/token but must not infer trust merely from a chain ID.

The schema migration must be deliberate and catalog-manifested; tests must prove `8453/test`, `84532/production`, unknown chains, wrong token, wrong splitter, and cross-environment registry references fail.

## C. PostgreSQL integration status and required proofs

### Tests currently skipped/unproven

Five Gate tests are guarded by `GAVEL_GATE_TEST_DATABASE_URL`, `GAVEL_GATE_TEST_DATABASE_DISPOSABLE=yes`, and a database name ending `_test` or `_disposable`:

1. migration upgrade/idempotence (`packages/server/test/gate-store-postgres.test.js:65-148`);
2. invariants, issuance race, settlement race, scanner generation replay, canonical release, privacy, and role denial (`packages/server/test/gate-store-postgres.test.js:150-369`);
3. catalog-drift rejection (`packages/server/test/gate-store-postgres.test.js:371-400`);
4. owner-bound exact-hash lookup/resume (`packages/server/test/gate-store-postgres.test.js:402-475`);
5. durable nonce/session restart (`packages/server/test/durable-persistence.test.js:161-194`).

CI starts PostgreSQL 16 but exports only `GAVEL_TEST_DATABASE_URL` for governance-index tests (`.github/workflows/test.yml:22-45`). It does not export either Gate variable; `gavel_ci` also fails the Gate suffix guard. Therefore the Gate suite is unproven in CI even though the governance-index PostgreSQL suite runs.

### Local availability

Read-only tool discovery found `psql`, `postgres`, `pg_ctl`, and `docker` absent. `GAVEL_GATE_TEST_DATABASE_URL`, `GAVEL_GATE_TEST_DATABASE_DISPOSABLE`, `GAVEL_TEST_DATABASE_URL`, and `DATABASE_URL` were absent. No service was installed or started.

### Required real-engine proof matrix

The existing broad test covers several behaviors, but PR9 should split/numerically report each proof so a skipped aggregate cannot hide a missing race:

- concurrent quote capacity, including different senders against one profile and slot 25/26;
- concurrent duplicate/exact-hash issuance and global replay uniqueness;
- concurrent settlement workers: exactly one quote transition, inbox, notification, monitor, and consumed reservation (`packages/server/test/gate-store-postgres.test.js:260-265` is the current aggregate assertion);
- notification enqueue uniqueness and concurrent worker `SKIP LOCKED` claims (`packages/server/migrations/001_gate.sql:473-493`);
- reservation consumption exactly once, release exactly once, and exceptional late settlement consumes a released row without re-release (`packages/server/src/gate/store.js:890-892`);
- scanner generation exact replay is idempotent and conflicting replay is rejected without cursor movement (`packages/server/migrations/001_gate.sql:692-705`);
- complete canonical block/receipt coverage and ancestry before no-match release (`packages/server/migrations/001_gate.sql:706-769`);
- owner-bound inbox, exact-hash lookup, and resume after restart;
- effective DB role boundaries for `gavel_gate`, `gavel_api`, and `gavel_indexer`, including prohibited direct table writes/DDL and private-schema access (`packages/server/migrations/001_gate.sql:1082-1121`).

Run against PostgreSQL 16 with distinct least-privilege roles, not an owner-only connection and not SQL mocks.

## D. Scanner liveness defect

### Exact behavior

`safeHead()` with MVP depth 1 returns the latest head (`packages/gate/src/settlement.js:56-60`). `scannerWindow()` returns `null` only if the safe head is before deployment; otherwise it may return an invalid range where `throughBlock < fromBlock` when `safeHead < next_range_from - 1` (`packages/gate/src/settlement.js:62-70`).

`scanOnce()` computes that window, and if it is null immediately returns `{scanned:0, accepted:0, anomalies:0}`. It calls `settleDurableObservations()` only after a new range has been scanned and persisted (`packages/server/src/gate/settlement-service.js:151-186`). Therefore:

- if safe head is before deployment, already-durable observations cannot settle because of the early return;
- if safe head is at/after deployment but below the overlap-derived `fromBlock`, `adapter.scanRange()` receives `through < from` and throws `invalid scan range` (`packages/server/src/gate/base-settlement-adapter.js:158-162`);
- in both forms, the scanner does not drain already-durable exact observations and can remain stuck until head catches up;
- `listUnsettledSettlementObservations()` is capable of finding current latest-generation durable evidence (`packages/server/src/gate/store.js:670-681`), so the persistence layer can settle it; orchestration prevents the call.

### Required regression

RED must persist an exact current-generation observation, set `nextRangeFrom=N`, set safe head `< N-1`, call `scanOnce`, and expect one acceptance without `scanRange` or cursor mutation. A second call must remain idempotent. Add variants for safe head before deployment, shallow reorg/head regression, lifecycle claim pending, and no durable observations. GREEN should drain durable observations independently of whether a new range exists, while never fabricating new canonical coverage or moving/releasing from a regressed head.

## E. AgentMail hardening

Current implementation and required changes:

1. **Invalid idempotency key fails open.** The sender adds the header only when a regex matches; otherwise it sends without the header (`packages/server/src/gate/notifiers/email.js:30-47`). Required: reject before fetch unless the key is valid. The worker always supplies notification ID (`packages/server/src/gate/notification-worker.js:47-55`), so omission is a defect, not an optional mode.
2. **`409` is conflated with `200`.** Current code returns a normal success object for `409` (`packages/server/src/gate/notifiers/email.js:48-52`), and current test freezes that incorrect behavior (`packages/server/test/notifiers-email.test.js:133-143`). AgentMail documentation summarized in-repo says `409` means the same key was used with a different body (`packages/server/README.md:49-54`). Required: produce a distinct private `PROVIDER_IDEMPOTENCY_CONFLICT` result/error, do not mark sent, do not retry automatically, do not expose destination/body/key publicly, and alert for reconciliation.
3. **24-hour key residual.** Provider keys expire 24 hours after completion (`packages/server/README.md:49-55`). The worker has exponential retry but no key-age/deadline input (`packages/server/src/gate/notification-worker.js:44-80`), and claimed jobs omit creation/first-attempt time (`packages/server/migrations/001_gate.sql:478-492`). A process outage or ambiguous send older than 24 hours can resend after provider dedupe expires. Persist/return the dedupe window deadline or first-attempt timestamp, stop automatic retry before expiry, and move to private manual-reconciliation state/alert. Document that durable provider idempotency is time-bounded, not perpetual.
4. **Live probe.** No live probe has run; README says so (`packages/server/README.md:53-58`). Add an opt-in startup/ops probe that validates API reachability, credential validity, and configured sender inbox through a documented non-send endpoint if AgentMail offers one. It must emit only pass/fail/status class and never key, destination, response body, or headers. A probe must not claim send-path idempotency validation unless a separately approved test inbox send is actually executed. This audit did not send mail.

## F. Notifier runtime composition and authority

The worker can accept an injected durable provider (`packages/server/src/gate/runtime.js:92-117`), but the actual chain is incomplete:

`worker -> notificationProvider` exists; `notificationProvider -> createEmailNotifier -> resolveDestination -> createAgentMailSender` is not constructed anywhere. The README explicitly confirms no decryptor or `AGENTMAIL_*` wiring (`packages/server/README.md:57-58`). `.env.server.example` omits `GAVEL_GATE_ENCRYPTION_KEY` and all AgentMail variables (`.env.server.example:30-44`), despite the PR9 plan requiring them (`docs/plans/2026-09-13_191719-gavel-gate-mvp.md:685-704`).

Required composition:

- explicit names such as `AGENTMAIL_API_KEY`, `AGENTMAIL_FROM_INBOX`, optional allowlisted `AGENTMAIL_API_URL`, and `GAVEL_GATE_ENCRYPTION_KEY`;
- authenticated encryption format/version/key ID for `delivery_settings.ciphertext`; decrypt only inside `resolveDestination`, immediately before send;
- startup validation for exact key length/encoding, sender inbox syntax, HTTPS API origin, provider enabled/disabled mode, and complete notifier config; partial config must fail startup;
- no plaintext destination in DB, logs, metrics, thrown errors, provider IDs, or public/private projections beyond the actual outbound request;
- object-capability isolation: notifier closure receives only decrypt capability + AgentMail sender + redacted logger. It must not receive quote signer, wallet, Base RPC mutation capability, session secret, raw pitch, payment authorization, or evidence-fetch capability. Current narrow worker payload supports this (`packages/server/src/gate/notification-worker.js:6-22`, `packages/server/src/gate/notification-worker.js:47-55`), but the final runtime wiring must prove it.

Presence-only audit: `AGENTMAIL_API_KEY` was present in this shell; sender inbox, encryption key, Gate DB/RPC/signer/session variables were absent. No values were read or reported and no network request was made.

## G. USDC EIP-712 domain

- Production assumption is exact canonical Base native USDC: `USD Coin`, version `2`, chain `8453`, canonical token address (`docs/GAVEL_GATE_MVP_DECISIONS.md:31-36`; `docs/GAVEL_GATE_TECHNICAL_SPEC.md:440-449`).
- The mainnet deployment script verifies code, name/version, and `DOMAIN_SEPARATOR` before broadcast (`contracts/gate/script/DeployGavelGateSplitter.s.sol:46-57`).
- The browser is safer for test tokens: it reads name/version/separator and recomputes the domain for the signed quote chain/token before signing (`apps/gate-web/src/wallet.ts:121-163`).
- Mock `USD Coin`/`2` tests do not prove canonical Base USDC compatibility (`contracts/gate/README.md:14`).
- Base Sepolia has no committed canonical token/deployment assumption. PR9 must either identify an actual Sepolia EIP-3009 token and record runtime domain evidence, or deploy/use an explicitly test-only token implementing the exact receive type and caller==to behavior. The latter proves flow wiring only, not production USDC compatibility (`docs/plans/2026-09-13_191719-gavel-gate-mvp.md:735-740`).

## H. Splitter deployability on Base Sepolia

Current status: **not deployable through the committed script**. It requires chain `8453` and hard-coded mainnet USDC (`contracts/gate/script/DeployGavelGateSplitter.s.sol:20-37`; `contracts/gate/README.md:43-52`). No Sepolia script/config or deployment evidence exists.

Required immutable inputs and evidence:

- test token address, Gavel recipient, quote signer (`GavelGateSplitter` immutables at `contracts/gate/src/GavelGateSplitter.sol:60-73`);
- chain ID `84532`, deployed address, deployment block, runtime bytecode and code hash;
- source verification link and exact git SHA;
- readback of `usdc()`, `gavelRecipient()`, `quoteSigner()`, splitter `DOMAIN_SEPARATOR`, token `name()`, `version()`, and token `DOMAIN_SEPARATOR()`;
- explicit test-only label and proof the server registry row matches those values;
- funded deployer gas, payer Base Sepolia ETH, test USDC balance/mint route, and separate no-funds quote signer.

Missing locally: Base Sepolia RPC URL, broadcaster key, recipient/signer/splitter/token values, Foundry/cast/anvil, and funds evidence. No secrets should enter the report, shell history, repository, browser build, or logs. No deployment transaction was attempted.

## I. CI coverage

Current workflow (`.github/workflows/test.yml:13-53`):

- Node 20 and 22;
- `npm ci`;
- root `npm test`, whose glob covers root and `packages/*/test/*.test.js` (`package.json:19-37`), including server and CLI Node tests;
- explicit CLI suite (duplicative but harmless);
- TUI typecheck;
- Gate web Vitest, typecheck, and production build;
- PostgreSQL 16 for governance-index tests only.

Gaps:

- Gate PostgreSQL variables are not set, so five Gate integration tests skip;
- no assertion fails CI when a required Gate DB test is skipped;
- no Foundry install/test/fuzz/invariant/fmt/build-size step;
- no Slither step or reviewed-warning artifact;
- no server startup/build/container smoke, migration under `gavel_gate`, or Gate health check;
- no root-wide typecheck/build (only TUI typecheck and Gate web typecheck/build);
- no Base fork/testnet E2E or deployment-artifact verification job.

Required CI should retain PostgreSQL 16, create a disposable database ending `_test`/`_disposable`, set both Gate opt-in variables, run named Gate DB tests, and fail if they skip. Foundry should run from `contracts/gate` with the commands in `contracts/gate/README.md:16-39`. Live/funded tests remain protected manual activation gates, never ordinary PR jobs with broad secrets.

## J. E2E acceptance feasibility

The code has the component shapes for quote, wallet authorization, splitter call, canonical scanner, inbox, and worker, but the E2E is **not currently feasible in this environment**. Missing prerequisites include:

- installed npm dependencies;
- PostgreSQL 16 and migrated least-privilege roles;
- runnable canonical Gate server/container and composed services;
- Base Sepolia RPC and verified splitter/token deployment;
- quote signer, session secret, encryption key, AgentMail sender inbox, and complete runtime config;
- funded deployer/payer gas and test-token balance;
- canonical index/API data for an active Nouns proposal and test enrollment identities;
- Foundry/cast for deployment/readback;
- approved test mailbox if actual notification retry is to be exercised.

The acceptance flow must record: EOA enrollment/session -> successful quote -> exact EIP-3009 typed data -> splitter transaction -> `QuoteSettled` -> one-confirmation-safe scanner -> one atomic inbox/notification/monitor transaction -> private inbox read -> notification failure/retry/dedupe. It must also run the negative cases in `docs/plans/2026-09-13_191719-gavel-gate-mvp.md:735-745`. This audit made no transaction and sent no mail.

## K. Leak audit and reorg residual

### Public/private leak targets

The frozen public deny-list includes session material, quote signature/full authorization, raw pitch, receipt evidence, capacity, rate/IP/block data, and notification destination/state/provider IDs (`docs/GAVEL_GATE_TECHNICAL_SPEC.md:229-239`). Audit these boundaries:

- `gate_public.*` views and `createPublicGateReader`, including accepted timestamp only (`packages/server/migrations/001_gate.sql:1061-1080`);
- status versus owner-bound resume (`packages/server/src/gate/http.js:209-226`);
- inbox owner equality and identical foreign/unknown 404 (`packages/server/src/gate/inbox-service.js:56-81`);
- dedicated inbox serializer fields (`packages/server/src/gate/inbox-service.js:17-45`);
- CLI allowlist and terminal-control stripping (`packages/cli/gate-client.js:1-49`);
- HTTP error handling and global no-store/no-referrer headers (`packages/server/src/gate/http.js:41-49`, `packages/server/src/gate/http.js:236-249`);
- notifier logs/errors, AgentMail response parsing, destination decrypt failures, startup errors, metrics, operator alerts, and live-probe output;
- scanner unknown/mismatch/reorg alerts: no quote ID, tx hash, payer/voter, raw event, RPC credentials, or authorization;
- browser storage/log/network: session remains memory-only and evidence URLs remain display-only (`apps/gate-web/README.md:9-22`).

### One-confirmation residual

One confirmation is intentionally application finality and Gavel bears reorg risk (`docs/GAVEL_GATE_TECHNICAL_SPEC.md:158-168`). Automatic monitoring ends after the final check at 64 canonical confirmations. A detected post-acceptance reorg must preserve public accepted state, inbox, and consumed capacity; record private anomaly/alert; and take no refund/recharge/financial action. A deeper rewrite after the horizon is residual operator-reconciliation risk and must not be described as perpetually monitored (`docs/GAVEL_GATE_MVP_DECISIONS.md:50-62`).

## L. Prioritized PR9 sequence

Each code change must follow RED -> GREEN; external activation remains gated separately.

1. **Restore deterministic local/CI prerequisites (no behavior change).**
   - RED/baseline: `npm ci`; `npm test`; `npm test --workspace @gavel/cli`; Gate web test/typecheck/build.
   - GREEN: all non-live suites pass; record counts. Do not interpret the current dependency-missing run as product-test evidence.
2. **Fix chain/environment invariants.**
   - RED: targeted migration/store/runtime tests for allowed `(production,8453,canonical token)` and `(test,84532,labeled test token)` plus every cross-pair rejection.
   - Suggested commands: `node --test packages/server/test/gate-store-postgres-unit.test.js packages/server/test/runtime-composition.test.js`; then disposable PostgreSQL `node --test packages/server/test/gate-store-postgres.test.js` with the guarded variables.
   - GREEN: closed environment relation, composite registry binding, runtime RPC/readback checks, and no unconstrained-chain fallback.
3. **Fix scanner liveness.**
   - RED: `node --test --test-name-pattern='safe head.*durable|durable.*safe head' packages/server/test/settlement-service.test.js` demonstrating settlement with `safeHead < nextRangeFrom - 1` and no range scan/cursor movement.
   - GREEN: drain durable observations independently; rerun settlement service, scanner Postgres unit, and disposable PostgreSQL generation/release tests.
4. **Harden AgentMail semantics.**
   - RED: invalid/missing key performs zero fetch; `409` yields private non-retry conflict distinct from `200`; retry stops before 24-hour dedupe expiry; logs/results contain no destination/key/body.
   - Command: `node --test packages/server/test/notifiers-email.test.js packages/server/test/notification-worker.test.js`.
   - GREEN: fail closed, explicit conflict outcome, deadline-aware terminal reconciliation, stable key.
5. **Compose encrypted notifier runtime.**
   - RED: partial env fails startup; valid env composes `worker -> email -> resolver -> sender`; ciphertext decrypts only at send boundary; wrong key/tamper fails privately; provider has no signer/wallet/session capability.
   - Command: `node --test packages/server/test/runtime-composition.test.js packages/server/test/notifiers-email.test.js`.
   - GREEN: update `.env.server.example` with names/placeholders only and add a non-send redacted probe command.
6. **Make Gate PostgreSQL mandatory in CI.**
   - RED: CI-equivalent run demonstrates five Gate skips under current variables.
   - GREEN: PostgreSQL 16 disposable Gate DB variables set, all five run, and a skip-detection gate fails on any required skip. Execute and report the proof matrix in section C.
7. **Complete packaging/startup smoke.**
   - RED: container/server smoke fails because no Gate entry point/service exists.
   - GREEN: least-privilege Gate server starts, validates config, reaches DB/RPC/index, exposes health without secrets, and does not inject Gate secrets into index/API/web/CLI.
8. **Contract quality gate.**
   - Commands: `forge test -vvv`; invariant test; `forge fmt --check`; `forge build --sizes`; Slither; two independent final-diff reviews. Record run counts and warnings. Do not substitute mock-token success for native-USDC evidence.
9. **External activation gate: Base Sepolia.**
   - Requires approved RPC, funded test identities, explicit test EIP-3009 token, separate signer/recipient, verified source/bytecode/immutables/domain readback, deployment registry entry, and no production secrets. Run the full positive/negative E2E and restart/backlog tests. No mainnet implication.
10. **External activation gate: Base mainnet.**
    - Requires canonical USDC fork/live-read evidence, pause/blacklist/canceled-authorization cases, immutable readback, review artifacts, real `$0.25` immutable fee deployment, minimum-value smoke settlement, transaction record, rotation/draining drill, and accepted one-confirmation residual. Keep issuance disabled until every gate is recorded.

## Commands executed for this audit

- Git: branch and HEAD matched the requested base; the worktree was clean before this report.
- Tool discovery: PostgreSQL client/server, Docker, Foundry, cast, anvil, and Slither were absent.
- Environment presence-only check: all Gate DB/RPC/signer/session/encryption/deployment variables were absent; only the AgentMail API-key variable was present, with no sender inbox. Values were not read.
- `npm test`: **68 passed, 75 failed, 0 skipped**; failures were dominated by missing installed dependencies (`ethers`, `zod`, `pg`, Safe packages), so this is an environment/preinstall failure, not a code regression verdict.
- `npm test --workspace @gavel/server`: **24 passed, 23 failed, 0 skipped**, likewise blocked by missing dependencies before guarded PostgreSQL tests could register as skips.
- `npm test --workspace @gavel/cli`: **5 passed, 1 failed**, with CLI subprocess unable to load `ethers`.
- Gate web test/typecheck/build stopped at `vitest: not found`.
- Contract command reported `forge: not installed`; no Solidity test ran.

No dependency install, service start, deployment, transaction, mail send, configuration change, or secret read was performed.
