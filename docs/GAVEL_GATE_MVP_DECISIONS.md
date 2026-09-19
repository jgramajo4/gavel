# Gavel Gate MVP Frozen Decisions

**Status:** Frozen checklist for the experimental MVP.

**Authority:** [`GAVEL_GATE_TECHNICAL_SPEC.md`](GAVEL_GATE_TECHNICAL_SPEC.md) is the normative implementation contract. This file is the compact drift check.

## Frozen checklist

### Product boundary

- [x] Nouns only; Base native USDC only.
- [x] Gate availability is `accepting_now | paused | closed`.
- [x] Those lowercase literals are the only availability values in code, DB, API, and EIP-712 data. Uppercase availability words may be prose/diagram labels only.
- [x] Direct profiles remain public in every state; only `accepting_now` permits new quotes.
- [x] Nouns exposes only tested canonical lifecycle mappings: eligible original Proposal Candidates map to `PRE_VOTE`; Governor `ACTIVE` maps to `VOTING`; canceled/promoted/update/malformed/missing Candidates and every unsupported Governor state fail closed to `CLOSED`. Candidate identity is proposer plus `keccak256(UTF-8 slug)`, and Candidate quotes never generate vote transactions.
- [x] One immutable paid pitch; no replies, follow-ups, or paid evaluation.
- [x] Pitch max 4,000 characters; disclosures max 2,000; at most five HTTPS evidence URLs.
- [x] Constrained CommonMark AST only; no HTML, images, embeds, scripts, Mermaid, previews, uploads, or evidence fetching. The rendering parser uses `html: false` and renders only its validated token stream without reparsing; an HTML-enabled parser may exist solely to detect and reject raw HTML, never to render.
- [x] Raw advocate text is untrusted data, never instructions.
- [x] No material-omission detector, LLM claim extraction, automated prose contradiction check, rhetoric score, or persuasion verdict.
- [x] Display raw pitch beside `canonical`, tested `decoded`, labeled `enriched`, and raw-unknown facts.

### Economics and payment

- [x] Minimum attention amount is `1_000_000` atomic USDC.
- [x] Fixed Gavel fee is exactly `250_000` atomic USDC.
- [x] Splitter rejects `quote.attentionAmount < 1_000_000` before calling USDC, independently of signer validity, and still requires the exact fixed fee.
- [x] Splitter boundary tests prove `999_999` reverts, `1_000_000` succeeds, modifying the signed amount fails, and the configured signer cannot authorize a subminimum quote.
- [x] Voter receives 100% of attention amount; Gavel receives only the fixed fee.
- [x] Gate wallet equals payout wallet; no payout override.
- [x] One EIP-3009 authorization has exact value `attentionAmount + gavelFeeAmount`, from payer to splitter, with `authorization.nonce == quote.quoteId`, `authorization.validAfter == 0`, and `authorization.validBefore == quote.expiry`.
- [x] The MVP advocate/payer is an EOA for the Base USDC EIP-3009 `v,r,s` path. ERC-1271 is for Gate enrollment/governance authority and voter payout identity, not contract-wallet payers. Base-sender session/checkout and quote issuance reject contract-wallet payers before quote; Safe payer support is post-MVP and does not change the splitter ABI.
- [x] Browser/wallet checkout constructs and signs exactly those deterministic authorization values before expiry; it cannot choose a nonce or time window and MUST NOT submit a new authorization or payment attempt at or after expiry.
- [x] Native Base USDC authorization uses domain `USD Coin`, version `2`, configured Base chain ID, and configured native-USDC address; production currently uses canonical Base native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- [x] The exact ordered EIP-3009 primary type is `ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)`. The splitter calls only `usdc.receiveWithAuthorization(...)`; `transferWithAuthorization` is forbidden except as a negative-test input/call path. Deployments verify runtime token name/version, chain/token, and domain separator before checkout; test-token domains are actual and labeled test-only.
- [x] Acceptance tests locally recover/verify authorization under that exact token domain and reject wrong name, version, chain ID, or token address. A copied pending signature cannot be redeemed directly at USDC by a third party because `receiveWithAuthorization` requires `msg.sender == to` and `to` is the splitter; the splitter call succeeds and routes the exact two legs. A signature over the distinct `TransferWithAuthorization` primary type fails when supplied to `receiveWithAuthorization`, and ABI/source/static tests prove no splitter pull path invokes `transferWithAuthorization`.
- [x] Only the immutable splitter moves money.
- [x] No refund, custody, escrow, clawback, rescue, sweep, withdrawal, admin, owner, pause, proxy, or upgrade path.

### Quote and settlement

- [x] Quote ID is random, opaque, single-use `bytes32`; never content-derived. It doubles as the single-use native-USDC authorization nonce, cryptographically preventing cross-quote substitution even for two quotes with the same payer and total.
- [x] Quote ID remains independently single-use in the splitter mapping and DB; USDC nonce consumption is additional replay protection.
- [x] Quote lifetime is exactly 10 minutes. Settlement requires `block.timestamp < quote.expiry`; equality means both quote and authorization are expired.
- [x] EIP-712 domain is `GavelGateSplitter`, version `1`, configured Base chain ID, exact splitter address.
- [x] Quote fields, in order: `quoteId,payer,voter,attentionAmount,gavelFeeAmount,submissionHash,token,expiry,quoteVersion`.
- [x] Domain construction/signing, splitter validation before USDC, server settlement verification, and adversarial tests all require `quote.quoteVersion == 1`; unsupported versions fail closed.
- [x] A valid unexpired quote remains payable after later price, availability, policy, lifecycle, or capacity change.
- [x] Tx hash/broadcast means only pending and is a latency optimization, never a prerequisite for settlement discovery or inbox creation.
- [x] Exact configured-splitter event plus one confirmation is required.
- [x] Settlement maintains a durable forward cursor per chain/splitter from its recorded deployment block through the one-confirmation-safe head. Every cycle rescans a configurable trailing overlap (default 64 Base blocks) and compares canonical block hashes/exact log identities with accepted evidence. Cursor advancement remains atomic/crash-safe.
- [x] Every recognized event resolves `quoteId` and verifies every exact field. Unknown quote IDs become redacted operational anomalies, never inboxes.
- [x] Settlement event declaration is exactly `QuoteSettled(bytes32 indexed quoteId,address indexed payer,address indexed voter,uint256 attentionAmount,address gavelRecipient,uint256 gavelFeeAmount,address token,bytes32 submissionHash)`; this fixes its signature and indexed fields, with no extra verification fields.
- [x] Settlement persistence, reservation consumption/capacity, inbox creation, notification-job creation, and durable reorg-monitor upsert are one synchronous idempotent DB transaction. The monitor key is `chainId + splitter + quoteId`, with receipt block/hash and exact transaction/log identity retained as evidence; a crash cannot expose accepted without monitoring.
- [x] A confirmed event is external truth, but before that DB transaction commits none of its effects is visible; DB failure rolls everything back and retries the whole transaction idempotently.
- [x] Settlement validity uses the receipt block timestamp: strictly before quote expiry succeeds, including when confirmation/processing/release happens later; equality or later is invalid and never credited.
- [x] Wall-clock expiry may mark local/public `expired` and disable browser payment, but it never releases capacity. It moves the reservation to `expiry_pending_reconciliation`, which remains a pending liability until the one-confirmation-safe scanner's crash-safe cursor/range evidence covers every eligible Base block that could contain an event with receipt block timestamp `< quote.expiry` and finds no match. The scanner releases only in that transaction; a valid event found first consumes atomically. Exceptional later overlap/reorg discovery still converts released to consumed and creates the paid inbox.
- [x] After atomic commit, settled capacity counts immediately even if notification delivery later fails.
- [x] If exceptional late discovery/canonical rewrite pushes measured rolling settled count above configured capacity, every paid inbox is honored and new issuance is blocked until the count falls below capacity; overage is never used to deny a paid inbox or silently ignored.
- [x] `accepted` means only `inbox_created`; notification/delivery/read/open/click/voter action remains private.
- [x] Public `acceptedAt` exists only for accepted and equals database-generated `inbox_created_at`, captured by `clock_timestamp()` or an equivalent injected DB clock when the inbox row is inserted inside the atomic transaction. It is visible only after commit and is not block time, transaction-start time, notification/delivery/read time, or an exact commit instant. Public `updatedAt` exists only for payment-required/pending/expired and is coarse Gate state-transition time; receipt block number/hash/timestamp stays private.
- [x] Every accepted settlement atomically upserts its durable bounded-batch monitor by `chainId + splitter + quoteId`; each scanner cycle revalidates receipt block hash and exact log until a final check at 64 canonical confirmations, then removes it. Rollback/restart/idempotent-upsert tests prove accepted cannot exist without monitoring. A detected post-acceptance reorg records private `settlementReorgedAt`/anomaly/alert without rollback or financial action. Deeper reorgs after the horizon are residual risk and may require operator reconciliation; automatic detection is not perpetual.

### Enrollment, policy, and capacity

- [x] EOA enrollment recovers exact typed-data signer.
- [x] Contract wallet/Safe enrollment requires DAO-chain ERC-1271 magic value `0x1626ba7e`.
- [x] Contract wallets additionally prove Base payout control at enrollment and every transition to `accepting_now`. The service uses a bounded-time Base RPC, requires current nonempty runtime code, verifies the explicit BasePayoutControl ERC-1271 proof, and stores `base_payout_code_hash = keccak256(currentCode)` with the accepting transition. This proof remains required; code-hash equality does not prove unchanged owners/controllers for an upgradeable wallet.
- [x] Profile/policy state has a monotonic `profile_version`, incremented atomically on every update including Base payout hash changes. One profile-scoped advisory/row lock, keyed only by voter/profile, is shared by every profile/policy update and every quote issuance for that profile. Quote issuance holds it through final rereads, contract-wallet code verification, canonical/limit/capacity checks, and quote transaction commit. This serializes all senders targeting the profile and prevents both profile-version/code-hash and global profile-capacity races. Missing/empty/changed code, RPC failure/timeout, or transaction failure rolls back, releases the lock, and persists no artifacts. EOAs skip the RPC, and already-issued valid quotes remain payable after later drift.
- [x] EOA cross-chain identity needs no second proof.
- [x] `GateEnrollment` uses domain `GavelGate`, version `1`, DAO chain ID, and the configured canonical Gate enrollment verifier on that DAO chain. Its frozen ordered fields are `wallet,purpose,availability,dao,daoChainId,acceptPreVote,acceptVoting,attentionAmount,nonce,issuedAt,expiry,version`; signed `purpose` is exactly `enrollment`, fixed by the server challenge, and cannot be chosen or overridden by clients.
- [x] `BasePayoutControl` uses domain `GavelGate`, version `1`, configured Base chain ID, and the configured canonical Gate enrollment verifier on Base; its exact fields and literal purpose `base_payout_control` are frozen in technical spec section 7.1 and cannot redirect payout.
- [x] `WalletSession` has frozen ordered fields `wallet,role,audience,purpose,nonce,issuedAt,expiry,version`; signed `role` is exactly `base_sender`, `dao_profile`, or `dao_inbox`. `base_sender` derives the configured Base chain/verifier; both DAO roles derive the configured DAO chain/verifier. The caller cannot override chain or verifier.
- [x] `/auth/challenge` persists exact WalletSession type + role + wallet + audience + chain + verifier + payload hash + expiry. `/auth/verify` atomically compares every value, verifies, consumes the nonce, and creates a wallet + role + chain + audience-bound session. A proof for one role cannot mint another even when `dao_profile` and `dao_inbox` share chain/verifier. EOA proofs recover the exact signer; ERC-1271 checks run only on the role-derived chain, and the same address on another chain grants no authority.
- [x] Nonces are short-lived, one-use, persisted consumed, and bound to payload hash, expiry, exact signed purpose literal (`enrollment`, `base_payout_control`, or `wallet_session`), exact type, role, wallet, audience, chain, and verifier as applicable. Any internal operation category is stored separately and never substitutes for signed `purpose`.
- [x] `/auth/challenge` may issue all three proof types, but `/auth/verify` accepts only exact role-correct `WalletSession`, atomically consumes only that nonce with session creation, and rejects enrollment/payout proofs as the wrong purpose/type.
- [x] Profile writes require exact `dao_profile` role and exact equality among its session wallet, `GateEnrollment.wallet`, and required `BasePayoutControl.wallet`. They receive operation proofs directly, compare exact signed `GateEnrollment.purpose == 'enrollment'` with the purpose persisted in `auth_nonces`, use the shared profile-scoped advisory/row lock, increment `profile_version`, and atomically consume all required proof nonces with the write. Missing/mutated/wrong purpose, any other validation failure, or rollback consumes neither nonce and changes no profile/policy state; PR 4 tests freeze the exact GateEnrollment field order and cover purpose-literal mutation and replay.
- [x] Private inbox list/show/archive requires exact `dao_inbox` role and session wallet equal to the enrolled profile wallet. Submission creation, settlement submission/controls, and resume require exact `base_sender` role and session wallet equal to payer/signed sender. Public coarse status requires no session.
- [x] Default capacity is 25 settled submissions per rolling 24 hours.
- [x] Pending reservations are capped at `floor(50%)`, which is 12 by default; both active unexpired and `expiry_pending_reconciliation` liabilities count.
- [x] One active unexpired quote per signed sender × voter is a predicate checked explicitly under the profile-scoped advisory/row lock; sender × voter is not the lock key.
- [x] At most two settled submissions per signed sender/voter/proposal in the same rolling 24-hour window used by global capacity.
- [x] Only successful quote issuance persists a submission. Immutable submission + NOT NULL issuance snapshot FK + quote + reservation are created atomically under the profile-scoped advisory/row lock; every persisted row starts `QUOTED` / `payment_required`. Rejection paths persist no submission/snapshot/quote/reservation; private aggregate rate-limit events may still be written independently. Malformed input fails before hashing/persistence; rejected unchanged input may be retried later under current checks.
- [x] Every `publicId` is independently generated with at least 128 bits from a CSPRNG and URL-safe opaque encoding, never sequential, timestamp/hash-prefix/content/quote/wallet-derived, and protected by DB uniqueness plus collision retry. Tests cover format/randomness, collision retry, non-derivation, and practical resistance to neighboring-ID enumeration without claiming mathematical impossibility.
- [x] `submission_hash` is globally unique across successfully quoted Gate submissions. Its preimage includes payer, which must equal the authenticated signed sender before hashing. Thus another wallet cannot naturally produce the same hash absent cryptographic collision or forged authentication.
- [x] `submission_hash` is ethers `keccak256(toUtf8Bytes(JSON.stringify(array)))` over exactly `["gavel-gate-submission-v1", payer, voter, dao, targetIdentity, stage, position, pitch, disclosures, evidenceUrls]` in that order. `targetIdentity` remains the canonical unsigned decimal proposal ID for proposals (preserving legacy hashes) and is the exact proposer+slug-hash Candidate target ID for Candidates. Addresses use ethers `getAddress`; pitch/disclosures retain exact JavaScript string bytes after JSON escaping with no trimming or whitespace/newline normalization; evidence URL order is significant. All later code imports `hashSubmission` from `@gavel/gate` and never reimplements it.
- [x] Request order is fixed: validate parse/size/Markdown/evidence; authenticate exact `base_sender` and require payer/sender equality; compute canonical hash; then perform owner-bound global exact-hash lookup before mutable checks. With no match, enforce block/rate checks, acquire the voter/profile-scoped advisory/row lock, reread availability/policy/`profile_version`/wallet kind/stored hash, perform contract-wallet `eth_getCode` under that lock, then continue fresh canonical/hash/limits/capacity/pending-liability checks and persist/sign in the same transaction. A unique-race loser returns the same duplicate response. Unauthenticated requests never reach lookup; guessed IDs and direct-store/hash-collision fixtures fail closed without owner/state leakage.
- [x] Quote signing binds `submissionHash`, not snapshot fields. Inside one open issuance transaction, immutable quote → submission → issuance-snapshot FKs and the snapshot's canonical content hash exist before signing; the signature is persisted, the transaction commits, and only then is the quote returned. Settlement loads that immutable chain. Snapshot fields are not added to Quote or the submission-hash preimage.
- [x] Global exact-hash dedupe is separate from one active unexpired quote per sender/voter and max two settled per sender/voter/exact target. `ACTIVE_QUOTE_EXISTS` and `SENDER_PROPOSAL_LIMIT` are coarse rejection responses with no submission artifacts: neither persists a submission/snapshot/quote/reservation, leaks/reuses existing state, or exposes counts/details.
- [x] Acceptance tests cover every hash-preimage field; immutable NOT NULL snapshot FKs; duplicate/resume states; lock/unique races; rejection paths; and no leakage. Auth tests cover signed-role mutation, nonce-row role mismatch, same-chain `dao_profile`/`dao_inbox` replay, endpoint-role mismatch, and same-address/different-chain controllers. Code-race tests cover profile/hash update versus locked issuance with exactly one ordering winning and no stale-code quote, plus RPC timeout/rollback lock release. Capacity tests prove wall-clock expiry does not free a slot, scanner safe-range no-match does, just-before-expiry inclusion consumes when processed later, concurrent expiry/scanner/issuance cannot issue slot 26, and exceptional late settlement may temporarily exceed capacity while paid inboxes are honored and new issuance is blocked. No impossible different-wallet exact-hash test exists.
- [x] Never expose counts, remaining capacity, pending count, or reset time.
- [x] Nouns index freshness defaults to 15 minutes; stale/unhealthy canonical data fails before quote issuance.
- [x] Settlement processing must attempt one bounded current-lifecycle read, but it is best-effort and non-vetoing: known state sets `stateChangedAfterQuote=true` iff it differs from issuance; unavailable/stale/timeout/unknown stores private `currentLifecycleUnavailable=true` and current state `UNKNOWN`, retains issuance state, and never delays or prevents the atomic paid-inbox commit. No other post-payment checks rerun.
- [x] Settlement tests cover forward-cursor restart/crash, missed hash, duplicate log, trailing-overlap reorg behind the cursor, queue-detected reorg, queue restart/downtime, final 64-confirmation check, and deep-after-horizon non-mutation. Metrics/runbook cover cursor/overlap lag, monitor depth/age/progress/final-check failures, alerts, and the non-perpetual horizon.

### Trust and privacy

- [x] `@gavel/gate` is pure domain logic.
- [x] `packages/server` is the single canonical hosted writer and owns Gate HTTP, DB writes, signer, settlement watcher, inbox transaction, and notifications.
- [x] Governance index stays canonical and read-only.
- [x] The action decoder recognizes USDC only at the configured allowlisted Base native-USDC target. Ethereum/Nouns-chain USDC `0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` remains raw until a post-MVP chain-aware decoder. Evidence URLs are display-only HTTPS and no server component fetches them.
- [x] Enriched facts have a strict explicit display-only shape: `source`, `displayLabel`, `value`, and optional literal `verifiable: false`. Canonical/decoded fields or unknown extras are rejected, and enriched facts are never accepted by verification serializers or consumers.
- [x] Public and private serializers are separate constructions.
- [x] Public response states are exactly `payment_required`, `pending_settlement`, `accepted`, `rejected_by_policy`, `duplicate`, `malformed`, `expired`; only successfully quoted submissions have persisted receipt state, while rejection responses are stateless.
- [x] Public timestamps are exactly `acceptedAt` for accepted and coarse `updatedAt` for payment-required/pending/expired; no public delivery/read behavior or receipt block evidence.
- [x] The only authenticated MVP API-session transport is `Authorization: Bearer WALLET_SESSION`. Secrets never appear in URLs, bodies, or logs. `GET /v1/submissions/:publicId/resume` requires the exact Base-chain original-sender session and may return original quote/resume controls. `GET /v1/submissions/:publicId/status` is deliberately public by random opaque ID and returns only coarse state plus the enumerated safe timestamp, never quote/payment/resume/private data or controls. Submission, quote, settlement, resume, and public status responses set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- [x] `workers/gavel-index-api/` and `website/` are deliberate non-changes for Gate MVP implementation.
- [x] Splitter rotation uses a read-only draining registry on the same configured Base chain. Old issuance stops, but old deployment block/cursor/RPC configuration remains active until all old quotes reconcile and every accepted old-splitter monitor completes its 64-confirmation final check; only then can scanner configuration retire. Runbook acceptance tests block premature retirement and prove no contract, funds, state, or cross-chain migration.
- [x] The following tests remain explicitly deferred to PR 9 and nonblocking for PR 3: Base-mainnet USDC fork/integration; actual USDC EIP-712 domain compatibility; pause/blacklist behavior; canceled EIP-3009 authorization; and a stronger adversarial invariant handler if one is not already present.

## Architecture decision records

### ADR-001: Non-custodial immutable splitter

**Decision:** A minimal Base splitter is the only money mover. It verifies the signed quote and native-USDC EIP-3009 `ReceiveWithAuthorization` authorization, calls `usdc.receiveWithAuthorization(...)` as both `msg.sender` and authorization `to`, pulls the exact total, sends the full attention amount to the voter, sends exactly `250_000` to Gavel, and emits the settlement event atomically. USDC's `msg.sender == to` requirement prevents a copied pending signature from being redeemed by a third party directly at USDC.

The splitter requires `quote.attentionAmount >= 1_000_000`, `authorization.from == quote.payer`, `authorization.to == address(this)`, `authorization.value == quote.attentionAmount + quote.gavelFeeAmount`, `authorization.nonce == quote.quoteId`, `authorization.validAfter == 0`, and `authorization.validBefore == quote.expiry` before calling USDC.

**Why:** The service must not become a custodian or payment intermediary. Atomic exact-leg routing makes successful settlement auditable and makes partial payment impossible.

**Consequences:** The server never holds, approves, forwards, refunds, or sweeps funds. The contract has no owner, admin, proxy, upgrade, pause, rescue, refund, withdrawal, sweep, or balance-accounting path. Direct token dust is stranded.

### ADR-002: Gate wallet equals payout wallet

**Decision:** The enrolled Gate wallet is always the voter and payout recipient. No alternate payout field exists.

**Why:** Binding public identity, authority, and payout prevents a compromised application setting or ambiguous enrollment from redirecting funds.

**Consequences:** EOA typed-data recovery must equal the wallet. Safes require DAO-chain ERC-1271 plus an explicit Base payout-control proof at enrollment/every transition to accepting, storing the current nonempty Base code hash. Every new contract-wallet quote repeats the bounded-time Base code fetch/hash comparison and fails closed on missing, empty, changed, or unavailable code; EOAs skip it and issued quotes remain payable. This bytecode drift check does not prove unchanged upgradeable-wallet controllers.

### ADR-003: Index/server separation

**Decision:** Gate lives beside the governance index. `packages/server` is the canonical hosted writer; the index is canonical read-only governance data; `@gavel/gate` is pure reusable logic.

**Why:** The reconstructable public index and its credentials/API are a different trust zone from private submissions, signer access, settlement, notifications, and mutable Gate data.

**Consequences:** Gate routes/workers are added under `packages/server/src/gate/`, not to a parallel backend and not to the index worker. Gate may use only narrow index reads. The index receives no Gate write or signer credentials.

### ADR-004: No refunds

**Decision:** Confirmed final settlement is non-refundable. There is no contract or server refund/dispute mechanism.

**Why:** The paid service is exact routing, recording, and private inbox creation—not guaranteed attention, persuasion, response, notification receipt, or human behavior. Refund custody would materially expand financial and operational risk.

**Consequences:** All deterministic rejection checks happen before payment. Product copy must disclose finality. User disputes and guarantees beyond inbox creation are out of scope.

### ADR-005: Canonical pre-payment validation

**Decision:** Validate syntax/content, authenticate the sender, require payer/sender equality, compute the canonical hash, and perform the owner-bound exact-hash lookup before mutable block/rate/profile/policy/index/lifecycle/limit/capacity checks. If no match exists, run those checks; under the voter/profile-scoped advisory/row lock recheck hash before active-quote/capacity/reservations and issue atomically. An owned match or unique-race loser returns the same duplicate response without mutating the existing row. The payer is exactly the signed sender in MVP.

**Why:** A non-refundable system must not knowingly request payment for a submission that can already be rejected cheaply and deterministically.

**Consequences:** Malformed, blocked, rate-limited, unavailable, stage-ineligible, stale/unhealthy-index, active-quote-limit, sender/proposal-limit, and capacity failures create no Gate submission, Gate-owned snapshot, quote, or reservation; private aggregate rate-limit events may still persist. Rejected exact content may be retried unchanged. After confirmation, the required single bounded lifecycle read is best-effort and cannot invalidate settlement: a known change is recorded as `stateChangedAfterQuote`, while unavailable/stale/timeout/unknown records private `currentLifecycleUnavailable=true` and current state `UNKNOWN` without delaying inbox creation.

### ADR-006: No server-side evidence fetching

**Decision:** Evidence is at most five advocate-provided HTTPS URLs rendered as external links. No server, indexer, notifier, or worker fetches them.

**Why:** Fetching untrusted URLs adds SSRF, tracking, malware, prompt-injection, availability, and content-mutation risk without being required to deliver the MVP.

**Consequences:** No previews, redirects, metadata, scrape, summary, or remote validation. URLs are display-only, and their contents are neither canonical nor verification material.

## MVP versus post-MVP

| Area | MVP | Post-MVP only |
| --- | --- | --- |
| Lifecycle | Eligible canonical Nouns Proposal Candidates as PRE_VOTE; Governor ACTIVE as VOTING | Other pre-vote targets and more DAOs/states |
| Conversation | One immutable pitch | Response/follow-up threads with explicit permission/pricing |
| Facts | Canonical, exact tested decoding, labeled enrichment, raw unknowns | Structured claim lanes and deterministic claim checks |
| Prose analysis | None | Material-omission detection, LLM claim extraction, and all prose checks require a separate design |
| Decoding | ETH value and exact canonical-USDC transfer only | Arbitrary/audited token decoders and safe multicall interpretation |
| Payments | Base native USDC EIP-3009 | Multi-chain payment adapters, Permit2/ERC-2612, chain-specific finality |
| Notifications | One private email/AgentMail-style adapter | XMTP, Telegram, digests |
| Signer changes | Pause old issuance, retain old deployment in a read-only draining registry, expire/reconcile all old quotes, deploy/switch new issuance, and scan old splitter through every accepted monitor's 64-confirmation final check before scanner retirement; no funds/state migration | Signer-key rotation registry |
| Registry/trust | Server/database records, experimental deployment evidence | On-chain/signed public registry, reputation, Kleros, external human audit |
