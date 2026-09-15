# Gavel Gate MVP Technical Specification

**Status:** Frozen implementation contract for the experimental MVP

**Authority:** This document is normative for Gavel Gate implementation. If an implementation plan, issue, or older design conflicts with this document, this document wins until it is deliberately amended.

**Target:** Nouns governance, Base native USDC, one-week experimental MVP

## 1. Scope

Gavel Gate lets an opted-in governance participant publish a public Gate profile, set a price and proposal-stage policy, and receive one immutable paid advocacy pitch. A valid Base USDC settlement creates a private inbox item after one confirmation. Public status proves only that the item was created; it does not reveal delivery, reading, notification, or voter behavior.

### 1.1 MVP capabilities

- Nouns only.
- Base native USDC only.
- Public Gate directory and durable direct profiles.
- Availability: `accepting_now | paused | closed`.
- Wallet enrollment and policy updates through EIP-712.
- EOA and ERC-1271/Safe enrollment support, including Base payout-control proof for contract wallets.
- Proposal-stage policy exposing Nouns `VOTING` only; `PRE_VOTE` remains normalized vocabulary but is not an MVP policy option without a separately frozen, implemented, and tested native mapping.
- One immutable paid pitch per submission, with constrained CommonMark, disclosures, and display-only evidence links.
- A server-signed, ten-minute, single-use quote.
- One Base native-USDC EIP-3009 authorization and one splitter transaction.
- Synchronous inbox creation after the expected settlement event reaches one confirmation.
- One private asynchronous notification adapter.
- Side-by-side canonical, tested decoded, enriched, and raw-unknown fact display.

### 1.2 Explicit non-goals

The MVP has no:

- replies, follow-ups, threads, negotiations, or async paid evaluation;
- uploads, server-side evidence fetching, link previews, scraping, summaries, or redirect tracking;
- raw HTML, images, embeds, CSS, scripts, iframes, or Mermaid;
- refunds, escrow, custody, clawbacks, disputes, rescue, sweep, withdrawal, admin, pause, owner, or upgrade path in the splitter;
- payout override or separate payout identity;
- percentage fee or configurable per-settlement service fee;
- persuasive-score model, rhetoric classifier, material-omission detector, LLM claim extraction, automated prose contradiction check, or prose verdict;
- arbitrary-token, proxy, delegatecall, or multicall decoding;
- multi-chain payment settlement;
- XMTP, Telegram, or public notification receipts;
- signer-key registry, on-chain Gate registry, reputation system, or Kleros integration.

**Correction to older concepts:** material-omission detection and LLM claim extraction are removed from MVP. Advocacy may contain opinions, disagreement, selective emphasis, and omissions. The product instead renders the immutable pitch beside clearly separated `canonical`, tested `decoded`, `enriched`, and raw-unknown proposal data.

## 2. Architecture and trust zones

```text
public browser / authenticated voter client
             |
             v
packages/server (canonical hosted HTTP writer)
  - Gate routes/controllers/workers under packages/server/src/gate/
  - private Postgres writes and transactions
  - quote signer access
  - Base settlement watcher
  - notification worker
       | read only                         | imports pure logic
       v                                   v
packages/governance-index              @gavel/gate
  canonical governance reads           schemas, policy, adapters,
  no Gate/private writes                facts, Markdown validation,
                                       hashes and quote construction
             |
             v
Base GavelGateSplitter
  only component that moves money
  native USDC EIP-3009 pull + exact two-leg routing
```

### 2.1 Trust-zone rules

| Zone | May do | Must not do |
| --- | --- | --- |
| `@gavel/gate` (`packages/gate`) | Pure validation, schemas, policy, fact provenance, lifecycle mapping, immutable submission hashing, quote serialization | Network, database, HTTP, secret/signer access, notifications, money movement |
| `packages/server` | Canonical hosted Gate API, wallet verification, narrow index reads, Gate Postgres writes, quote signing, settlement verification, synchronous inbox creation, notifications | Write governance-index canonical data, hold/approve/refund/forward/sweep USDC, expose private state |
| governance index | Canonical read-only proposal, action, power, block, freshness, and lifecycle source | Gate writes, private Gate data, quote signing, settlement, notification, credentials for the Gate writer |
| `GavelGateSplitter` | Verify quote and EIP-3009 authorization, pull exact native USDC, route exact voter and Gavel legs, emit settlement event | Custody logic, balance-based accounting, refund, rescue, sweep, admin, owner, proxy, pause, upgrade, fallback/receive behavior |
| browser/web app | Render public/private API data, obtain wallet signatures, broadcast settlement, report tx hash | Reimplement authoritative policy, receive quote signer secrets, infer accepted status from broadcast alone |
| notifier | Consume a trusted pre-rendered summary and private destination reference | Change accepted state, fetch advocate URLs, access signing keys or a wallet, execute raw advocate content |

Gate is **beside**, not inside, the reconstructable governance index. `packages/server` is the single canonical Railway/self-hosted writer. There is no parallel Gate backend. The existing public index remains canonical and read-only. `workers/gavel-index-api/` remains GET/HEAD-only and unchanged. `website/` remains the static site and unchanged.

## 3. Fixed economics

All amounts are integers in six-decimal USDC atomic units.

| Item | Frozen value/rule |
| --- | --- |
| Minimum attention amount | `1_000_000` |
| Gavel fee | exactly `250_000` |
| Voter leg | 100% of `attentionAmount` |
| Gavel leg | exactly `gavelFeeAmount = 250_000` |
| Total authorization | exactly `attentionAmount + gavelFeeAmount` |
| Payout wallet | exactly the enrolled Gate wallet (`voter`) |
| Token/chain | canonical native USDC on configured Base deployment |

Final settlement is non-refundable. Gavel guarantees exact quote verification, routing, settlement recording, and inbox creation. It does not guarantee attention, persuasion, a response, notification receipt, delivery/open/read behavior, or dispute resolution.

The server never receives, stores, approves, refunds, forwards, or sweeps USDC. The splitter is immutable and has no refund, custody, upgrade, admin, owner, pause, rescue, withdrawal, or sweep path. Any token dust sent directly to it is stranded and must not affect settlement accounting.

## 4. Exact lifecycle state machines

Availability values in code, persistence, APIs, and EIP-712 payloads are exactly `accepting_now | paused | closed`. Uppercase availability words may appear only as prose or diagram labels; they are never serialized values. Public receipt serializers use only the lowercase receipt states in section 4.5.

### 4.1 Gate availability

```text
accepting_now <------> paused
      |                  |
      +-------> closed <-+

`paused` and `closed` may return to `accepting_now` only through a valid policy update.
For a contract-wallet voter, every transition to `accepting_now` also requires a fresh
BasePayoutControl ERC-1271 proof.
```

- Direct profiles remain public in all three states.
- Only `accepting_now` permits a **new** quote.
- An already issued, valid, unexpired quote remains payable after any later availability or policy change.

### 4.2 Submission, quote, settlement, and inbox

```text
DRAFT
  | deterministic pre-payment validation fails
  +----------------------------------------------> NO SUBMISSION ARTIFACTS PERSISTED
  |                                                 (private aggregate rate-limit events may persist)
  |
  | all checks pass; submission + issuance snapshot + quote + reservation commit atomically
  v
QUOTED / public payment_required (first persisted state; expires exactly 10 minutes after issuance)
  | wall-clock expiry ----------------------------> EXPIRED + EXPIRY_PENDING_RECONCILIATION
  |                                                 (payment-terminal; capacity still reserved)
  |
  | browser optionally supplies tx hash (pending/latency hint only)
  v
SETTLEMENT_PENDING
  | tx reverted, dropped, lacks expected event, or event mismatches
  +----------------------------------------------> QUOTED (only until quote expiry, then EXPIRED)
  |
  | exact QuoteSettled event from configured splitter + confirmationDepth=1
  v
CONFIRMED EVENT (external truth)
  | one synchronous, idempotent DB transaction
  v
SETTLED + RESERVATION CONSUMED + INBOX_CREATED + NOTIFICATION ENQUEUED
  + SETTLEMENT_REORG_MONITOR UPSERTED

EXPIRED + EXPIRY_PENDING_RECONCILIATION
  | scanner safely covers every eligible pre-expiry block with no match -> RELEASED
  | valid canonical QuoteSettled with block.timestamp < quote.expiry ----> SETTLED + INBOX_CREATED
```

Rules:

1. A tx hash or successful broadcast never means payment or acceptance. A submitted hash is only a latency optimization and pending-status hint; canonical log discovery never depends on it.
2. The settlement worker MUST maintain a durable forward cursor for each configured chain/splitter, beginning at that splitter's recorded deployment block, and scan canonical `QuoteSettled` logs through the one-confirmation-safe head. Every cursor cycle also rescans a configurable trailing overlap, default **64 Base blocks**, behind the forward cursor and compares canonical block hashes and exact log identities with stored accepted evidence in that overlap. It advances the forward cursor only in the same durable transaction that records every log in the processed range, or with an equivalent crash-safe checkpoint. Overlap rescans are idempotent and never move the forward cursor backward.
3. Every recognized log resolves `quoteId` and verifies the configured chain/splitter plus every exact event field against the immutable stored quote. Unknown quote IDs are recorded as redacted operational anomalies and never create inboxes.
4. `confirmationDepth=1` is application finality for this experimental MVP: the matching receipt must be included and reach the one-confirmation-safe head before acceptance. Gavel explicitly bears the residual one-confirmation reorg risk.
5. A matching event is valid only when its receipt block timestamp is strictly less than `quote.expiry`. A valid event included before expiry wins over local wall-clock expiry, reservation release, or an `EXPIRED` marker even when confirmation depth is reached or the watcher processes it after expiry. An event included at a timestamp equal to or greater than expiry is invalid and is never credited. At expiry the browser MUST NOT construct, sign, or submit a new EIP-3009 authorization or make a new payment attempt for that quote.
6. Wall-clock expiry may mark the local/public quote `EXPIRED` and disable browser payment, but MUST NOT release its capacity reservation. The expiry worker atomically moves the reservation to `EXPIRY_PENDING_RECONCILIATION` (or an equivalent persisted state), which remains a provisional liability. The canonical one-confirmation-safe scanner may release it only in the same crash-safe cursor/range transaction whose evidence proves coverage of every eligible Base block that could contain a valid event with receipt block timestamp `< quote.expiry`, with no matching event. A valid event found before release consumes the reservation atomically. A valid pre-expiry event discovered after release by overlap/reorg reconciliation still converts `RELEASED` to `CONSUMED` and creates the paid inbox; such a transition is exceptional reconciliation because release required prior safe-range coverage. Normal trailing-overlap and reorg comparison continue without claiming impossible absolute chain finality. `CONSUMED` is final in Gate persistence.
7. The valid confirmed event is external truth, but all Gate database effects are one atomic transaction: mark the quote settled, convert or reconcile its reservation outcome to `CONSUMED` and therefore count settled capacity exactly once, create exactly one inbox item, enqueue its notification, and upsert its durable `settlement_reorg_monitors` row. The monitor idempotency key is `chainId + splitter + quoteId`; receipt block/hash and exact transaction/log identity remain evidence. Before commit, none of these database effects is visible. On any database failure, roll back and retry the entire transaction idempotently. A crash can never expose `accepted` without durable reorg monitoring.
8. For every valid confirmed matching settlement, processing MUST attempt exactly one current lifecycle read with a bounded timeout before or while constructing the atomic persistence transaction. This recheck is required but best-effort and non-vetoing. If it succeeds with a known current state, store that state, set `currentLifecycleUnavailable=false`, and set `stateChangedAfterQuote=true` if and only if it differs from the issuance state. If the index/RPC is unavailable or stale, times out, or returns unknown, still atomically commit settlement, reservation consumption/capacity, inbox creation, notification enqueue, and reorg-monitor upsert; retain the issuance state, store current lifecycle as `UNKNOWN`, and set the distinct private field `currentLifecycleUnavailable=true`. Do not delay inbox creation or retry this read on the settlement critical path. Later private enrichment/reconciliation may fill current lifecycle but cannot change acceptance. Profile availability, policy, capacity, freshness, sender, duplicate, price, eligibility, and every other post-payment check MUST NOT be rerun or used as vetoes after irreversible payment.
9. During cursor or overlap reconciliation, a stored block-hash/log-identity mismatch marks a reorg. Before acceptance, a previously observed pending/unconfirmed log reorged out creates no inbox and returns to `payment_required` while its quote remains valid, otherwise `expired`.
10. Every accepted settlement MUST enter the durable reorg-monitor queue via the same atomic settlement transaction and remain active until its receipt reaches 64 canonical confirmations. The upsert is idempotent on `chainId + splitter + quoteId` and retains receipt block/hash and exact transaction/log identity as evidence. On every scanner cycle, process a bounded queue batch with durable progress and revalidate each item's receipt block hash and exact `QuoteSettled` log. Perform a final canonical check before removal at 64 confirmations. Scanner restart resumes both the durable forward cursor and durable monitor queue. If downtime leaves an item already beyond 64 confirmations, perform that final check before removing it.
11. A post-acceptance reorg detected by either the trailing overlap or monitor queue MUST NOT retract or delete the inbox, reverse public `accepted`, reopen the quote, decrement capacity, or trigger refund, clawback, recharge, or automated retry with the same authorization. Record private `settlementReorgedAt` plus anomaly and alert operators; public state stays accepted. A canonical rewrite or exceptional valid late discovery after release can make the measured rolling settled count exceed configured capacity. In that case, honor every paid inbox and block all new quote issuance until the rolling settled count falls below configured capacity; never deny the paid inbox and never ignore or hide the overage operationally. The voter may retain an inbox without a canonical payout, and operators resolve that risk outside the protocol. A deeper reorg after the 64-confirmation monitoring horizon is accepted residual operational risk and may be detected only by operator reconciliation; the MVP does not guarantee perpetual automatic reorg detection.
12. A valid quote remains payable after price, availability, stage policy, or capacity changes.
13. On-chain inclusion time is authoritative for payment validity. Absent a valid pre-expiry canonical event, only scanner-proven safe-range coverage releases the reservation; wall-clock expiry alone never frees capacity.

### 4.3 Capacity reservation

```text
ACTIVE_RESERVATION
  | wall-clock quote expiry ---------------------> EXPIRY_PENDING_RECONCILIATION
EXPIRY_PENDING_RECONCILIATION
  | scanner safe-range coverage, no match ------> RELEASED
  | exact confirmed settlement -----------------> CONSUMED
```

A reservation is not settled capacity, but both `ACTIVE_RESERVATION` and `EXPIRY_PENDING_RECONCILIATION` count toward the pending-reservation cap and total capacity liability. Wall-clock expiry changes only browser/payment eligibility and the persisted reconciliation state; it does not free a slot. The one-active-quote rule counts only active unexpired quotes, so an expired pair may request another quote only when every global settled-capacity and pending-liability check still passes. Scanner-proven safe-range coverage with no match releases the reservation transactionally. A release may be superseded by a later-discovered canonical event whose receipt block timestamp is strictly before expiry; settlement then converts/reconciles the reservation to final `CONSUMED`. Once the atomic settlement commit succeeds, the settled item counts against rolling capacity exactly once and immediately even if later notification delivery fails. A failed database transaction exposes neither settled capacity nor an inbox item and is retried in full.

### 4.4 Notification

```text
NOTIFICATION_PENDING -> SENT
                     -> FAILED -> NOTIFICATION_PENDING (bounded retry)
```

Notification is asynchronous and private. `SENT`, `FAILED`, destination, channel, retry, delivery, open, click, read, and archive states never affect or appear in the public accepted status.

### 4.5 Public receipt projection

The only public submission states are:

| Public state | Meaning |
| --- | --- |
| `payment_required` | A valid unexpired quote exists; payment has not been confirmed. |
| `pending_settlement` | Submitted or discovered settlement evidence is pending/unconfirmed; no inbox exists yet. |
| `accepted` | `INBOX_CREATED`; no statement about notification, delivery, reading, or voter action. |
| `rejected_by_policy` | Stateless response: no quote was issued and no Gate submission, snapshot, quote, or reservation was persisted. Details are intentionally coarse. |
| `duplicate` | Reserved exclusively for an authenticated original sender's exact global `submission_hash` conflict with an earlier successfully quoted row. Never insert or quote a second row. |
| `malformed` | Request shape, signature, size, Markdown, or URL validation failed. |
| `expired` | Payment-terminal: checkout and new authorization attempts are disabled. Capacity remains reserved as an expiry-pending liability until scanner-proven safe-range no-match release; a later-discovered canonical event is valid only if included strictly before expiry. |

Internal notification or inbox interaction states have no public projection other than `accepted` once the inbox exists.

Public timestamps are explicitly limited to:

- `acceptedAt` only for `accepted`: exactly `inbox_created_at`, a database-generated wall-clock timestamp captured when the inbox row is inserted inside the atomic transaction (Postgres `clock_timestamp()` or an equivalent injected database clock). It becomes externally visible only after commit, so accepted is never observable before `INBOX_CREATED`. It is not receipt block time, transaction-start time, notification time, delivery/read time, or a promise of the exact commit instant.
- `updatedAt` for `payment_required`, `pending_settlement`, and `expired`: a coarse Gate database state-transition time. It conveys no delivery, notification, read, open, click, archive, or voter behavior.

`duplicate`, `rejected_by_policy`, and `malformed` responses expose no timestamp in the MVP. Rejection responses may omit `publicId`; they are not stored receipt states. Receipt block number, block hash, and block timestamp remain private settlement evidence.

## 5. Public/private data matrix

Public and private serializers are separate constructions. A public response must never be made by deleting fields from a private persistence object.

| Data | Public | Non-public (authorized submitter, voter, and/or Gavel as required) |
| --- | --- | --- |
| Gate wallet and optional ENS display paired with address | Yes | — |
| Availability | Yes | — |
| DAO, accepted supported stages, price, tags | Yes | — |
| Exact current indexed governance power and `asOf` | Yes | — |
| Coarse public receipt ID/state | Yes | — |
| `acceptedAt` for accepted; coarse `updatedAt` for payment-required/pending/expired | Yes | — |
| Receipt block number/hash/timestamp | No | Yes |
| Enrollment and payout-control signatures/nonces | No | Yes |
| Session material | No | Yes |
| Quote signature and full EIP-3009 authorization | No | Yes |
| Raw immutable pitch/disclosures/evidence | No | Yes |
| Snapshot internals/source hashes/mapping details | No | Yes |
| Inbox content/read/archive state | No | Yes |
| Capacity counts, pending counts, limits, reset times | No | Yes |
| Rate limits, IP data, sender blocks | No | Yes |
| Notification channel, destination, result, retries/provider IDs | No | Yes |
| Private `currentLifecycleUnavailable` settlement field | No | Yes |
| Operational logs beyond coarse public receipt | No | Yes |

The public API never exposes capacity totals, remaining slots, pending reservation counts, or reset time. When unavailable for any private capacity reason, the public profile says only: **“Not currently accepting new submissions.”**

## 6. Data model outline

All timestamps are `timestamptz`. Amounts use `numeric(78,0)` or an equivalent lossless integer representation. Addresses use one documented canonical format consistently. Gate private tables live in a dedicated `gate` schema and are writable only by a least-privilege Gate role.

| Entity | Required outline and invariants |
| --- | --- |
| `profiles` | ID, unique Gate wallet, availability, monotonic `profile_version`, enrollment/update times, Base payout verification time and code hash, public display cache. Wallet is payout identity. `profile_version` increments atomically on every profile or policy update, including any Base payout hash change. |
| `dao_policies` | Profile, DAO, DAO chain ID, enabled flag, supported accepted stages, attention amount >= `1_000_000`, public tags; unique profile/DAO. Every mutation atomically increments the owning profile's `profile_version`. |
| `auth_nonces` | Exact proof type; exact signed purpose literal (`enrollment`, `base_payout_control`, or `wallet_session`); role when applicable; wallet; audience when applicable; chain; verifier; nonce hash; payload hash; issued/expiry/consumed times. Any internal operation category is a separate field and never substitutes for signed `purpose`. A WalletSession challenge row binds exact type + role + wallet + audience + chain + verifier + payload hash + expiry. One-use globally: a proof consumed by any permitted operation cannot be reused anywhere. |
| `submissions` | Persisted only on successful quote issuance. Independently generated opaque URL-safe public ID with at least 128 bits of CSPRNG entropy and a DB uniqueness constraint/collision retry, immutable material, globally unique submission hash, payer/signed sender, voter, DAO/proposal/stage/position, a NOT NULL immutable issuance-snapshot FK, internal state, and coarse public-state transition time used only as allowed `updatedAt`. Every row begins `QUOTED` / public `payment_required`; for MVP, `payer == signed sender` exactly. |
| `proposal_snapshots` | DAO/proposal, content hash, source block/hash, canonical refresh time, native state, normalized eligibility, mapping version, canonical actions, exact canonical/decoded facts. |
| `quotes` | Random unique bytes32 quote ID, immutable submission FK, payer, voter, attention, fee, token, Base chain/splitter, quote version, expiry, quote signature, reservation/settlement fields, tx/log identity, private receipt block number/hash/timestamp as settlement evidence, and private `settlement_reorged_at`. |
| `capacity_reservations` | Profile, quote, expiry, state (`active`, `expiry_pending_reconciliation`, `released`, or `consumed`), release/consume times, and crash-safe scanner range/cursor evidence authorizing release. Active and expiry-pending rows both count as pending liabilities; release is exceptional-reconciliation-reversible, while consumed is final. |
| `inbox_items` | Unique submission, profile, retained issuance lifecycle, current lifecycle (including `UNKNOWN`), state-change flag, private `currentLifecycleUnavailable` flag, database-generated `inbox_created_at`, and read/archive times. |
| `notification_attempts` | Inbox, channel, encrypted/opaque destination reference, `pending\|sent\|failed`, redacted provider ID/error. |
| `sender_blocks` / `rate_limit_events` | Private policy enforcement data; never serialized publicly. |
| `delivery_settings` | Encrypted destination/config only. |
| `splitter_deployments` | Read-only issuance/draining registry per historical deployment on the one configured Base chain: splitter, signer, token, deployment block, scanner cursor/config, RPC access, issuance-active flag, and retirement readiness. |
| `settlement_cursors` | One durable row per chain/splitter with deployment block, next range, canonical block hash/checkpoint, and reconciliation metadata; cursor advancement is atomic with recording all logs in its processed range or equivalently crash-safe. |
| `settlement_reorg_monitors` | Durable accepted-settlement queue, uniquely upserted by `chainId + splitter + quoteId` inside the acceptance transaction, with receipt block/hash and exact transaction/log identity, next-check/progress metadata, and completion time; bounded batches revalidate every scanner cycle through a final check at 64 canonical confirmations. |

`submission_hash` is globally unique across persisted Gate submissions. Its algorithm is frozen. Canonicalize `payer` and `voter` with ethers `getAddress` to EIP-55 form; require `proposalId` as a base-10 unsigned decimal string matching `0|[1-9][0-9]*` so leading-zero variants are impossible; then serialize this exact ordered JSON array with JavaScript `JSON.stringify`:

```text
["gavel-gate-submission-v1", payer, voter, dao, proposalId, stage, position, pitch, disclosures, evidenceUrls]
```

The literal domain tag is exactly `gavel-gate-submission-v1`; there are no omitted, additional, or reordered fields. Hash `keccak256(UTF8(serializedArray))`, concretely ethers `keccak256(toUtf8Bytes(serializedArray))`. `pitch` and `disclosures` are the exact JavaScript string bytes represented after `JSON.stringify` escaping: never trim or normalize spaces, tabs, Unicode, line endings, trailing newlines, or other whitespace. `evidenceUrls` is the validated array in supplied order, and URL order is hash-significant. MVP requires `payer == authenticated signed sender` before hashing. Every later quote, server, client, or test implementation MUST import `hashSubmission` from `@gavel/gate`; reimplementation of this serialization or hash is forbidden. This identity binding makes a natural cross-wallet exact-hash match unreachable absent a cryptographic hash collision or forged authentication. Public `duplicate` is possible only when an earlier successfully quoted submission exists and the authenticated original sender causes the server to compute the same hash from canonical input. It returns/reuses that row and issues no new quote.

A repeated exact hash from the same authenticated signed sender returns HTTP `409` with `state: duplicate` and `existing: { publicId, state, resumeUrl }`. `existing.state` is only the current coarse receipt state. `resumeUrl` contains only the opaque path `/v1/submissions/:publicId/resume`, with no query/body bearer capability, and requires the original sender's short-lived wallet-bound session. The lookup happens after syntactic/content validation, authentication, and payer/sender equality but before every mutable block, rate, profile, policy, canonical-index, lifecycle, limit, or capacity check. It does not mutate, refresh, or revalidate the existing quote or submission. The resume endpoint returns the original quote/payment payload only for unexpired `payment_required`, pending status for `pending_settlement`, and accepted status for `accepted`; `expired` is payment-terminal but retains the reconciliation qualification in section 4.2. Rejected content has no row and may be retried unchanged. Malformed or unauthenticated requests never reach duplicate lookup. A guessed `publicId` never authorizes request, resume, or quote access; public status exposes only its frozen coarse projection. A deliberate direct-store/hash-collision condition fails closed without revealing owner or state.

Snapshot association is relational, not an extra EIP-712 field: the quote signature binds `submissionHash`; the immutable quote row references the immutable submission row; the submission row immutably references its issuance snapshot; and the snapshot stores the canonical content hash. Quote issuance creates these relationships inside one open database transaction, signs only after they exist, persists the signature, commits, and only then returns the quote. Settlement loads this immutable chain and validates the quote and event. Swapping a snapshot requires a database integrity violation. Neither snapshot fields nor `snapshotId` are added to `Quote` or the global submission-hash preimage.

This global exact-hash deduplication is distinct from (a) one active unexpired quote per sender × voter and (b) at most two settled submissions per sender × voter × proposal in the rolling 24-hour window. A second distinct submission while that pair has an active unexpired quote returns stateless `rejected_by_policy` with coarse code `ACTIVE_QUOTE_EXISTS`; a third otherwise-distinct settled-limit submission returns stateless `rejected_by_policy` with coarse code `SENDER_PROPOSAL_LIMIT`. Neither rejection persists a submission or Gate-owned snapshot, quote, or reservation, reuses or leaks existing state, or exposes private counts/details. Changing content produces a different hash but does not evade either separate limit.

Required uniqueness/idempotency boundaries include quote ID, public submission ID, global submission hash, inbox-by-submission, settled chain/transaction/log identity, and settlement-monitor `chainId + splitter + quoteId`. One profile-scoped advisory/row lock, keyed only by voter/profile, is shared by every profile/policy update and every quote issuance for that profile. Quote issuance holds it through final rereads, contract-wallet code verification, canonical and exact-hash checks, all active-quote/settled-limit/capacity/pending-liability checks, and quote transaction commit. This serializes all senders targeting the profile and prevents both profile-version/code-hash and global profile-capacity races. The one-active-quote-per-sender × voter rule remains a predicate checked under this lock; sender × voter is not the lock key. RPC timeout/failure rolls back the transaction and releases the lock with no submission artifacts. Settlement locks the quote and verifies the event before mutation.

`publicId` MUST be generated independently of submission content, quote IDs, wallets, proposal data, hashes, and timestamps by a cryptographically secure random generator with at least 128 bits of entropy, then encoded as an opaque URL-safe identifier. It MUST NOT be sequential, timestamp-derived, a hash prefix, wallet-derived, or otherwise enumerable. The database enforces uniqueness; a collision retries generation before commit without changing any stable submission field. The public status route deliberately treats this random opaque ID as a capability-like locator, not authentication, and returns only the coarse projection in section 4.5. Tests cover format and entropy source, collision retry, non-derivation from stable fields, and practical inability to enumerate or guess neighboring IDs without claiming mathematical impossibility.

## 7. Enrollment and wallet authority

### 7.1 Exact EIP-712 authentication schemas

All three authentication proofs use configured verifier addresses; this specification does not assert a deployed address. Implementations MUST reject a proof whose chain ID or verifier address differs from the requested purpose's configured domain. The exact `GateEnrollment` domain for Nouns is:

```ts
const gateEnrollmentDomain = {
  name: 'GavelGate',
  version: '1',
  chainId: daoChainId,
  verifyingContract: configuredGateEnrollmentVerifierAddressOnDaoChain,
};
```

`daoChainId` is the DAO chain (Ethereum for Nouns). The enrollment proof uses this exact primary type and field order:

```ts
const GateEnrollment = [
  { name: 'wallet', type: 'address' },
  { name: 'purpose', type: 'string' },
  { name: 'availability', type: 'string' },
  { name: 'dao', type: 'string' },
  { name: 'daoChainId', type: 'uint256' },
  { name: 'acceptPreVote', type: 'bool' },
  { name: 'acceptVoting', type: 'bool' },
  { name: 'attentionAmount', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'version', type: 'uint256' },
];
```

`GateEnrollment.purpose` MUST equal the exact signed literal `enrollment`. The server-generated challenge fixes this value; clients cannot choose or override it. `GateEnrollment.daoChainId` MUST equal the domain `chainId`; `version` MUST equal `1`. For the frozen Nouns MVP mapping, `dao` MUST equal the canonical service literal for Nouns, `acceptPreVote` MUST be `false`, and `acceptVoting` is the only stage opt-in.

For contract-wallet payout control, use this exact Base domain and primary type:

```ts
const basePayoutControlDomain = {
  name: 'GavelGate',
  version: '1',
  chainId: configuredBaseChainId,
  verifyingContract: configuredGateEnrollmentVerifierAddressOnBase,
};

const BasePayoutControl = [
  { name: 'wallet', type: 'address' },
  { name: 'dao', type: 'string' },
  { name: 'purpose', type: 'string' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'version', type: 'uint256' },
];
```

`BasePayoutControl.purpose` MUST equal the literal `base_payout_control`. `wallet` is the enrolled Gate wallet and immutable payout identity; this proof cannot introduce or redirect to another payout address.

API-session authentication uses this exact domain and primary type:

```ts
const walletSessionDomain = {
  name: 'GavelGate',
  version: '1',
  chainId: roleAuthenticationChainId,
  verifyingContract: configuredGateEnrollmentVerifierAddressOnRoleChain,
};

const WalletSession = [
  { name: 'wallet', type: 'address' },
  { name: 'role', type: 'string' },
  { name: 'audience', type: 'string' },
  { name: 'purpose', type: 'string' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'issuedAt', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'version', type: 'uint256' },
];
```

`WalletSession.role` MUST be exactly one of `base_sender`, `dao_profile`, or `dao_inbox`. `base_sender` selects the configured Base chain and configured verifier on Base; `dao_profile` and `dao_inbox` each select the configured DAO chain and configured verifier on that chain. The challenge endpoint derives chain and verifier solely from this signed role; the caller cannot provide or override either. `WalletSession.audience` MUST equal the configured canonical Gate API origin/service identifier, and `WalletSession.purpose` MUST equal the literal `wallet_session`. This proof authenticates API access only; it never authorizes payment, payout changes, governance voting, proposal execution, or any other on-chain action.

For `BasePayoutControl` and `WalletSession`, `version` MUST equal `1`. `BasePayoutControl.dao` MUST equal the same canonical DAO literal used by the corresponding enrollment. All `issuedAt` and `expiry` values are Unix seconds, and verification requires `issuedAt <= now < expiry` within the service's configured maximum challenge lifetime.

For every type, nonces are cryptographically random, short-lived, one-use, persisted as consumed, and bound to the exact type, purpose, payload hash, expiry, domain chain ID, and verifier address, plus role, wallet, and audience where applicable. In particular, the persisted WalletSession challenge row binds the exact type + role + wallet + audience + chain + verifier + payload hash + expiry. They cannot be replayed across types, roles (including `dao_profile` versus `dao_inbox` on the same chain/verifier), purposes, wallets, chains, verifier deployments, service audiences, payload versions, or expiries, or reused to restore stale availability, stage, or price settings. A proof consumed by any permitted operation is consumed globally and cannot be reused by any other endpoint or profile operation.

### 7.2 Proof behavior

- **EOA:** recover the exact EIP-712 signer for the applicable schema and require equality with `wallet`. No second cross-chain identity proof is required.
- **Contract wallet/Safe on the DAO chain:** call `isValidSignature(digest, signature)` at `wallet` on the DAO chain and require ERC-1271 magic value `0x1626ba7e`. Revert, timeout, missing code, malformed return, or wrong magic fails closed.
- **Base payout control for a contract wallet:** at enrollment and every transition to `accepting_now`, use the injected bounded-time Base RPC to require nonempty current runtime code, verify a separate nonce-bound and expiring EIP-712 `BasePayoutControl` challenge via ERC-1271 at the same address on Base, and store `base_payout_code_hash = keccak256(currentCode)` with the accepting profile transition. Missing code, wrong magic, revert, timeout, or unverifiable code fails closed.
- **Fresh Base code check for every new contract-wallet quote:** after acquiring the voter/profile-scoped advisory/row lock and rereading availability, policy, `profile_version`, wallet kind, and stored `base_payout_code_hash`, the injected bounded-time Base RPC MUST call `eth_getCode` while the same database transaction/lock remains open, require nonempty current runtime code, and require `keccak256(currentCode) == stored base_payout_code_hash`. Every profile/policy update takes the same lock and increments `profile_version`. Missing or empty code, RPC failure/timeout, hash mismatch, or transaction failure rolls back and releases the lock before any Gate-owned snapshot, submission, quote, or reservation persistence, using only coarse `rejected_by_policy` or service-unavailable semantics that reveal no code details. EOAs skip the RPC but use the same final locked rereads. It applies only to new quote issuance; already-issued valid quotes remain payable after later code drift. Bytecode-hash equality is only the frozen MVP drift check and does not prove unchanged owners/controllers for an upgradeable wallet; the explicit `BasePayoutControl` proof remains required at enrollment and every transition to `accepting_now`.
- **Wallet session:** for an EOA, recover the exact signer and require equality with `WalletSession.wallet`; for an ERC-1271 wallet, call `isValidSignature` on the server-derived role chain. The proof domain chain and verifier MUST match that role exactly. The same address authenticated on another chain grants no authority, including when bytecode or ERC-1271 controllers differ across chains.
- **Payout identity:** `wallet == voter == payout wallet`. There is no payout override.
- **MVP payer identity:** the advocate/payer MUST be an EOA for the Base native-USDC EIP-3009 `v,r,s` authorization path. ERC-1271 support applies to Gate enrollment/governance authority and the voter payout identity; it does not make contract-wallet payers valid. Base-sender session/checkout and quote issuance MUST reject a contract-wallet payer before creating or returning a quote. Safe or other contract-wallet payer support is post-MVP; do not change the splitter ABI or add an alternate payer path.

### 7.3 Challenge verification and nonce consumption

- `POST /v1/gate/auth/challenge` may issue a challenge for exactly `GateEnrollment`, `BasePayoutControl`, or `WalletSession`. A `GateEnrollment` challenge always fixes signed `purpose` to `enrollment`; clients cannot choose or override it. For `WalletSession`, only the signed literal roles `base_sender`, `dao_profile`, and `dao_inbox` are accepted, and the server derives the permitted chain and verifier from that role; clients cannot choose or override either.
- `POST /v1/gate/auth/verify` accepts only an exact `WalletSession` proof. In one atomic operation it compares the submitted exact type + signed role + wallet + audience + domain chain + verifier + payload hash + expiry with the persisted nonce challenge row, verifies on the role-derived chain, consumes that nonce, and creates a short-lived session bound to wallet + role + chain + audience. Any mismatch consumes nothing and creates no session. A proof for one role cannot mint another role even when `dao_profile` and `dao_inbox` share chain and verifier. It MUST reject a `GateEnrollment` or `BasePayoutControl` proof as the wrong purpose/type; those proofs are never pre-verified or consumed here.
- `PUT /v1/gate/me/profile` requires exact role `dao_profile` and receives the exact `GateEnrollment` proof and, when required by section 7.2, the exact `BasePayoutControl` proof. The session wallet, `GateEnrollment.wallet`, and `BasePayoutControl.wallet` when present MUST be exactly equal. It compares the exact signed `GateEnrollment.purpose == 'enrollment'` with the purpose persisted in `auth_nonces`, verifies every required proof, and consumes all operation-proof nonces in the same database transaction as the profile/policy write. A missing, mutated, or wrong purpose fails verification without consuming the nonce or writing any profile/policy change. The write acquires the same voter/profile-scoped advisory/row lock used by quote issuance and atomically increments `profile_version`, including on Base payout hash change. Any other validation failure or rollback likewise consumes neither operation-proof nonce and writes no profile or policy change. Replay fails, including reuse of a proof consumed anywhere else.
- Private inbox list/show/archive requires exact role `dao_inbox` whose session wallet is exactly the enrolled profile wallet. Submission creation, settlement submission/control, and resume require exact role `base_sender` whose session wallet is exactly the payer/signed sender. Public coarse status requires no session and carries no quote, resume, or private control.

## 8. Nouns lifecycle truth

The Gate adapter output vocabulary is `PRE_VOTE | VOTING | CLOSED`, but labels are not permission to invent a native state.

The Nouns adapter consumes only upstream canonical labeled native states such as `ACTIVE`. Raw Governor numeric state codes MUST be normalized to those labels upstream of `@gavel/gate`; the adapter never interprets numeric codes itself. In particular, numeric `1` and string `"1"` both fail closed to `CLOSED`.

The currently established Nouns canonical vote-preparation mapping is:

| Nouns Governor native state | Gate state available in MVP | Rule |
| --- | --- | --- |
| `ACTIVE` | `VOTING` | Supported only when the canonical voting window and fresh index data agree. |
| every non-`ACTIVE` or unknown state | `CLOSED` | Fail closed unless a future tested Gate adapter explicitly adds another native mapping. |

Although the Governor vocabulary includes `PENDING`, PR 0 does not assert that it is an actionable Gate pre-vote lane. Therefore **Nouns `PRE_VOTE` is not exposed by the MVP until an adapter maps a real native Nouns state from available canonical data and tests that mapping.** Public policies and enrollment responses must expose only supported mappings; they must not advertise or accept `PRE_VOTE` merely because the normalized vocabulary contains it. Mapping expansion is post-MVP unless separately reviewed and frozen.

Every issuance snapshot stores native state, normalized state, adapter mapping version, source block/hash, refresh time, proposal content hash, and actions. Nouns freshness is configurable and defaults to 15 minutes. An unhealthy or stale index prevents quote issuance.

## 9. Quote contract

### 9.1 Lifetime and identity

- `quoteId` is a cryptographically random, opaque, single-use 32-byte value (`bytes32`). It is never derived from content. The same value is the native-USDC EIP-3009 authorization nonce: `authorization.nonce == quote.quoteId`.
- Quote lifetime is exactly 10 minutes from issuance. Settlement requires the strict comparison `block.timestamp < quote.expiry`; at `block.timestamp == quote.expiry`, both the quote and its authorization are expired.
- Quote IDs remain single-use independently in both the splitter `usedQuoteIds` mapping and database. Native-USDC nonce consumption is additional replay protection, not a replacement for either check.
- The server persists every signed field and quote signature. In the same issuance transaction, it creates the immutable quote-to-submission and submission-to-snapshot relationships before signing/returning the quote; the snapshot stores the canonical content hash. The typed Quote binds only `submissionHash`, not `snapshotId` or snapshot content hash directly.
- A valid unexpired quote remains payable despite later price, policy, availability, stage, or capacity changes.

### 9.2 EIP-712 domain and primary type

Production Base uses chain ID `8453`; test deployments use their configured Base test chain ID. The verifying contract is the exact splitter deployment.

```ts
const domain = {
  name: 'GavelGateSplitter',
  version: '1',
  chainId: configuredBaseChainId,
  verifyingContract: splitterAddress,
};

const Quote = [
  { name: 'quoteId', type: 'bytes32' },
  { name: 'payer', type: 'address' },
  { name: 'voter', type: 'address' },
  { name: 'attentionAmount', type: 'uint256' },
  { name: 'gavelFeeAmount', type: 'uint256' },
  { name: 'submissionHash', type: 'bytes32' },
  { name: 'token', type: 'address' },
  { name: 'expiry', type: 'uint256' },
  { name: 'quoteVersion', type: 'uint256' },
];
```

`chainId` and `verifyingContract` exist only in the EIP-712 domain, not as duplicate quote fields. Domain construction and signing MUST require `quote.quoteVersion == 1`; unsupported versions fail closed. `gavelFeeAmount` must equal `250_000`; `attentionAmount` must be at least `1_000_000`; `token` must equal configured canonical Base native USDC.

## 10. Exact Base USDC EIP-3009 settlement

Native Base USDC uses this exact EIP-712 authorization domain:

```ts
const usdcAuthorizationDomain = {
  name: 'USD Coin',
  version: '2',
  chainId: configuredBaseChainId, // 8453 in production
  verifyingContract: configuredNativeUsdcAddress,
};

const ReceiveWithAuthorization = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];
```

The production `verifyingContract` is canonical Base native USDC, currently `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Before enabling checkout, every deployment MUST read and verify the configured token's runtime `name()` and `version()`, chain ID and token address, and computed/onchain domain separator against the configured domain. Test tokens use their own actual domain and MUST be labeled test-only; a test-token signature does not establish native-USDC compatibility.

The exact EIP-3009 primary type is `ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)` with the ordered fields above. The payer, which MUST equal the signed sender in MVP, signs native USDC authorization for exactly:

```text
receiveWithAuthorization(
  from = quote.payer,
  to = splitterAddress,
  value = quote.attentionAmount + quote.gavelFeeAmount,
  validAfter = 0,
  validBefore = quote.expiry,
  nonce = quote.quoteId,
  v, r, s
)
```

The browser/wallet checkout MUST construct and sign exactly that deterministic authorization; it cannot choose the nonce or time-window values. The splitter verifies the server quote signature, quote domain, single-use quote ID, token, exact fixed fee, nonzero payer/voter, and every authorization binding before calling USDC. It MUST require all of these Solidity-style comparisons:

```solidity
block.timestamp < quote.expiry
quote.quoteVersion == 1
quote.attentionAmount >= 1_000_000
authorization.from == quote.payer
authorization.to == address(this)
authorization.value == quote.attentionAmount + quote.gavelFeeAmount
authorization.nonce == quote.quoteId
authorization.validAfter == 0
authorization.validBefore == quote.expiry
```

The random single-use `quoteId` therefore doubles as the single-use native-USDC authorization nonce. This cryptographically prevents an authorization intended for quote A from being paired with quote B, including when both quotes have the same payer and total amount. The splitter mapping and database still enforce quote-ID single use independently; USDC nonce consumption adds another replay barrier.

A relayer caller may differ from `payer`; payment authority comes only from the payer's valid EIP-3009 signature. The splitter marks the quote used before the external USDC call, then calls `usdc.receiveWithAuthorization(...)` as both the authorization `to` and `msg.sender`. Native USDC requires `msg.sender == to` for this receive flow, so a third party that copies a pending signature cannot redeem it by calling USDC directly. Before that call, the splitter still verifies the quote signature, `quoteVersion`, values, signer, expiry, authorization bindings, and `usedQuoteIds`. It then performs exactly two transfers:

1. `attentionAmount` to `voter`;
2. `250_000` to the immutable Gavel recipient.

Any failure reverts the entire transaction, including quote-use marking and both legs. Successful settlement emits exactly this event declaration:

```solidity
event QuoteSettled(
    bytes32 indexed quoteId,
    address indexed payer,
    address indexed voter,
    uint256 attentionAmount,
    address gavelRecipient,
    uint256 gavelFeeAmount,
    address token,
    bytes32 submissionHash
);
```

This complete declaration fixes the event signature and indexed fields. No extra event fields are part of settlement verification. The server credits only this event from the configured splitter on the configured Base chain after one confirmation, only when every event field equals the stored quote, and only when the immutable stored quote has `quoteVersion == 1`; unsupported versions fail closed. Durable canonical-log scanning discovers it independently of any supplied transaction hash; token transfers, transaction success alone, and a supplied hash never establish settlement.

## 11. Policy and capacity

- Availability is global: `accepting_now`, `paused`, or `closed`; there is no unpublished profile state.
- Direct profiles remain public. Directory results default to `accepting_now` and recent opt-ins; power sort/filter is optional.
- Per-DAO policy contains enabled status, only adapter-supported accepted stages, attention amount, and public tags. The default is VOTING only.
- Only `accepting_now` issues new quotes.
- Global default capacity is **25 settled submissions in a rolling 24-hour window**.
- Pending reservation liabilities—both active unexpired and `expiry_pending_reconciliation`—are capped at `floor(capacity * 0.5)`: **12** at the default capacity.
- One active unexpired quote is allowed per signed `sender × voter` pair and is checked as a predicate under the voter/profile-scoped advisory/row lock; `sender × voter` is not the lock key.
- Default maximum is **two settled submissions per signed sender, voter, and proposal in the same rolling 24-hour window used by global capacity**.
- The exact canonical `submission_hash` is globally unique across Gate submissions, independent of internal status. Same-authenticated-sender retries use the frozen `409 duplicate` existing/resume contract; other callers get no existence confirmation. Content changes produce a different hash but do not bypass the active-quote or settled sender/voter/proposal limits.
- After no exact-hash match exists, sender and IP quote-rate limits and private sender blocks are enforced before issuance.
- Wall-clock expiry marks the quote payment-terminal and its reservation `expiry_pending_reconciliation` but does not release capacity. Only scanner-proven one-confirmation-safe coverage of every eligible pre-expiry block with no match releases it transactionally; a later exceptional valid pre-expiry canonical event supersedes release and settlement reconciles it to final consumed.
- A valid quote is honored after a later state/policy/capacity change.
- No API exposes capacity count, remaining count, pending reservation count, or reset time.
- Exact current governance power and its canonical `asOf` time are public but never alter availability. A zero-power profile may remain accepting.

Quote validation order is fixed:

1. parse, size, CommonMark, and evidence URL validation;
2. authenticate exact WalletSession role `base_sender` and require `payer == authenticated sender`;
3. compute the canonical submission hash and perform the owner-bound global exact-hash lookup before any mutable block, rate, profile, policy, canonical-index, lifecycle, limit, or capacity check; an owned match returns the frozen `409 duplicate` response without mutating or refreshing it;
4. if no match exists, enforce sender block/rate checks, then profile availability and DAO policy/stage;
5. acquire the voter/profile-scoped advisory/row lock and keep its database transaction open through quote commit; under it reread availability, policy, monotonic `profile_version`, wallet kind, and stored `base_payout_code_hash`;
6. for a contract-wallet voter, while holding that lock call bounded Base `eth_getCode`, require nonempty code, and require its `keccak256` to equal the just-reread stored `base_payout_code_hash`; an EOA voter skips the RPC;
7. under the same lock fetch/verify a fresh canonical proposal snapshot, recheck exact hash for race closure, enforce the max-two settled sender/voter/proposal rolling limit and one active unexpired quote per signed sender × voter, then check settled capacity and all pending liabilities including expiry-pending reservations;
8. under that same lock and transaction, generate the independent CSPRNG `publicId` with at least 128 bits of entropy and collision retry, create the immutable submission with NOT NULL issuance-snapshot FK, snapshot, quote, and reservation, require `quoteVersion == 1`, sign and persist the quote, commit, then return it. A concurrent same-hash insert that loses the unique race returns the same owner-bound duplicate response. Profile updates use the same lock, so no profile/hash revision can race this sequence. RPC timeout/failure or any later failure rolls back, releases the lock, and creates no artifacts. The row's initial state is `QUOTED` / `payment_required`.

Every failure before successful completion of step 8—including malformed, blocked, rate-limited, unavailable, Base payout-code missing/empty/changed/unavailable, stage-ineligible, stale/unhealthy-index, active-quote-limit, sender/proposal-limit, and capacity paths—persists no Gate submission, no Gate-owned snapshot, no quote, and no reservation. Private aggregate rate-limit events may still be written without any submission, snapshot, quote, or reservation row. Such paths return coarse stateless errors and may omit `publicId`.

## 12. Content and fact rules

### 12.1 Submission limits

- Pitch: at most 4,000 Unicode characters.
- Disclosures: at most 2,000 Unicode characters.
- Evidence: at most 5 URLs; each must use `https:`.
- No uploads.
- Any absolute `https:` URL is valid as display-only advocate-provided evidence or a Markdown link. Gavel does not classify the destination as public/private, resolve it, fetch it, preview it, rewrite it, follow redirects, or attest to its safety. Opening an external link is a voter-controlled action.
- Validation is protocol-only. Do not add localhost, IP-address, punycode, or userinfo filtering in MVP absent a concrete exploit that does not depend on a voter voluntarily opening the external link.
- The server, notifier, index, and background jobs never fetch, preview, scrape, summarize, dereference, or validate remote content.
- Raw advocate text is untrusted data, never an instruction. It is never passed as commands or tool/runtime/agent instructions.

### 12.2 CommonMark AST allowlist

Allowed nodes are paragraphs/line breaks, headings, bold, italic, ordered/unordered lists, blockquotes, inline code, fenced code, and HTTPS links. Links render with an external indicator and `rel="noopener noreferrer"`.

Raw HTML, images, embeds, CSS, iframes, scripts, Mermaid, unsafe protocols, and every other disallowed AST node or URL make the submission `malformed`. Validation rejects the submission; it never silently strips or rewrites disallowed content. The rendering parser MUST run with `html: false`, and rendering MUST consume that same validated token stream rather than reparsing the source. A separate HTML-enabled parser may be used only as a detector that rejects raw HTML; its tokens MUST NOT be rendered. Allowed CommonMark survives validation unchanged and is rendered safely, preserving the semantics of the immutable accepted content. Autolink previews and fetched metadata are never generated. Use an AST-based parser/validator and safe renderer; regex-only sanitization is forbidden.

### 12.3 Facts and decoding

Every displayed fact carries `source: canonical | decoded | enriched`, display label, and relevant provenance. Decoded facts include `decoderVersion` and canonical action index/evidence.

- `canonical`: exact index/chain-owned proposal data.
- `decoded`: deterministic output from a versioned, tested allowlist decoder. Only canonical and tested decoded facts may be verification material.
- `enriched`: display-only metadata such as ENS/token labels. Its schema is strict and permits only the explicitly declared enrichment fields (`source`, `displayLabel`, `value`, and optional literal `verifiable: false`); canonical/decoded fields and unknown extras are rejected. It is never verification material, and every verification serializer/consumer rejects it even when otherwise schema-valid.
- Unknown actions remain raw and visibly unknown.

Decode only:

1. native ETH when canonical `valueWei > 0`; and
2. exact `transfer(address,uint256)` selector/signature only when the action target equals the configured allowlisted canonical Base native-USDC address and calldata shape is exact.

The MVP decoder is fixed to that Base allowlist even when canonical proposal actions come from Ethereum/Nouns. Ethereum mainnet USDC (`0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`) and every other Nouns-chain token action remain raw until a separately designed chain-aware decoder exists post-MVP. Proxy, delegatecall, multicall, unknown token, malformed data, and arbitrary ABI-looking calldata remain raw. ENS always displays with its address. Estimated block times are labeled **estimated** and shown in Pacific Time. Evidence URLs are display-only HTTPS references and no server component fetches them.

There is no prose claim extraction, omission detection, contradiction scoring, rhetoric classification, or persuasion verdict in MVP.

## 13. HTTP API contract

All JSON uses decimal strings for token amounts and Unix-second decimal strings for EIP-712 times. Wallet addresses are returned in the service's documented canonical address form. Error bodies use stable coarse codes and do not reveal private policy data.

Every “session” below means a short-lived API session minted only after successful verification of the exact `WalletSession` schema and role-derived domain in section 7.1. A session inherits that wallet identity, audience, role, and chain and grants no payment or governance-execution authority. The only authenticated API-session transport in MVP is `Authorization: Bearer WALLET_SESSION`. Session and capability material MUST NOT appear in URLs, query strings, request bodies, or logs. Submission, quote, settlement, resume, and public status responses set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

### 13.1 Endpoint inventory

| Method and path | Auth | Contract |
| --- | --- | --- |
| `POST /v1/gate/auth/challenge` | Public | Issue one short-lived, one-use challenge using exactly `GateEnrollment`, `BasePayoutControl`, or `WalletSession` and its section 7.1 domain. For a session challenge, accept only signed role `base_sender`, `dao_profile`, or `dao_inbox`; derive chain/verifier from role and reject client overrides. |
| `POST /v1/gate/auth/verify` | Exact `WalletSession` proof only | Atomically compare every signed/domain value with the nonce row, verify on the role-derived chain, consume the nonce, and return a short-lived wallet/role/chain/audience-bound session. Reject role mutation even across the shared DAO chain/verifier, and reject `GateEnrollment`/`BasePayoutControl`. |
| `PUT /v1/gate/me/profile` | Exact `dao_profile` session; exact proofs in request | Require exact equality of the session wallet, `GateEnrollment.wallet`, and `BasePayoutControl.wallet` when required; verify proofs and atomically consume operation-proof nonces with the voter/profile-scoped advisory/row-lock profile/policy write and `profile_version` increment. |
| `GET /v1/gates` | Public | List public profiles. Supports `dao=nouns`, `availability`, `minVotingPower`, `sort=recent\|power`; defaults to accepting/recent. |
| `GET /v1/gates/:wallet` | Public | Return a public profile in every availability state. |
| `POST /v1/gates/:wallet/submissions` | Exact `base_sender` session equal to payer/signed sender | Run all pre-payment validation and return either a quote with `payment_required` or a coarse rejection. The session authenticates API access and does not authorize payment or governance execution. |
| `POST /v1/submissions/:publicId/settlement` | Exact `base_sender` session equal to payer/signed sender | Record a Base tx hash as `pending_settlement`; does not create an inbox. |
| `GET /v1/submissions/:publicId/resume` | Exact `base_sender` session equal to payer/signed sender | Resume the original unexpired quote/payment payload or return its coarse pending/accepted/expired state. The URL contains only opaque `publicId`, never a bearer capability. |
| `GET /v1/submissions/:publicId/status` | Public by random opaque `publicId` | Return only `publicId`, current coarse public state, and the enumerated safe timestamp for that state (`acceptedAt` for accepted; `updatedAt` for payment-required/pending/expired; none otherwise). Never return private controls or data. Set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. |
| `GET /v1/gate/me/inbox` | Exact `dao_inbox` session equal to enrolled profile wallet | Return private inbox summaries. |
| `GET /v1/gate/me/inbox/:id` | Exact `dao_inbox` session equal to enrolled profile wallet | Return immutable pitch beside canonical/decoded/enriched/raw-unknown facts. |
| `POST /v1/gate/me/inbox/:id/archive` | Exact `dao_inbox` session equal to enrolled profile wallet | Archive privately; no public status change. |

### 13.2 Authentication and profile-write examples

`POST /v1/gate/auth/verify` is exclusively the `WalletSession` exchange:

```json
{
  "proofType": "WalletSession",
  "typedData": { "primaryType": "WalletSession", "domain": "EXACT_ROLE_DERIVED_SECTION_7_1_DOMAIN", "message": "EXACT_SECTION_7_1_MESSAGE" },
  "signature": "WALLET_SESSION_SIGNATURE_BYTES"
}
```

On success, verification, exact nonce-row comparison, WalletSession nonce consumption, and short-lived wallet + role + chain + audience session creation are atomic. Role mutation, nonce-row role mismatch, or reuse of a `dao_profile` proof as `dao_inbox` fails even though both roles share a chain/verifier. Sending `proofType: "GateEnrollment"` or `proofType: "BasePayoutControl"` fails with a coarse wrong-purpose/type error and consumes no nonce.

`PUT /v1/gate/me/profile` carries profile proofs directly; they are not first sent to `/auth/verify`:

```json
{
  "gateEnrollmentProof": {
    "typedData": { "primaryType": "GateEnrollment", "domain": "<exact section 7.1 domain>", "message": "<exact section 7.1 message and profile/policy values>" },
    "signature": "0x<gate-enrollment-signature>"
  },
  "basePayoutControlProof": {
    "typedData": { "primaryType": "BasePayoutControl", "domain": "<exact section 7.1 Base domain>", "message": "<exact section 7.1 message>" },
    "signature": "0x<base-payout-control-signature>"
  }
}
```

`basePayoutControlProof` is omitted only when section 7.2 does not require it. The server verifies the complete required proof set and atomically consumes its nonces with the profile/policy write; a validation failure or transaction rollback consumes neither proof and changes nothing.

### 13.3 Public profile example

```json
{
  "wallet": "0x1111111111111111111111111111111111111111",
  "ens": null,
  "availability": "accepting_now",
  "acceptingSubmissions": true,
  "message": null,
  "policies": [{
    "dao": "nouns",
    "supportedStages": ["VOTING"],
    "acceptedStages": ["VOTING"],
    "attentionAmount": "1000000",
    "gavelFeeAmount": "250000",
    "tags": ["public-goods"]
  }],
  "governancePower": {
    "dao": "nouns",
    "amount": "3",
    "asOf": "2026-09-13T23:50:00.000Z"
  }
}
```

For any unavailable reason, including private capacity exhaustion:

```json
{
  "wallet": "0x1111111111111111111111111111111111111111",
  "availability": "accepting_now",
  "acceptingSubmissions": false,
  "message": "Not currently accepting new submissions"
}
```

No count or reset appears.

### 13.4 Quote/payment-required example

```json
{
  "publicId": "sub_3fK8sQ2vN7xM4pR9tW6yZa",
  "state": "payment_required",
  "updatedAt": "2026-09-14T00:00:00.000Z",
  "quote": {
    "domain": {
      "name": "GavelGateSplitter",
      "version": "1",
      "chainId": 8453,
      "verifyingContract": "0x2222222222222222222222222222222222222222"
    },
    "message": {
      "quoteId": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "payer": "0x3333333333333333333333333333333333333333",
      "voter": "0x1111111111111111111111111111111111111111",
      "attentionAmount": "1000000",
      "gavelFeeAmount": "250000",
      "submissionHash": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "expiry": "1789344600",
      "quoteVersion": "1"
    },
    "totalAmount": "1250000",
    "signature": "0x<server-quote-signature>"
  }
}
```

The complete quote signature is returned only to the original sender's authenticated wallet-bound session; it is not part of an anonymously enumerable receipt.

For this example, checkout constructs the authorization with `validAfter = 0`, `validBefore = 1789344600`, and `nonce = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`. These are deterministic derivatives of the unchanged Quote message, not additional Quote fields or wallet-selected values. `updatedAt` describes the coarse Gate transition into `payment_required`. `acceptedAt` is `inbox_created_at`, generated by the database when the inbox row is inserted inside the atomic transaction and exposed only after commit; it is not receipt block time, transaction-start time, notification time, delivery/read time, or an exact commit timestamp. It may be after quote expiry when private receipt evidence proves inclusion strictly before expiry.

### 13.5 Pending and accepted receipt examples

```json
{
  "publicId": "sub_3fK8sQ2vN7xM4pR9tW6yZa",
  "state": "pending_settlement",
  "updatedAt": "2026-09-14T00:01:00.000Z"
}
```

```json
{
  "publicId": "sub_3fK8sQ2vN7xM4pR9tW6yZa",
  "state": "accepted",
  "acceptedAt": "2026-09-14T00:02:00.000Z"
}
```

The accepted response contains no notification, delivery, read, open, click, channel, destination, retry, or voter-action field.

### 13.6 Coarse rejection examples

```json
{
  "state": "rejected_by_policy",
  "error": { "code": "NOT_ACCEPTING", "message": "Not currently accepting new submissions" }
}
```

```json
{
  "state": "malformed",
  "error": { "code": "INVALID_SUBMISSION", "message": "Submission content is invalid" }
}
```

A distinct submission blocked by sender/voter limits is coarse and exposes no existing receipt state or count:

```json
{
  "state": "rejected_by_policy",
  "error": { "code": "ACTIVE_QUOTE_EXISTS", "message": "Submission is not currently eligible" }
}
```

The same shape uses `SENDER_PROPOSAL_LIMIT` for an otherwise-distinct third settled submission in the rolling window. Only an exact global hash match returns `duplicate`.

For the same authenticated signed sender, an exact-hash retry returns HTTP `409`:

```json
{
  "state": "duplicate",
  "existing": {
    "publicId": "sub_3fK8sQ2vN7xM4pR9tW6yZa",
    "state": "payment_required",
    "resumeUrl": "/v1/submissions/sub_3fK8sQ2vN7xM4pR9tW6yZa/resume"
  }
}
```

The path contains no secret. The original sender must send `Authorization: Bearer WALLET_SESSION`. The authenticated resume endpoint may return the original quote/payment payload while unexpired, resume controls, pending status, accepted status, or `expired` (payment disabled and reconciliation-qualified by section 4.2). The separate status endpoint is public by random opaque `publicId` and returns only coarse state plus the enumerated safe timestamp, never quote/payment/resume/private data or controls, and sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. A rejected request created no row and may be retried unchanged. Because payer is in the hash and must equal the authenticated sender, another wallet cannot naturally reach the same hash lookup absent collision or forged authentication; unauthenticated requests stop before hashing/deduplication.

A stale/unhealthy canonical index returns HTTP `503` with `CANONICAL_DATA_UNAVAILABLE`, creates no Gate submission, Gate-owned snapshot, quote, or reservation, and may omit `publicId`.

## 14. Failure semantics

| Condition | HTTP/public behavior | Required side effect |
| --- | --- | --- |
| Invalid JSON/schema, oversized content, or disallowed Markdown AST node/URL | `400`, `malformed`; reject before hashing | No Gate submission, snapshot, quote, or reservation |
| Invalid/forged sender proof or payer/sender mismatch | `400`/`401`, coarse auth error; reject before hashing | No Gate persistence and no duplicate lookup |
| Missing/expired session where required | `401` with coarse auth code | No private data |
| Exact submission hash recomputed for the authenticated original sender of an earlier successful quote | `409`, `duplicate`, with `existing: { publicId, state, resumeUrl }`; resume URL is opaque path-only and session-authenticated | Never insert or quote a second row; resume original unexpired payment, pending, accepted, or expired result |
| Guessed `publicId` used for resume/quote/private access, forged ownership, or deliberate direct-store/hash collision fixture | `401`/`403` or coarse failure without owner/private-state confirmation; the separate public status route remains coarse by contract | Fail closed; never disclose quote, resume controls, owner, or private state |
| No exact-hash match, then unsupported Nouns stage, unavailable Gate, block/rate/policy denial | `403` or `429`, stateless `rejected_by_policy` with coarse reason | No Gate submission/snapshot/quote/reservation; private aggregate rate-limit events may persist; no capacity disclosure |
| Contract-wallet voter Base code is missing, empty, changed, or unavailable/timeout before a new quote | Coarse stateless `rejected_by_policy` or `503` service-unavailable response with no code detail | Fail closed before Gate-owned snapshot/submission/quote/reservation persistence; an already-issued valid quote remains payable |
| Distinct submission while sender × voter has an active unexpired quote | `409`, stateless `rejected_by_policy`, code `ACTIVE_QUOTE_EXISTS` | No Gate submission/snapshot/quote/reservation; disclose no private count/detail |
| Otherwise-distinct third settled submission for sender × voter × proposal in rolling 24 hours | `409`, stateless `rejected_by_policy`, code `SENDER_PROPOSAL_LIMIT` | No Gate submission/snapshot/quote/reservation; disclose no private count/detail |
| Stale/unhealthy/uncertain canonical index or RPC | `503`, coarse canonical-data error | Fail closed; no Gate submission/snapshot/quote/reservation |
| Capacity/pending limit reached | `403` or `429`, stateless `rejected_by_policy`; public message only says not accepting | No submission/snapshot/quote/reservation row; private aggregate rate-limit events may persist; never expose counts or reset |
| Local quote expiry before eligible pre-expiry blocks are safely covered | `410`, `expired`, with coarse Gate `updatedAt`; browser disables checkout and MUST NOT submit a new authorization/payment attempt | Mark `expiry_pending_reconciliation`; keep capacity reserved and count it as pending liability |
| One-confirmation-safe scanner proves complete eligible pre-expiry range coverage with no valid event | Remains `expired`; no new authorization/payment attempt | Release in the crash-safe cursor/range transaction; trailing-overlap and reorg rules continue |
| Matching event included at receipt block timestamp `>= quote.expiry` | `410`, `expired` | Never credit, consume capacity, or create inbox |
| Matching event included before expiry but confirmed/processed after expiry or release | `accepted` only after atomic Gate commit, with database-generated `inbox_created_at` as `acceptedAt` | Atomic `EXPIRED`/released → `SETTLED + INBOX_CREATED`: reconcile to consumed, count once, create one inbox, enqueue notification, and upsert reorg monitor |
| `quote.quoteVersion != 1` at signing, splitter settlement, or server verification | Coarse malformed/unsupported-version failure; splitter reverts before USDC | Fail closed; no payment credit, capacity, inbox, notification, or monitor |
| EIP-3009 nonce is not `quote.quoteId`, `validAfter` is not `0`, or `validBefore` is not `quote.expiry` | Settlement reverts before the USDC call | No quote consumption, payment, settled capacity, or inbox |
| Tx hash malformed/wrong chain | `400`, `malformed` | No inbox |
| Tx pending/unconfirmed | `202`, `pending_settlement` | No inbox |
| Tx dropped/reverted/mismatched/no expected event | Return to `payment_required` while quote valid, otherwise `expired` | No settled capacity or inbox |
| Confirmed matching event included strictly before expiry | External truth; `accepted` only after the atomic Gate DB transaction commits, with database-generated `inbox_created_at` as `acceptedAt` | In one commit: settle once, reconcile reservation to final consumed/count capacity once, create exactly one inbox, enqueue notification, and idempotently upsert the reorg monitor |
| Lifecycle changes after quote | Still honor valid settlement | Inbox has issuance/current lifecycle and `stateChangedAfterQuote=true` |
| Current lifecycle unavailable, stale, timed out, or unknown after confirmation | Still honor valid settlement; never expose operational detail publicly | Store current lifecycle `UNKNOWN`, retain issuance state, set private `currentLifecycleUnavailable=true`, and complete the atomic settlement commit without critical-path lifecycle retry |
| Replayed event/poller retry | Idempotent existing result | Exactly one settlement and inbox |
| Pending/unconfirmed log reorged out before acceptance | `payment_required` while quote valid, otherwise `expired` | No inbox or settled capacity |
| Accepted log reorged out after atomic commit | Public remains `accepted`; no delivery/read/payment internals exposed | Set private `settlementReorgedAt`, record redacted anomaly, alert; never retract inbox, reopen quote, decrement capacity, refund/claw back/recharge, or retry the authorization automatically |
| Notification failure after atomic commit | Public remains `accepted`; settled capacity already counts | Private bounded retry only |
| Database failure before atomic settlement commit | Not accepted; retry the entire transaction idempotently | No settlement, reservation-consumption/capacity, inbox, notification-job, or reorg-monitor effect is visible |

Logs and metrics use opaque submission/quote IDs and coarse codes. Never log private destinations, full pitches by default, raw signatures, `Authorization` headers or wallet-session values, signer material, or complete payment authorizations. Submission, quote, settlement, resume, and public status responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

## 15. Deployment and real-USDC acceptance gate

All deployments remain labeled **experimental**. Base Sepolia or a mock EIP-3009 token does not prove Base native-USDC compatibility. Real USDC must not be enabled until every applicable gate below has recorded evidence.

### 15.1 Deployment boundaries

- Deploy one canonical `packages/server` service with Gate routes/workers and a dedicated least-privilege Gate DB role.
- Inject the dedicated no-funds quote signer only into that server runtime. Never place it in the indexer, web bundle, CLI, database, root shared `.env`, or logs.
- Keep Ethereum/Base RPCs, session/encryption secrets, notification credentials, canonical index URL, chain ID, USDC address, splitter address, recipient, confirmation depth `1`, and Nouns freshness `900` seconds explicit.
- Monitor per-chain/splitter forward-cursor lag/checkpoint failures, trailing-overlap scan lag, active monitor-queue depth/oldest age, final-check failures, unknown-quote anomalies, and `gate_settlement_reorg_total{phase="pre_acceptance|post_acceptance",source="overlap|monitor|operator"}` with redacted alerts.
- The deployment runbook MUST cover restart of both cursor and monitor queue, bounded queue backlog recovery, final checks after downtime, and post-acceptance response: preserve accepted/inbox/capacity, record private `settlementReorgedAt`, take no automatic payment action or authorization retry, and resolve missing canonical payout outside the protocol. It MUST state that automatic monitoring ends after the final check at 64 confirmations and deeper reorgs are residual operational risk detectable only by reconciliation.
- Splitter constructor values—USDC, Gavel recipient, quote signer—are immutable and source/bytecode verified.
- Signer rotation is a deployment migration with draining, not completion after a ten-minute wait. Pause issuance on the old splitter; retain its splitter address, signer/token configuration, deployment block, scanner cursor, and RPC access in the read-only draining registry; wait for its quotes to expire; deploy the new splitter; switch only new quote issuance to it; and resume issuance. Continue canonical scans for the old splitter until every old quote is reconciled and every accepted old-splitter reorg monitor has completed its final 64-confirmation check. Only then may its scanner configuration be retired. The old immutable contract and on-chain state remain in place; no funds or state migrate. This is multiple historical deployments on the one configured Base chain, not multi-chain payment settlement.

### 15.2 Hard acceptance checklist

The following payment tests are explicitly deferred to PR 9 and are nonblocking for PR 3: Base-mainnet USDC fork/integration; actual USDC EIP-712 domain compatibility; USDC pause/blacklist behavior; canceled EIP-3009 authorization; and a stronger adversarial invariant handler if one has not already been added. PR 9 MUST preserve and execute each item rather than treating mock-token or local unit results as equivalent evidence.

**Contract/payment**

- Foundry unit, fuzz, invariant, formatting, and static-analysis checks pass with outputs recorded.
- Native-USDC authorization tests locally recover/verify `ReceiveWithAuthorization` under the exact `USD Coin` / version `2` / configured chain/token domain and reject wrong name, version, chain ID, or token address. A signature over the distinct `TransferWithAuthorization` primary type fails when supplied to `receiveWithAuthorization`. Deployment checks the runtime token metadata and domain separator before checkout is enabled.
- Two independent reviews of the exact final Solidity diff have no unresolved critical/high issue.
- The splitter enforces `quote.attentionAmount >= 1_000_000` before the USDC call in addition to exact fee enforcement; `999_999` reverts, `1_000_000` succeeds, modifying the signed amount fails, and the signer cannot authorize a subminimum quote.
- Exact attention plus exactly `250_000` fee routes atomically; voter gets all attention.
- The splitter ABI declares exactly the frozen `QuoteSettled` event signature and three indexed fields, with no extra event fields.
- Splitter settlement requires `quote.quoteVersion == 1` and `block.timestamp < quote.expiry`; unsupported versions and equality/later expiry revert before USDC.
- The splitter requires `authorization.nonce == quote.quoteId`, `authorization.validAfter == 0`, and `authorization.validBefore == quote.expiry` before calling USDC, in addition to exact from/to/value checks.
- Adversarial tests prove unsupported `quoteVersion`, wrong `validAfter`, wrong `validBefore`, reused quote ID, wrong payer/voter/token/fee/amount/submission/domain/deployment, expired quote, malformed signature, used USDC nonce, and partial-transfer failures revert.
- A cross-quote substitution test creates two valid quotes from the same payer with the same total but different quote IDs/voters; pairing quote B with quote A's authorization reverts because `authorization.nonce != quoteB.quoteId`.
- A direct third-party call to USDC `receiveWithAuthorization` with a copied pending signature reverts because the caller is not the authorization `to`/splitter; calling through the splitter succeeds and routes the exact two legs.
- Any splitter implementation or call path invoking `transferWithAuthorization` is forbidden; ABI/source/static tests prove the splitter exposes and calls only `receiveWithAuthorization` for the authorization pull.
- Direct USDC dust neither blocks nor alters settlement and remains unrecoverable.
- ABI/bytecode has no owner, upgrade, admin, pause, refund, rescue, withdrawal, sweep, or receive/fallback path.

**Server/index/auth**

- Exact `GateEnrollment`, `BasePayoutControl`, and `WalletSession` domain/type/order/literal tests pass. PR 4 GateEnrollment tests freeze ordered fields `wallet,purpose,availability,dao,daoChainId,acceptPreVote,acceptVoting,attentionAmount,nonce,issuedAt,expiry,version`, require the exact signed literal `purpose == 'enrollment'`, and prove missing/mutated/wrong-purpose and replay attempts fail without consuming the nonce or changing profile/policy state. WalletSession tests require ordered signed `role` after `wallet`, only `base_sender|dao_profile|dao_inbox`, exact persisted nonce-row type + role + wallet + audience + chain + verifier + payload hash + expiry comparison, mutation rejection, global replay rejection, and atomic verify/consume/session creation. They cover role mutation, nonce-row role mismatch, replay/substitution across same-chain `dao_profile`/`dao_inbox`, endpoint-role mismatch, and the same address with a different-chain controller.
- Cross-chain ERC-1271 tests deploy the identical contract address on Base and Ethereum with different code/controllers and prove authority on one chain grants none on the other. Profile tests reject any mismatch among the DAO-chain session wallet, `GateEnrollment.wallet`, and required `BasePayoutControl.wallet`; inbox tests require exact enrolled-wallet equality, and submission/resume tests require exact payer/signed-sender equality.
- DAO-chain ERC-1271 success and wrong-magic/revert tests pass.
- Contract-wallet enrollment and every transition to accepting require a valid explicit Base payout proof against current nonempty Base code and atomically store its `keccak256` code hash. PR 4 tests cover proof failures, hash persistence, and do not claim bytecode equality proves unchanged upgradeable-wallet controllers.
- PR 5 new-quote tests prove the voter/profile-scoped advisory/row lock precedes final mutable rereads and bounded `eth_getCode`, every profile/policy update uses the same lock and increments `profile_version`, and quote commit remains in that transaction. They cover unchanged contract code success; disappeared, changed, empty, timeout, and RPC-failure rollback with lock release and no artifacts; EOA skip; an already-issued valid quote remaining payable after later drift; and a racing profile/Base-hash update where exactly one ordering wins and no stale-code quote issues.
- Wallet-to-payout redirection is impossible.
- Stale/unhealthy canonical data creates no Gate submission, Gate-owned snapshot, quote, or reservation.
- Global exact-hash tests cover every canonical preimage field and coarse existing persisted state. Tests prove parse/content validation, authentication, and payer/sender equality precede hashing; the owner-bound lookup precedes every mutable block/rate/profile/policy/index/lifecycle/limit/capacity check and does not mutate or refresh the existing row; and the voter/profile-scoped advisory/row-lock recheck plus unique-race loser returns the same frozen `409 duplicate`. Same-sender retries in payment-required, pending, accepted, and expired return that contract without a second row/quote. Unauthenticated requests never reach lookup, guessed public IDs cannot resume another submission, and a direct-store/hash-collision fixture fails closed without owner/state leakage. No impossible different-wallet same-hash test is required.
- Quote issuance tests perform the active-unexpired sender × voter predicate check under the voter/profile-scoped advisory/row lock and prove sender × voter is not the lock key. A second distinct request while an unexpired quote is active returns only `ACTIVE_QUOTE_EXISTS`; an otherwise-distinct third settled-limit request returns only `SENDER_PROPOSAL_LIMIT`; neither is `duplicate`, reuses prior state, exposes counts, or issues a quote.
- Quote/snapshot tests prove immutable quote → submission → issuance-snapshot FKs and canonical snapshot content hash, and prove Quote signing binds `submissionHash` without claiming snapshot fields are typed data or adding them to the submission-hash preimage.
- Tx hash alone never creates inbox and missing tx hashes do not prevent one; a durable forward cursor scans from deployment block through the one-confirmation-safe head and rescans the default 64-block trailing overlap every cycle. The atomic settlement transaction idempotently upserts the durable monitor by `chainId + splitter + quoteId`; rollback leaves neither acceptance nor monitor, restart cannot find accepted-without-monitor, and replay updates no duplicate row. The queue rechecks every accepted receipt block hash/exact log through a final check at 64 canonical confirmations. Tests cover rollback/restart/idempotent upsert, a reorg behind the forward cursor within overlap, a reorg found via the queue, restart/downtime, the final check, and a deeper-after-horizon reorg that explicitly does not mutate acceptance.
- Wrong event fields and dropped/reverted transactions create no inbox or settled capacity.
- Boundary-race and persistence tests prove: wall-clock expiry disables checkout but does not free a slot; active plus `expiry_pending_reconciliation` liabilities count toward pending/global checks; scanner safe-range no-match evidence releases the slot; a payment included just before expiry consumes it even when processed later; concurrent expiry/scanner/issuance cannot issue slot 26; and scanner timeout/rollback preserves the liability and releases locks. An exceptional valid late event after release may create temporary overcapacity, always receives its paid inbox, and blocks new issuance until the rolling count falls below capacity. Inclusion at or after expiry is rejected.
- Pre-acceptance reorg tests return to payment-required while valid or expired otherwise with no inbox. Reorgs detected during the 64-confirmation post-acceptance horizon preserve inbox, accepted state, quote finality, and capacity; set private `settlementReorgedAt`; alert operators; and perform no refund, clawback, recharge, or automatic authorization retry. Metrics/runbook state that deeper-after-horizon detection is not guaranteed.
- Reprocessing is idempotent; the one bounded lifecycle read is non-vetoing; lifecycle change is flagged if and only if known state differs; unavailable/stale/timeout/unknown records private unavailability and `UNKNOWN` without delaying the paid inbox; notification failure changes no public status.
- Serializer/log tests prove private state and receipt block evidence are absent, `acceptedAt == inbox_created_at` from the database row-insertion clock and is visible only after commit, and only the enumerated public timestamps appear.
- Public-ID tests prove at least 128 bits from a CSPRNG, opaque URL-safe format, DB uniqueness and collision retry, no derivation from stable content/quote/wallet/timestamp fields, and practical inability to enumerate or guess neighboring IDs without overclaiming impossibility. Public status remains public by that ID, exposes only coarse state plus its permitted timestamp, carries no private controls, and sets `Cache-Control: no-store` plus `Referrer-Policy: no-referrer`.

**UI/E2E**

- A human can discover a Gate, see exact power/as-of and public policy, submit constrained content, authorize EIP-3009, settle once, and receive accepted only after inbox creation.
- Unavailable direct profiles remain public without capacity details.
- Raw HTML, images, embeds, CSS, iframes, scripts, Mermaid, unsafe protocols, and every other disallowed Markdown node/URL are rejected as `malformed`, never stripped; allowed CommonMark survives validation unchanged and renders safely.
- The inbox shows raw advocacy beside canonical/decoded/enriched/raw-unknown facts with no omission/prose verdict.
- Evidence is never fetched.
- Base Sepolia E2E records enrollment through notification retry. If a test token is used, results are labeled test-token-only.
- Before wider mainnet use, deploy a **new** mainnet splitter with the real immutable `250_000` fee, verify it, and record a minimum-price real-native-USDC smoke settlement and associated git SHA/addresses/commands.
- Rotation runbook tests pause old-splitter issuance, retain its draining registry/cursor/RPC configuration, switch new issuance to the new splitter only after old quotes expire, continue old scans until all quotes reconcile and all accepted monitors complete their 64-confirmation final check, then permit retirement. They prove no contract, funds, or state migration and no multi-chain payment behavior.

## 16. MVP versus post-MVP

| Capability | MVP | Post-MVP |
| --- | --- | --- |
| Nouns VOTING native mapping | Yes, tested canonical mapping only | Additional DAOs/states |
| Nouns PRE_VOTE | Not exposed unless a real native mapping is implemented and tested | Mapping expansion after explicit review |
| One immutable pitch | Yes | Follow-up/response threads and explicit per-thread permission/pricing |
| Canonical + exact allowlisted decoding + labeled enrichment | Yes | Audited additional token/action decoders and hardened metadata caching |
| Side-by-side facts, no prose verdict | Yes | Optional structured claim lane and deterministic checks over canonical/tested decoded facts |
| Material-omission/LLM claim extraction/all prose checks | No | Separate future design only; never silently added |
| Base native USDC EIP-3009 | Yes | Ethereum/Arbitrum and chain-specific adapters such as Permit2/ERC-2612 |
| Email/one private notifier | Yes | XMTP, Telegram, digests |
| Deployment-migration signer rotation | Yes | Signer-key rotation registry/model |
| Server/database Gate registry | Yes | On-chain or signed public registry |
| Public Gate/policy and private inbox | Yes | Reputation, Kleros/disputes, optional unpublish/delete semantics |
| Experimental assurance | Yes | External human audit and broader production assurance |

No post-MVP capability may be smuggled into the MVP under an implementation detail.
