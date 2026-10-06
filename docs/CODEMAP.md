# Code map

Where to look for X without reading 1,000-line files. Symbols are authoritative; `~L` hints drift — search for the symbol name.

## Gate request path (packages/server)

| Need | File | Symbols |
|---|---|---|
| Process entry, env parsing, startup checks | `packages/server/bin/gavel-server.js` | `serverConfigFromEnv`, `composeProduction`, `startGateServer`, `assertDatabaseReady`, `assertEnvironmentIsolation`, `createCanonicalIndexSource`, `createRpcClient`, `main` (catches and emits `gate_startup_failed`) |
| Runtime composition, on-chain attestation, workers | `src/gate/runtime.js` | `createGateServerRuntime` (`observedJob` wires `expire`, `scan`, `reconcile`, `monitor`, `notification`), `settlementRuntimeConfigFromEnv`, `notifierRuntimeConfigFromEnv`, `readOnchainDeployment`, `assertOnchainDeployment` |
| HTTP routes | `src/gate/http.js` | `createGateHttpServer`, `createChallengeLimiter`, `bearerToken` — route table below |
| Wallet sign-in, sessions, role/audience/chain binding | `src/gate/auth.js` | `createAuthService` → `authenticateSession`, `assertWalletSignature`, `MemoryAuthRepository` |
| Profiles, directory, exact-label matching | `src/gate/profile-service.js` | `createProfileService` → `listPublicProfiles`, `findPublicProfilesByLabel`, `updateProfile`; `publicProfile` |
| Quote issuance / submissions | `src/gate/submission-service.js` | `createSubmissionService` → `createSubmission`, `getPublicStatus`, `resumeSubmission`; `createSenderPolicy`; `mapIssuanceFailure` |
| Quote message + signer binding | `src/gate/quote-issuance.js`, `src/gate/quote-signer.js` | `buildIssuedQuoteMessage`, `assertSignerDeploymentBinding`, `signIssuedQuote`; `createQuoteSigner`, `createQuoteSignerFromEnv` |
| Settlement scan / reconcile / reorg monitor | `src/gate/settlement-service.js` | `createSettlementService` → `submitTxHash`, `scanOnce`, `reconcileSubmitted`, `monitorOnce` |
| Base RPC reads for settlement | `src/gate/base-settlement-adapter.js` | `createBaseSettlementAdapter` (`rpcCall`, `getSafeHead`, `canonicalBlocks`, `canonicalMatchingLogs`, `inspectTransaction`, `revalidateMonitor`), `settlementConfigFromEnv` |
| Remote relay (payer signs, relayer broadcasts) | `src/gate/relay-service.js`, `src/gate/relay-signer.js` | `createGateRelayService` → `relaySettlement`; `createGateRelayer`, `assertExactTransaction` |
| Inbox | `src/gate/inbox-service.js` | `createInboxService` → `listInbox`, `getInbox`, `archiveInbox`; `projectInbox` |
| Email notifications | `src/gate/notification-worker.js`, `src/gate/notifiers/email.js` | `createNotificationWorker` → `runOnce`; `createEmailNotifier`, `createAgentMailSender`, `createDeliverySettingsCipher` |
| Canonical index reads used by Gate | `src/gate/index-client.js` | `createNounsIndexClient` (`getProposalSnapshot`, `getTargetSnapshot`, `getVotingPower`), `IndexUnavailableError`, `IndexIdentityMismatchError` |
| Public projections, lifecycle constants | `src/gate/semantic-contract.js` | `publicSubmissionProjection`, `publicState`, `requireNounsIssuanceLifecycle`, `notificationTransition` |
| ENS display labels | `src/gate/ens.js` | `createEnsNameResolver`, `isRenderableEnsName` |
| Telemetry, alerts | `src/gate/observability.js` | `createGateObservability` → `counter`, `gauge`, `alert`, `recordOperatorAlert`, `observeWorkerResult`; allowlisted names/codes (`WORKER_FAILED`, `CHECKPOINT_FAILED`, …) |
| PostgreSQL persistence | `src/gate/store.js` (~1.3k lines) | `PostgresGateStore`: `issue` ~L600, `recordScannerRange` ~L430, `settle` ~L1040, `releaseReservation`, `markExpired`, relay `claimRelayAttempt`…`failRelayAttempt`, notification `claimNotificationAttempts`…`reconcileNotification`, `listInboxItems` |
| In-memory persistence (must mirror SQL semantics) | `src/gate/store-memory.js` (~1.6k lines) | `MemoryGateStore` — same method names as `PostgresGateStore` |
| Schema, triggers, privileged functions | `migrations/001_gate.sql` (~1.7k lines) | Preflight/checksum guard `DO $$` at top; tables `gate.profiles`, `gate.quotes`, `gate.submissions`, `gate.capacity_reservations`, `gate.relay_attempts`, `gate.notification_attempts`, `gate.settlement_scan_*`; functions `gate.record_scanner_range`, `gate.release_expired_reservation`, `gate.validate_relational_bindings`, `gate.claim_notification_attempts`, `gate.claim_relay_attempt`, `public.gavel_gate_catalog_manifest` |

### Gate HTTP routes (`createGateHttpServer`)

| Method + path | Session role | Handler |
|---|---|---|
| `POST /v1/gate/auth/challenge`, `/verify` | none | `authService` |
| `PUT /v1/gate/me/profile` | `dao_profile` | `profileService.updateProfile` |
| `GET /v1/gate/me/profile`, `/me/inbox`, `/me/inbox/:id`, `POST /me/inbox/:id/archive` | `dao_inbox` | profile / `inboxService` |
| `GET /v1/gates`, `/v1/gates/matches` | none | `listPublicProfiles`, `findPublicProfilesByLabel` |
| `POST /v1/gates/:wallet/submissions` | `base_sender` | `submissionService.createSubmission` |
| `POST /v1/submissions/:id/settlement` | `base_sender` | `settlementService.submitTxHash` |
| `POST /v1/submissions/:id/relay` | `base_sender` | `relayService.relaySettlement` |
| `GET /v1/submissions/:id/resume` | `base_sender` (owner) | `resumeSubmission` |
| `GET /v1/submissions/:id/status` | none (coarse) | `getPublicStatus` |

## Gate domain (packages/gate, pure — no I/O)

| Need | File | Symbols |
|---|---|---|
| Quote EIP-712, USDC authorization | `src/quote.js` | `createQuoteDomain`, `buildQuoteMessage`, `hashQuoteDigest`, `verifyQuoteSignature`, `deriveUsdcAuthorization` |
| Enrollment / wallet-session typed data | `src/enrollment.js` | `validateGateEnrollment`, `validateWalletSession`, `create*TypedData`, `verifyEoaTypedDataSignature`, `verifyErc1271TypedDataSignature` |
| Settle calldata guard | `src/prepared-settlement.js` | `encodeSettleCall`, `decodeSettleCall`, `assertPreparedSettlement` |
| Settlement log + scanner window math | `src/settlement.js` | `decodeQuoteSettledLog`, `safeHead`, `scannerWindow` |
| Submission validation / hash | `src/submission-policy.js`, `src/submission-hash.js` | `validateSubmissionRequest`, `assertStageAccepted`; `hashSubmission` |
| Action facts, markdown, lifecycle | `src/facts.js`, `src/markdown.js`, `src/eligibility.js`, `src/nouns-candidate.js` | `decodeAction`; `validatePitchMarkdown`; `mapNativeLifecycle`; `candidateTargetId` |
| Constants (fees, limits, versions) | `src/constants.js` | `GAVEL_FEE_AMOUNT`, `QUOTE_LIFETIME_SECONDS`, `MAX_*` |

## Governance index (packages/governance-index)

| Need | File | Symbols |
|---|---|---|
| CLI entry (`migrate`, `ensure-roles`, `verify-permissions`, `status`, `health`, `serve`, `backfill`/`sync`, `reconcile`, `run`) | `bin/gavel-indexer.js` | `main`, `buildRuntime`, `reconcile`, `runContinuously`, `healthStatus` |
| Read-only API (incl. Gate source routes) | `src/api.js` | `createReadOnlyApi`; `/v1/gate/daos/nouns/proposals/:id`, `/targets/:id`, `/v1/daos/...`, `/v1/status` |
| Sync loop, refresh planning, failure isolation | `src/worker.js` | `GovernanceSyncWorker` → `syncAll`, `_syncDao`, `_planProposalRefresh`, `_recordDaoFailure` |
| Nouns source (subgraph + chain provenance, Candidates) | `src/nouns-source.js` | `NounsSubgraphSource` → `fetchProposals`, `fetchCandidates`, `observeSnapshot`, `canonicalSnapshotHash` |
| ENS / Railgun sources | `src/sources.js` | `EnsGovernorSource`, `RailgunVotingSource`, `BlockRangeSource` |
| PostgreSQL store | `src/postgres-store.js` (~800 lines) | `PostgresTransaction` (`upsertProposal`, `upsertTarget`, `ingest`, `reconcileRange`, `reconcileCandidates`); `PostgresGovernanceStore` (`migrate`, `getGateProposal`, `getGateTarget`, `listVotes`, `syncStatus`) |
| Memory store (mirror) | `src/memory-store.js` | `MemoryGovernanceStore` |
| Roles / privilege audit (index + Gate roles) | `src/roles.js` | `ensureRoles`, `verifyPermissions`, `verifyGatePermissions`, `GATE_REQUIRED_FUNCTIONS`, `GATE_TABLE_PRIVILEGES` |
| Client used by CLI/TUI history sync | `src/client.js` | `IndexApiClient` (`fetchProposal`, `fetchHistory`, rate-limit retry); load skill `gavel-index-client` |
| Redaction / provenance | `src/redaction.js`, `src/provenance.js` | `redactErrorMessage`, `sanitizeProvenance` |
| Migrations | `packages/governance-index/migrations/001_initial.sql` … `004_nouns_candidates.sql` | initial schema, roles, proposal lifecycle, Candidates |

## Clients and other surfaces

| Need | Where |
|---|---|
| CLI commands (`gavel gate ...` dispatch in `bin/gavel.js`) | `packages/cli/bin/gavel.js`, Gate HTTP helper `packages/cli/gate-client.js` |
| Gate web pages | `apps/web/src/pages/{GateDirectory,GateProfile,SubmissionComposer,Checkout,Enrollment,VoterInbox}.tsx`; sessions `apps/web/src/session.tsx`, `apps/web/src/wallet-session.ts` |
| Splitter contract | `contracts/gate/src/GavelGateSplitter.sol`, tests `contracts/gate/test/*.t.sol`, deploy `contracts/gate/script/` |
| Bankr payer client / skill | `integrations/bankr/src/`, `integrations/bankr/SKILL.md` |
| Proposal identity shared by index + Gate | `packages/proposal-identity/index.js` |
| Ops scripts | `scripts/gate-smoke.js`, `scripts/scanner-transport-benchmark.js`, `scripts/validate-gate-rpc-access-envelope.js` |

## Common questions

- **Why did startup fail with only `gate_startup_failed`?** `main` in `gavel-server.js`; checks run in `composeProduction` → `createGateServerRuntime` → `assertDatabaseReady` → index freshness, then bind.
- **Where is a worker error handled?** `observedJob` in `runtime.js` and the worker `onError` passed from `gavel-server.js`, which records the `gate_worker` / `WORKER_FAILED` alert via `observability.js`.
- **Where is capacity released?** Only by persisted scanner coverage, inside `gate.record_scanner_range` (reached via `recordScannerRange`) or `gate.release_expired_reservation`. `markExpired` never frees capacity.
- **Where is the scan window computed?** `scannerWindow` / `safeHead` in `packages/gate/src/settlement.js`; consumed by `scanOnce`.
- **Where are runtime DB privileges defined?** SQL grants in `001_gate.sql` plus `verifyGatePermissions` in `roles.js`; both must agree.
