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

**This is the important architectural artifact.** It is a class with a private
constructor sealed by a module-scoped symbol that is never exported, so the only
code in the process that can mint one is `validateExecutionIntent()`. Identity is
a private-field brand check rather than `instanceof`, so
`Object.create(ValidatedExecutionIntent.prototype)` does not pass either.

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

**Validation does not trust the adapter.** `validateExecutionIntent()`:

- re-derives the 4-byte selector from the calldata rather than believing the
  evidence's claim about it;
- requires the target to be an address the adapter itself declared as part of
  its governance system (`governanceTargets`, else `governanceContracts`);
- checks the selector against the adapter's declared selectors for the action;
- re-derives the `voteIntentHash` link when the VoteIntent is supplied;
- requires `proposalStateVotable`, `actorEligible`, and that every check the
  adapter reported actually passed.

A buggy or compromised adapter cannot bless a call to an address it never
declared.

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
     · read the Safe's next nonce
     · build the EIP-712 SafeTx payload
     · compute safeTxHash locally
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

Every Safe-specific concern lives here: the Safe address, nonce, `safeTxHash`,
Transaction Service, proposer identity, proposal metadata, status lookup. No DAO
adapter knows any of it, and this adapter knows no DAO.

Two properties are enforced rather than documented:

1. **Gavel is never a Safe owner.** The adapter takes a `ProposalIdentity`,
   which has no broadcast capability. It refuses to run if that identity appears
   in the Safe's owner set, and refuses a response in which the Transaction
   Service counts it as a confirming owner — a delegate signature is not a
   confirmation, and if the service says otherwise then the key is an owner and
   this is not supervised mode.
2. **Provider metadata is not the authority.** The `safeTxHash` is computed
   locally from the EIP-712 payload and compared with the service's. On every
   status poll the returned target and calldata are re-checked against the
   validated intent, so a service that starts describing a different
   transaction for a known hash surfaces immediately.

Governance provenance travels in the proposal's `origin` metadata beside the
transaction — never inside its calldata.

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
gavel prepare-vote …                       → validated preparation
gavel execution prepare <preparation>      → ValidatedExecutionIntent
gavel execution submit <intent> --profile  → execution attempt
gavel identity create --type safe-proposer → proposal identity
```

The CLI operates on Gavel-generated intents, never on arbitrary calldata. There
is deliberately no `gavel safe propose --to … --data …`; a test asserts no such
surface exists.

## 15. Security invariants

| Invariant | Enforcement |
| --- | --- |
| **Governance** — only Gavel-generated, adapter-validated actions cross into execution | `ValidatedExecutionIntent`'s private constructor; `assertPreparable()` in every adapter |
| **Mutation** — execution-critical fields cannot silently change after validation | the intent is deeply frozen; `intentHash` covers `target`, `value`, `data`, `chainId`, `actor`; any change is a new intent needing revalidation |
| **Identity** — proposal identities cannot become autonomous execution identities | distinct types with private-field brands; no exported conversion |
| **Safe** — supervised mode never requires Gavel to be a Safe owner | `ProposalIdentity` has no broadcast capability; the adapter refuses a proposer in the owner set |
| **Authorization** — Safe execution authority stays with the human threshold | the adapter refuses a response counting the proposer as a confirming owner |
| **Autonomous** — autonomous execution needs an explicit executor and policy | `autonomyAllowed` defaults closed; no default-allow policy; a missing policy hook is a constructor error |
| **Arbitrary-call** — no runtime converts natural language into arbitrary wallet calls | no CLI or core surface accepts a target and calldata; every action goes natural language → governance intent → execution intent → validation → executor |
| **Separation** — one key never serves both roles | `ExecutionIdentitySet.assertSeparation()`; profile-level reference check |

## 16. Threat model

### LLM prompt injection

An attacker embeds instructions in proposal text to make the agent submit
arbitrary calldata.

*Mitigation.* Execution adapters accept only a `ValidatedExecutionIntent`, whose
constructor is unreachable outside its module. Even a fully compromised agent
loop has no function to call that turns a chosen target and calldata into one:
validation requires a live DAO adapter, and the target must be an address that
adapter declared. Proposal prose is already classified
`UNTRUSTED_GOVERNANCE_CONTENT` / `NEVER_FOLLOW` by the security inspector above
the boundary.

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

*Mitigation.* Provider metadata is never the authority. The `safeTxHash` is
computed locally and compared; the target and calldata are re-verified against
the validated intent on every status poll; a provider-reported state must be a
legal transition from the recorded one or the update is refused; a
mined-but-reverted transaction is `FAILED` regardless of what the provider calls
it.

### Replay

An old validated intent is resubmitted.

*Mitigation.* The adapter-recorded deadline is checked at submission, so an
intent validated while a proposal was ACTIVE is rejected once the window closes.
Execution records plus DAO-declared semantics reject a second governance action
on the same proposal, including under a different intent hash or a different
mode. Idempotency returns the existing attempt instead of creating another.

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

Backwards compatibility is preserved. `gavel prepare-vote` emits the same
document; `from-preparation.js` bridges stored preparations into canonical
intents; the previous single-phase executors still work and are marked
deprecated with pointers to their replacements.

**Not bundled.** Gavel ships the execution architecture, not a wallet provider.
No live Safe Transaction Service client and no autonomous broadcaster are
included: `gavel execution submit` validates the profile and the intent, then
refuses loudly rather than pretending to submit. Add a backend only against an
official, deterministic, testable client, and without weakening any gate above.

## 19. Non-goals

This work did not redesign the voter model, prediction algorithms, backtesting,
the governance index, or proposal security inspection. Those sit above the
execution boundary and their behaviour is unchanged.
