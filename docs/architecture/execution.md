# Gavel execution architecture

The core principle:

> Governance reasoning should not know how transactions are executed.
> Execution infrastructure should not know how governance decisions are made.

Everything below follows from that one boundary. See
`docs/architecture/EXECUTION_CURRENT_STATE.md` for the pre-refactor map this
design responds to.

## 1. The pipeline

```
                        GOVERNANCE LAYER
  ┌──────────────────────────────────────────────────────────────┐
  │  DAO Adapter                                                 │
  │      ↓                                                       │
  │  Proposal  ──→  Voter Model  ──→  Recommendation             │
  │                                        ↓                     │
  │                                    VoteIntent                │
  │                                        ↓                     │
  │                               ExecutionIntent                │
  │                                        ↓                     │
  │                             Canonical validation             │
  └────────────────────────────────┬─────────────────────────────┘
                                   ↓
════════════════════  ValidatedExecutionIntent  ════════════════════
                        EXECUTION BOUNDARY
                                   ↓
  ┌────────────────────────────────┴─────────────────────────────┐
  │  ExecutionEngine                                             │
  │    idempotency · replay · freshness · lifecycle · records    │
  │                          ↓                                   │
  │  ExecutionAdapter                                            │
  │    ├── SafeSupervisedExecutionAdapter     (shipping)         │
  │    ├── WaapAutonomousExecutionAdapter     (shipping)         │
  │    ├── UnsignedExecutor                   (shipping)         │
  │    ├── eoa-supervised                     (declared)         │
  │    ├── erc4337                            (declared)         │
  │    ├── bankr-wallet                       (declared)         │
  │    └── hardware-wallet                    (declared)         │
  └──────────────────────────────────────────────────────────────┘
                        EXECUTION LAYER
```

Everything above the double line is governance. Everything below it is
execution. `ValidatedExecutionIntent` is the only thing that crosses.

## 2. The three canonical artifacts

### VoteIntent — what Gavel intends to do

`packages/core/src/intent/vote-intent.js`

```js
{
  version: 1,
  dao: "nouns",
  chainId: 1,
  voterAddress: "0x…",     // the governance identity, not the caller
  proposalId: "42",
  support: "FOR" | "AGAINST" | "ABSTAIN",
  reason: "…" | null,
  createdAt: "2026-09-02T00:00:00.000Z",
  metadata?: { … }          // annotation; no security meaning
}
```

DAO-agnostic and execution-free. There is no calldata, no target, and nothing
naming a provider — no `safeTxHash`, no Safe nonce, no Safe delegate, no WaaP
session id, no API Kit configuration. Those belong further down.

`chainId` is a positive integer and 256-bit quantities are unsigned decimal
strings, following the convention already used across the repo's schemas: these
documents are persisted and hashed as JSON.

### ExecutionIntent — what exact onchain action should occur

`packages/core/src/intent/execution-intent.js`

```js
{
  version: 1,
  chainId: 1,
  actor: "0x…",             // whichever address must originate the call
  target: "0x…",
  value: "0",
  data: "0x…",
  operation: "CALL",
  source: {
    type: "governance-vote",
    dao: "nouns",
    action: "CAST_VOTE",
    proposalId: "42",
    support: "FOR",
    reason: "…" | null,
    voteIntentHash: "0x…"   // the audit link back to the decision
  }
}
```

Still provider-neutral. `actor` differs from `voterAddress` whenever voting
power is delegated to a separate execution address — a Safe, a WaaP wallet —
and the DAO adapter is what establishes that the delegation exists. How that
address is made to originate the call is the execution layer's problem.

`source.action` and `source.voteIntentHash` extend the original sketch:
`action` is what the adapter's `supportedActions` gate reads, and
`voteIntentHash` links the audit chain. Both are governance facts.

Only `CALL` is accepted. A `delegatecall` is never a governance vote.

### ValidatedExecutionIntent — this exact transaction passed Gavel validation

`packages/core/src/intent/validated.js`

```js
validated.intent        // the frozen ExecutionIntent
validated.intentHash    // the stable cross-system identity
validated.validation    // { adapterVersion, validatedAt, proposalState,
                        //   proposalStateVotable, governanceTarget, selector,
                        //   actorEligible, autonomyAllowed, deadline,
                        //   semantics, checks }
```

**This is the important architectural artifact.** Its constructor is gated by a
module-scoped symbol that is never exported, so the only code that can mint one
is `validateExecutionIntent()`. Identity is a private-field brand check rather
than `instanceof`, so `Object.create(ValidatedExecutionIntent.prototype)` does
not pass either.

The consequence is the intended asymmetry:

```js
executor.prepare({ to: attacker, data: arbitraryData })   // TypeError
executor.prepare(validatedIntent)                         // the only way
```

`toJSON()` is deliberately one-way. A document that crossed a process boundary
carries no evidence that a DAO adapter ever checked it, so re-entering the
boundary means re-validating against a live adapter. There is no exported
conversion that upgrades a document.

This replaces the previous `validated: true` field on prepared transactions,
which any caller could write for arbitrary calldata while producing a
self-consistent hash.

### What the seal proves, and what it does not

Stated precisely, because an overstated version of this was previously in this
document and is a defect in its own right.

**It proves** that `validateExecutionIntent()` ran with a DAO adapter and that
its checks passed (below), and that the intent has not been edited since.

**It does not prove that chain state was read.** `validateExecutionIntent()`
performs no I/O: it consumes `evidence` supplied by its caller. Live
verification is `GovernanceAdapter.prepareValidatedIntent()`, which calls the
adapter's `prepareVote()` against a provider and mints only from that result.

**It does not prove a genuine adapter was used.** The adapter is a parameter,
so code already executing in-process can supply a self-consistent fake adapter
and mint. What contains that is the layer above: the CLI resolves adapters from
a fixed registry of DAO ids and has no surface that accepts an adapter object,
and `gavel execution prepare` / `execution submit` take governance inputs and
re-run live validation rather than lifting a stored document. An attacker who
can already call arbitrary functions in the Gavel process is outside what a
type boundary can address.

**Validation does not trust the adapter's evidence.**
`validateExecutionIntent()`:

- re-derives the 4-byte selector from the calldata rather than believing the
  evidence's claim about it;
- requires the target to be an address the adapter **explicitly declared** in
  `governanceTargets`. There is no fallback to `governanceContracts`: that map
  holds every contract an adapter knows about (ENS's includes the token and the
  timelock), so falling back to it widened the allowed target set beyond the
  governor;
- requires the adapter to declare `governanceSelectors` for the action, and the
  calldata's selector to be one of them. An adapter that declared none used to
  accept any selector against a declared target, including a governor's own
  `execute`, `queue` or `cancel`;
- **requires the adapter to decode its own calldata** and cross-checks the
  encoded proposal, support and reason against `intent.source`. A selector says
  which function is called, not with what: the same valid
  `castRefundableVoteWithReason` selector encodes a vote FOR proposal 42 and
  AGAINST proposal 999, so without this the declared decision was unbound to
  the bytes. A decoder is mandatory rather than optional, because skipping the
  check silently is the hole;
- **requires** the originating VoteIntent and re-derives the `voteIntentHash`
  link. Made optional, the provenance could simply be omitted;
- requires `proposalStateVotable`, `actorEligible`, and that every check the
  adapter reported actually passed.

A buggy or compromised adapter cannot bless a call to an address it never
declared, and no caller can swap a vote's arguments behind a valid selector.

## 3. Intent hashing

`packages/core/src/intent/canonical.js`

Domain-separated SHA-256 over an ordered, JSON-encoded field list. The domain
tag is part of the hashed bytes, so a VoteIntent and an ExecutionIntent that
serialized identically still hash differently, and JSON encoding means a
`reason` containing a separator cannot forge another field.

**Hashed** — everything that decides what happens onchain, plus the governance
provenance that decides whether it may: `version`, `chainId`, `actor`,
`target`, `value`, `data`, `operation`, `source.type`, `source.dao`,
`source.action`, `source.proposalId`, `source.support`, `source.reason`,
`source.voteIntentHash`.

**Not hashed** — anything a provider or a retry invents: Safe nonce,
`safeTxHash`, transaction hash, provider request ids, submission timestamps.
Also not hashed: `VoteIntent.createdAt` and `metadata`, and the whole of
`validation`.

That split is what makes one hash serve deduplication, replay rejection, retry
safety, audit correlation and executor state keys at once. Excluding wall-clock
fields is load-bearing: two identical governance decisions must hash the same,
or deduplication cannot work.

`validation` is unhashed because the validated object is frozen and unforgeable
in-process; freezing is the protection, not the hash.

## 4. Execution modes

`packages/core/src/execution/modes.js`

A registry, not a branch. Each mode declares its kind (`OFFLINE`,
`SUPERVISED`, `AUTONOMOUS`), the DAO-adapter capability key that gates it, the
identity role it requires, and whether it is implemented.

| Mode | Kind | Capability | Identity | Status |
| --- | --- | --- | --- | --- |
| `unsigned` | OFFLINE | `prepareVote` | — | shipping |
| `safe-supervised` | SUPERVISED | `safeSupervised` | proposal | shipping |
| `waap-autonomous` | AUTONOMOUS | `waapAutonomous` | execution | shipping |
| `eoa-supervised` | SUPERVISED | `eoaSupervised` | proposal | declared |
| `erc4337` | SUPERVISED | `erc4337` | proposal | declared |
| `bankr-wallet` | AUTONOMOUS | `bankrWallet` | execution | declared |
| `hardware-wallet` | SUPERVISED | `hardwareWallet` | proposal | declared |

Declared-but-unimplemented modes fail closed twice: an adapter must opt in
through its capabilities, and the engine refuses a mode with no registered
execution adapter. Adding a backend is `registerExecutionMode()` plus an
adapter — no change to the execution layer.

## 5. Lifecycle

`packages/core/src/execution/lifecycle.js`

```
CREATED → VALIDATED → PREPARED → SUBMITTED → AWAITING_AUTHORIZATION
                                           → AUTHORIZED → EXECUTING → EXECUTED

terminal: EXECUTED · FAILED · CANCELLED · EXPIRED
```

Transitions are checked. A provider reporting `EXECUTED` and then `PREPARED` is
either confused or lying, and a record that accepted both would be useless as an
audit trail. Repeating the current state is allowed, since status polling
returning the same answer twice is normal.

| Mode | Path |
| --- | --- |
| Safe supervised | `VALIDATED → PREPARED → SUBMITTED → AWAITING_AUTHORIZATION → AUTHORIZED → EXECUTED` |
| WaaP autonomous | `VALIDATED → PREPARED → AUTHORIZED (by policy) → EXECUTING → EXECUTED` |
| Unsigned | `VALIDATED → PREPARED` (nothing was submitted) |

The existing names are **mapped in**, not duplicated, so there is one state
machine rather than two that disagree:

| Existing | Canonical |
| --- | --- |
| `READY_TO_SIGN` | `VALIDATED` |
| `PROPOSED` | `SUBMITTED` |
| `AWAITING_APPROVAL` | `AWAITING_AUTHORIZATION` |
| `READY_TO_EXECUTE` | `AUTHORIZED` |
| `AUTHORIZED_BY_POLICY` | `AUTHORIZED` |
| `REJECTED` | `CANCELLED` |
| `BLOCKED` | `FAILED` |

A provider that submits and confirms in one call reports `EXECUTED` straight
from `PREPARED`. Rather than widen the machine, the engine records the
`SUBMITTED` step that demonstrably happened and then the outcome — the fact
that matters when a call times out and nobody knows whether it landed.

## 6. Execution adapters

`packages/core/src/execution/adapter.js`

```js
interface ExecutionAdapter {
  readonly mode: ExecutionMode
  prepare(intent: ValidatedExecutionIntent): Promise<ExecutionPreparation>
  submit(preparation: ExecutionPreparation): Promise<ExecutionSubmission>
  status(record: ExecutionRecord): Promise<ExecutionStatus>
}
```

`prepare()` performs no network writes. It is where a Safe nonce is read and a
`safeTxHash` derived, or an autonomous policy evaluated — inspectable before
anything is submitted, and the reason a dry run is possible. `submit()` is the
only phase that can cause an external effect.

A preparation cannot be swapped between modes or intents: `assertSubmittable()`
rejects a preparation built for another mode, and one whose intent hash no
longer matches the intent it carries.

## 7. Safe supervised flow

`packages/core/src/execution/executors/safe-supervised.js`

```
   User asks Gavel to prepare a vote
              ↓
   Gavel analyzes + validates
              ↓
   ValidatedExecutionIntent
              ↓
   SafeSupervisedExecutionAdapter
     · require a ValidatedExecutionIntent
     · delegate Safe transport to SafeProposalProvider
     · read API Kit's next available nonce
     · build/hash through official Protocol Kit
     · sign with the PROPOSAL identity
              ↓
   Safe Transaction Service
              ↓
   Pending transaction appears in Safe
              ↓
   SUBMITTED → AWAITING_AUTHORIZATION
              ↓
   Human Safe owners review and sign to threshold
              ↓
   AUTHORIZED → EXECUTED
```

`SafeSupervisedExecutionAdapter` owns workflow, lifecycle, provenance, records,
and the validated-intent boundary. `SafeProposalProvider` owns official Safe
Protocol Kit/API Kit transport: owner and delegate reads, nonce selection,
SafeTx construction, EIP-712 signing, Transaction Service submission, and
readback by `safeTxHash`. No DAO adapter knows any of it, and neither Safe
component knows a DAO. See the [operator guide](../execution/safe.md) for the
actual CLI and service configuration.

Two properties are enforced rather than documented:

1. **Gavel is never a Safe owner.** The adapter takes a `ProposalIdentity`,
   which has no broadcast capability. It refuses to run if that identity appears
   in the Safe's owner set, and refuses a response in which the Transaction
   Service counts it as a confirming owner — a delegate signature is not a
   confirmation, and if the service says otherwise then the key is an owner and
   this is not supervised mode.
2. **Provider metadata is not the authority.** Protocol Kit computes the
   `safeTxHash` from the exact SafeTx body rebuilt from the sealed intent. API
   Kit's proposal response is not success evidence: the provider reads the
   transaction back by hash and verifies every execution-critical field. The
   same verification runs on every status poll, so a service that starts
   describing a different transaction for a known hash surfaces immediately.

Governance provenance travels in the proposal's `origin` metadata beside the
transaction — never inside its calldata. Gavel stops at a verified pending
proposal. Human Safe owners alone decide whether to confirm to threshold and
execute it.

## 8. WaaP autonomous flow

`packages/core/src/execution/executors/waap-autonomous.js`

```
   ValidatedExecutionIntent
              ↓
   WaapAutonomousExecutionAdapter
              ↓
   governance autonomy check  (validation.autonomyAllowed)
              ↓
   policy evaluation          (explicit { allowed: true } only)
              ↓
   AUTHORIZED
              ↓
   ExecutionIdentity signs and broadcasts
              ↓
   EXECUTING → EXECUTED
```

This mode has materially more authority than supervised mode, so the gates are
harder and all fail closed:

- the input must be a `ValidatedExecutionIntent`;
- `validation.autonomyAllowed` must be true — an advisory observed-behavior
  recommendation sets it false and is never executed autonomously, whatever the
  policy would have said;
- the identity must be an `ExecutionIdentity`, which a Safe proposal identity
  structurally cannot be;
- the policy must return an explicit `{ allowed: true }`. A throw, a rejected
  promise, a falsy return and a truthy-but-unshaped value are all refusals.
  There is no default-allow policy and a missing policy hook is a constructor
  error;
- actor, chain and target must match what was configured.

Policy runs in `prepare()`, so a rejection costs nothing and is recorded as a
`FAILED` attempt rather than passing silently. A mined-but-reverted transaction
reports `FAILED` even when the provider calls it confirmed.

## 9. Identity roles

`packages/core/src/execution/identity/`

```
  Safe Copilot                        Autonomous
  ────────────                        ──────────
  ProposalIdentity                    ExecutionIdentity
    · proposeSafeTransaction            · signTransaction
                                        · broadcastTransaction
        ↓                                   ↓
  Safe queue                          Policy evaluation
        ↓                                   ↓
  Human Safe threshold                Onchain execution
```

There is no generic `Wallet` in this layer, because a generic wallet makes
capability confusion easy and invisible. The two roles are distinct types with
different methods, and the capabilities a proposal identity lacks are **absent
methods**, not disallowed ones — there is no `signTransaction` to call and no
flag to flip.

Brand checks are on private fields, which are lexically scoped per class, so the
roles are genuinely non-substitutable: `assertExecutionIdentity(proposalIdentity)`
throws and nothing exported converts between them.

A `ProposalIdentity` is scope-bound to one Safe and one chain at construction, so
a credential created for one Safe cannot propose into another. It must not, and
structurally cannot: hold governance delegation (it is never the delegate a DAO
adapter checks), hold funds, count toward the Safe threshold, or execute
anything. It is revocable on its own — removing the Safe delegate entry, or
deleting the credential, removes its authority without touching the Safe's
owners or the execution identity.

`ExecutionIdentitySet` additionally asserts the two addresses differ, since the
type system cannot tell two addresses apart.

### SigningIdentity — the key backend

```js
interface SigningIdentity {
  address(): Promise<Address>
  signTypedData(domain, types, message): Promise<Signature>
}
```

The execution layer never reads a private key. The interface is deliberately
narrow — no `exportPrivateKey`, no `signMessage`, no `sendTransaction` — because
that is what makes a hardware- or HSM-backed implementation possible at all. It
is checked structurally, so a KMS client wrapper need not import Gavel.

| Backend | Use |
| --- | --- |
| `RemoteSigningIdentity` | KMS, HSM, managed or per-tenant signer. The hosted seam. |
| `KeystoreSigningIdentity` | Encrypted local keystore. The preferred BYOH backend. |
| `SecretStoreSigningIdentity` | OS keychain / system secret store. |
| `EnvironmentSigningIdentity` | **Development only.** |

`KeystoreSigningIdentity` fetches the passphrase per unlock rather than holding
it and does not retain the decrypted wallet, so an idle process has no key in
its heap. `SecretStoreSigningIdentity` takes an injected `fetchSecret`, so the
platform-specific command (`security find-generic-password`, `secret-tool
lookup`) lives in the runtime that knows its platform and core spawns no
processes.

`EnvironmentSigningIdentity` requires an explicit `acknowledgeDevelopmentOnly:
true`, so configuration drift cannot reach a plaintext key. A plaintext
environment key is not the production recommendation and
`assertProductionReady()` rejects a profile that uses one.

### BYOH installation flow

```
gavel identity create --type safe-proposer --safe 0x… --chain-id 1
        ↓
show address
        ↓
authorize that address as a Safe DELEGATE (never an owner)
        ↓
verify the delegation
        ↓
bind it in an execution profile as proposalIdentity: "local:safe-proposer-main"
```

The key is generated locally, written only encrypted at mode `0600` under
`GAVEL_DATA_DIR`, and the passphrase (from `GAVEL_IDENTITY_PASSPHRASE`, minimum
12 characters) is never written to disk.

### Hosted / Bankr identity model

Hosted execution must not use one global key for every user. The
`SigningIdentity` seam exists so a hosted deployment resolves a *different*
`RemoteSigningIdentity` per user or per Safe, backed by per-tenant delegate
identities, tenant-scoped signers, or HSM/KMS keys. Nothing in the Safe or WaaP
adapters changes between BYOH and hosted.

## 10. Execution records

`packages/core/src/execution/records.js`

One governance decision may be attempted several times through different
providers — a Safe proposal expires, the user switches to autonomous execution
— and none of that history belongs in the canonical intent.

```js
{
  id, key,                    // key = intentHash + mode + actor
  intentHash, voteIntentHash,
  mode, actor, dao, proposalId, support, chainId, target, selector,
  state, attempt, createdAt, updatedAt,
  providerData: { safeTxHash?, safeNonce?, safeAddress?,
                  transactionHash?, providerRequestId?, providerStatus? },
  history: [{ state, at, detail }],
  audit: { adapterVersion, validatedAt, proposalState, governanceTarget,
           autonomyAllowed, deadline, reason, calldata }
}
```

Every provider-specific value lives here and nowhere near the intent, which is
what makes retry safe and the same intent portable across modes. The canonical
governance intent is never mutated to carry provider history.

`audit` also carries the intent's execution-critical fields (`calldata`,
`value`, `operation`, `governanceTarget`), which is what lets an adapter
re-verify a provider's account of a transaction after a restart, when the
`ValidatedExecutionIntent` itself is long gone.

**Stores.** `ExecutionEngine` requires an explicit store; there is no default,
because an in-memory default silently loses deduplication on restart and the
failure mode is a duplicate governance action rather than an error.

| Store | Use |
| --- | --- |
| `FileExecutionRecordStore` | durable; one JSON file per record at 0600, atomic writes, plus intent/Safe-nonce lock files for cooperating processes sharing one local filesystem. It is not a distributed lock. |
| `InMemoryExecutionRecordStore` | tests only. |

A deployment spanning hosts, data directories, or filesystems without reliable
exclusive lock creation must implement the same interface (`get`, `getById`,
`put`, `listByKey`, `listByIntentHash`, `listByProposal`, `withLocks`) over a
transactional store with distributed coordination. The built-in locks only
coordinate processes that see the same local lock directory.

## 11. Idempotency and replay

`packages/core/src/execution/replay.js`

Two different questions, deliberately separate.

**Idempotency** — "is this the same attempt again?" Keyed on `intentHash + mode
+ actor`. An existing succeeded or in-flight attempt is returned rather than
creating a second one, so a retried CLI invocation or a re-delivered runtime
request cannot queue a second Safe transaction or rebroadcast a confirmed vote.
An abandoned attempt (failed, cancelled, expired) does not block a genuine
retry, which becomes attempt 2 on the same intent.

**Replay** — "is this a second governance action on the same proposal?" This
looks across every record for the proposal and actor, not only this intent
hash, because voting AGAINST after voting FOR is a *different* intent hash and
passes idempotency while still being a second vote.

The decision comes from DAO-declared semantics, never from the execution layer:

| DAO | `canVoteMultipleTimes` | `canReplaceVote` | Why |
| --- | --- | --- | --- |
| Nouns | false | false | one receipt per voter per proposal |
| ENS | false | false | Governor `hasVoted` reverts on a second vote |
| Railgun | **true** | false | votes by staked amount; successive partial votes are legitimate |

Railgun is the case that proves the design: any replay rule hard-coded in the
execution layer would be wrong for one of these. The adapter declares the rule
and the execution layer enforces what it was told. An adapter that declares
nothing gets the conservative default — one execution per voter per proposal.

**Freshness.** A validated intent stays *structurally* valid forever, which is
precisely the replay risk: a document validated while a proposal was ACTIVE can
be resubmitted after it closed. The adapter records the proposal's deadline
(block or timestamp) and the engine rejects a stale intent with
`GOVERNANCE_WINDOW_CLOSED`.

**Concurrent modes.** An attempt in flight under a different mode is refused: a
Safe proposal and an autonomous broadcast for one vote would double-vote if the
Safe owners later signed. Once the first attempt is terminal, the documented
mode switch proceeds — reusing the same governance intent rather than rebuilding
it.

## 12. Execution profiles

`packages/core/src/execution/profile.js`

A voter is never permanently tied to one execution provider:

```
VoterProfile                    ExecutionProfile
  governance preferences          Safe
  history                         WaaP
  voter model                     future wallet
```

Switching modes replaces the execution profile and nothing else.

Supervised:

```json
{
  "version": 1,
  "mode": "safe-supervised",
  "safe": {
    "address": "0x…",
    "chainId": 1,
    "proposalIdentity": "local:safe-proposer-main"
  }
}
```

Autonomous:

```json
{
  "version": 1,
  "mode": "waap-autonomous",
  "waap": {
    "wallet": "…",
    "chainId": 1,
    "executionIdentity": "remote:waap-governance",
    "policy": "governance-only"
  }
}
```

Mode selection is explicit; there is no "use whatever is configured" fallback,
and a profile missing its mode's configuration block is an error. Identity
entries are references (`local:`, `keychain:`, `remote:`, `env:`), never key
material, and a profile cannot name one credential for both roles.

## 13. DAO adapter contract

`packages/core/src/dao/contract.js`

```js
interface GovernanceAdapter {
  // identity
  id, chainId, adapterVersion
  governanceContracts, governanceTargets, governanceSelectors
  capabilities, supportedActions

  // governance
  fetchProposal(...)
  fetchVoterState(...)          // getVotingPower / getCurrentDelegate / hasVoted
  validateProposal(...)

  // the canonical path
  buildVoteIntent(...)
  buildExecutionIntent(...)
  validateExecutionIntent(...)  // → ValidatedExecutionIntent
  prepareValidatedIntent(...)
  getExecutionSemantics()
}
```

`installGovernanceContract()` implements the canonical path on top of an
adapter's existing `prepareVote()`, so a new DAO gets it by writing
`prepareVote()` and declaring its semantics. Each adapter declares only what
only it can know: version, governance targets, selectors, and execution
semantics.

An execution provider never parses a Nouns Governor, an ENS Governor, or a
Railgun voting contract. The one exception is generic: core checks that a target
is an address the adapter declared, and that the calldata's selector is one the
adapter declared for the action.

### Railgun

Railgun is an **adapter limitation**, not an execution-layer exception. It
declares `safeSupervised: false` and `waapAutonomous: false` because its
authorization model is voting-key indirection rather than the delegate model
`execution-status` verifies, and because votes carry an explicit staked amount
and account that the generic readiness check does not express.

That is a fact the adapter states about itself. There is no Railgun branch
anywhere in the execution layer — a boundary test asserts that no
execution-layer module mentions any DAO in code. Railgun already declares its
real execution semantics, so if it gains an execution mode, replay protection is
correct for it on day one.

## 14. Runtimes

```
                    gavel/core
        governance + intent + execution
              /                \
          Bankr               Hermes
```

Both are clients of the same core and implement no governance or execution logic
of their own. Hermes is a pinned-revision bootstrapper that execs the canonical
CLI; Bankr is a skill wrapper over the same CLI. Identical intents get identical
behaviour because there is only one implementation.

### CLI

```
gavel prepare-vote …
gavel execution prepare prediction.json proposal.json --support FOR --mode safe-supervised --profile nouns-mainnet --identity local:gavel-safe
gavel execution submit prediction.json proposal.json --support FOR --mode safe-supervised --profile nouns-mainnet --identity local:gavel-safe
gavel identity create --type safe-proposer --label gavel-safe --safe <address> --chain-id <id>
```

The CLI operates on Gavel-generated intents, never on arbitrary calldata. There
is deliberately no `gavel safe propose --to … --data …`; a test asserts no such
surface exists.

## 15. Security invariants

Each row says what is actually enforced and where. Where an invariant has a
known limit, the limit is stated rather than omitted.

| Invariant | Enforcement | Known limit |
| --- | --- | --- |
| **Governance** — only Gavel-generated, adapter-validated actions cross into execution | `ValidatedExecutionIntent`'s symbol-gated constructor and private-field brand; `assertPreparable()` in every adapter; the CLI's execution commands take governance inputs and re-run live validation | `validateExecutionIntent()` takes the adapter as a parameter and does no I/O, so in-process code can supply a fake adapter (see §2) |
| **Mutation** — execution-critical fields cannot change after validation | the intent is cloned and deeply frozen; `intentHash` covers `target`, `value`, `data`, `chainId`, `actor`; **preparation payloads are deeply frozen, and every adapter's `submit()` rebuilds the onchain call from `validated.intent` rather than reading the payload** | — |
| **Calldata binding** — the declared decision is the one in the bytes | the adapter must implement `decodeGovernanceCall()`; core cross-checks the encoded proposal, support and reason against `intent.source` | a DAO whose vote call carries no reason (Railgun) reports `null`, and the intent must agree |
| **Identity separation** — proposal identities cannot become execution identities | distinct types with per-class private-field brands; no exported conversion; **`ExecutionEngine` resolves every registered adapter's identity address and refuses to run if a proposal and an execution identity share one** | profile-level checking compares credential *references*; the address check is what actually enforces it |
| **Safe** — supervised mode never requires Gavel to be a Safe owner | `ProposalIdentity` has no broadcast capability; official Protocol Kit reads owners on every prepare and submit and owner membership fails closed | relies on the configured RPC being an honest view of the Safe |
| **Authorization** — Safe authority stays with the human threshold | API Kit must report an unexpired delegate authorization from a current owner; the adapter refuses a proposal confirmed by the proposal identity; only humans confirm and execute | revoking delegation blocks new proposals but does not remove existing queue entries |
| **Provider distrust** — provider metadata is never the authority | the SafeTx hash is computed locally and recomputed at submit; verification is a **read-back** after proposing, since the real API returns an empty body; **every execution-critical field must be present and match, on submit and on every poll — an absent field is an error, not a pass** | — |
| **Autonomous** — autonomy needs an explicit executor and policy | `autonomyAllowed` defaults closed and is checked before policy; only an explicit `{ allowed: true }` approves; a missing policy hook is a constructor error | policy scope (allowlists, rate limits) is the wallet's job, not Gavel's |
| **Replay and freshness** — a stale or duplicate action is refused | idempotency on `intentHash + mode + actor`; replay across every attempt on the proposal under DAO-declared semantics; **an unknown or unevaluable deadline is refused by default** rather than treated as never expiring | correctness across restarts requires a durable store; the engine has no in-memory default, but `InMemoryExecutionRecordStore` is still selectable |
| **Arbitrary-call** — no runtime turns natural language into arbitrary wallet calls | no CLI or core surface accepts a target and calldata; the deprecated single-phase executors are unexported and inert without `GAVEL_ALLOW_DEPRECATED_EXECUTORS=1` | the document builder those executors used stays callable by path, because `prepare-delegation` emits unsigned calldata with it |

## 16. Threat model

### LLM prompt injection

An attacker embeds instructions in proposal text to make the agent submit
arbitrary calldata.

*Mitigation.* Execution adapters accept only a `ValidatedExecutionIntent`, whose
constructor is unreachable outside its module, and their `submit()` derives the
onchain call from that intent rather than from any payload handed to them. An
agent driving the CLI has no surface that accepts a target and calldata: the
execution commands take a prediction and a proposal and re-run live validation,
so a doctored document cannot be laundered into a sealed intent. The calldata's
encoded proposal and support must match the declared decision, so a valid
selector with swapped arguments is refused. Proposal prose is separately
classified `UNTRUSTED_GOVERNANCE_CONTENT` / `NEVER_FOLLOW` above the boundary.

*Residual.* An attacker with arbitrary in-process code execution can construct
a self-consistent fake adapter and mint (see §2). The boundary is a defence
against an agent choosing bad *inputs*, not against arbitrary code running
inside Gavel.

### Compromised Safe proposal identity

An attacker with the proposer credential places malicious proposals in the Safe
queue.

*Mitigation.* The identity cannot execute — it has no broadcast capability and
is not a Safe owner. The human threshold still gates every transaction, so the
attacker's best outcome is a queue entry humans must approve. The credential is
scope-bound to one Safe and one chain, revocable on its own by removing the
delegate without touching the Safe's owners, and every Gavel-originated proposal
carries its `intentHash` in `origin` — so a queue entry with no matching
execution record is identifiable as not Gavel's.

### Compromised WaaP execution identity

Higher severity: this key can execute.

*Mitigation.* Defence rests on wallet policy rather than on Gavel alone. The
architecture contributes: the identity is chain-scoped and carries a `policyId`;
`autonomyAllowed` must be open for the specific intent; only an explicit policy
approval proceeds; the calldata must be a declared governance selector against a
declared governance target. Policy should additionally enforce allowlists, rate
limits and governance-specific constraints. The key is separate from the Safe
proposer by construction, so compromising one does not yield the other, and it
is independently revocable.

### Provider compromise

The Safe Transaction Service or a wallet provider behaves incorrectly.

*Mitigation.* Provider metadata is never the authority, and **omission is
treated as failure**. The `safeTxHash` is computed locally, recomputed at
submit, and compared. After proposing, the proposal is read back and every
execution-critical field — `safeTxHash`, `safe`, `chainId`, `to`, `data`,
`value`, `operation`, `nonce` — must be present and must match the validated
intent; the same check runs on every poll. A provider-reported state must be a
legal transition from the recorded one. A mined-but-reverted transaction is
`FAILED` regardless of what the provider calls it.

This was the shape of a real hole: the checks were written as `if (field &&
mismatch)`, so a service returning `{ isExecuted: true }` with no `to`, `data`
or `safeTxHash` passed all of them and reported a successful execution.

### Replay

An old validated intent is resubmitted.

*Mitigation.* The adapter-recorded deadline is checked at submission, so an
intent validated while a proposal was ACTIVE is rejected once the window closes.
A deadline that is unknown, or that cannot be evaluated because no current block
number was supplied, is refused rather than passed — previously it read as "not
expired", which made such an intent submittable indefinitely. Execution records
plus DAO-declared semantics reject a second governance action on the same
proposal, including under a different intent hash or a different mode.
Idempotency returns the existing attempt instead of creating another.

*Operational requirement.* Deduplication is only as durable as the record
store. Use `FileExecutionRecordStore` (or an implementation of the same
interface over your own database) for anything that submits; the engine refuses
to construct without an explicit store so the choice cannot be made by
accident.

### Credential exposure through logs

*Mitigation.* Events are assembled from a fixed allowlist rather than by
spreading a caller's object, and a key whose name matches a secret pattern
(`privateKey`, `signature`, `credential`, `mnemonic`, `apiKey`, …) is a hard
error rather than a silent drop — so a bad call site is found in tests, not in a
log. Calldata is included because it is public onchain data and is what an
auditor most needs; signatures are not, because they are authorization
material.

## 17. Auditability

Gavel can answer *"why did you create this Safe transaction?"* with a durable
chain, correlated on `intentHash` at every hop:

```
proposal                 normalized proposal + contentHash
  → recommendation       prediction: recommendation, confidencePercent
  → voter model/rules    policySource, policySourceId
  → VoteIntent           voteIntentHash
  → ExecutionIntent      target, value, data, actor
  → validation result    adapterVersion, proposalState, selector, checks
  → intentHash           the stable identity
  → Safe proposal        origin metadata carrying intentHash
  → safeTxHash           providerData
  → execution status     history[] of canonical states
```

`ExecutionRecord.audit` carries the governance reasoning forward, and
`history[]` records every state the attempt passed through with timestamps.

## 18. Migration status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Canonical intents, hashing, validated form | done |
| 2 | Execution layer: lifecycle, modes, adapter contract, records, idempotency, replay, events | done |
| 3 | Identity roles and signing backends; Safe and WaaP adapters | done |
| 4 | Hermes and Bankr on the common core | already the case — both call the CLI and own no governance or execution logic |
| 5 | Autonomous execution against validated intents | adapter done; no live broadcaster client is bundled |
| 6 | ENS, Railgun and future DAOs on the same contract | done — all three satisfy the canonical contract |

Backwards compatibility is mostly preserved. `gavel prepare-vote` emits the
same document and `from-preparation.js` still bridges stored preparations into
canonical intents in-process.

Two deliberate breaks:

- **`gavel execution prepare` no longer accepts a stored preparation.** It takes
  a prediction and a proposal and re-runs live validation. Lifting a document
  was a hole: a `READY_TO_SIGN` JSON could be edited to encode a different
  proposal behind the same valid selector.
- **The deprecated single-phase executors are unexported and inert.** They are
  requirable by path with `GAVEL_ALLOW_DEPRECATED_EXECUTORS=1` for an in-flight
  migration. `@gavel/core` no longer exposes them, because they stamp
  `validated: true` on caller-supplied calldata.

**Provider status.** Safe supervised mode ships a real
`SafeProposalProvider` backed by official Protocol Kit and API Kit, and
`gavel execution submit` wires it through the canonical engine. It proposes and
verifies a queue entry; it never owner-signs or executes it. No autonomous WaaP
broadcaster is bundled. The real Safe acceptance test is opt-in and requires an
operator-reviewed governance fixture; see `docs/execution/safe.md`.

## 19. Non-goals

This work did not redesign the voter model, prediction algorithms, backtesting,
the governance index, or proposal security inspection. Those sit above the
execution boundary and their behaviour is unchanged.
