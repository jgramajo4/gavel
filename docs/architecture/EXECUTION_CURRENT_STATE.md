# Architecture note: where execution lives today

Written before the execution-boundary refactor, as a map of the code as it
actually is. It records what already respects the governance/execution
boundary, what violates it, and which specific properties the refactor has to
add. Read it with `docs/architecture/execution.md`, which describes the target
model this note motivates.

## 1. Current component map

### Governance layer

| Concern | Location |
| --- | --- |
| Proposal fetching (indexed) | `packages/governance-index/src/{client,api,sources,nouns-source}.js` |
| Proposal fetching (live) | `packages/{nouns,ens,railgun}-adapter/src/` against the governor |
| Canonical proposal status | `packages/core/src/governance/lifecycle.js` |
| Proposal normalization schema | `packages/core/src/schema/governance.js` |
| Proposal security inspection | `packages/nouns-adapter/src/security.js` |
| Voter modeling | `packages/core/src/profile/{build,features,policy,recency,voice}.js` |
| Prediction / recommendation | `packages/core/src/predict/{predict,confidence,reason,similarity}.js` |
| Backtesting / calibration | `packages/core/src/backtest/` |
| Vote construction + validation | `packages/nouns-adapter/src/vote.js`, `packages/ens-adapter/src/index.js`, `packages/railgun-adapter/src/index.js` |
| Vote preparation schema | `packages/nouns-adapter/src/schema/preparation.js` |

### Execution layer

| Concern | Location |
| --- | --- |
| Execution modes and statuses | `packages/core/src/schema/execution.js` |
| Intent hashing + mutation guard | `packages/core/src/execution/transaction-binding.js` |
| Delegation/voting-power readiness | `packages/core/src/execution/readiness.js` |
| Safe executor | `packages/core/src/execution/executors/safe.js` |
| WaaP executor | `packages/core/src/execution/executors/waap.js` |
| Unsigned executor | `packages/core/src/execution/executors/unsigned.js` |
| DAO adapter contract + capability gate | `packages/core/src/dao/registry.js` |

### Runtimes

| Runtime | Location | Shape |
| --- | --- | --- |
| CLI | `packages/cli/bin/gavel.js` | Canonical surface. Owns command parsing and private-state paths. |
| Hermes / BYOH | `integrations/hermes/scripts/gavel.js` | Pinned-revision bootstrapper that execs the CLI. Owns no governance logic. |
| Bankr | `integrations/bankr/` | One umbrella skill: voter/copilot instructions wrap the canonical CLI; a separately routed Gate advocate client wraps Gate APIs and payment authorization. |
| TUI | `packages/tui/` | TypeScript read/act surface over viem. Holds its own signing path. |

### State persistence

`packages/core/src/storage/private-state.js` resolves `GAVEL_DATA_DIR` and
guards path traversal. That is the whole of it: everything else is
file-per-document written by the CLI (`writePrivateJson`). The governance index
has real persistence (`packages/governance-index/src/postgres-store.js`), but it
stores upstream governance data, not Gavel's own actions.

## 2. What the current code already gets right

These properties are load-bearing and the refactor must preserve them.

1. **An intent hash already exists.** `governanceIntentHash()` hashes a
   canonical field list and deliberately excludes runtime-generated values.
2. **A mutation guard already exists.** `assertExecutorDidNotMutate()` rehashes
   what a provider echoes back and fails closed on any drift. Both the Safe and
   WaaP executors call it.
3. **Executors do not hold keys.** The Safe executor takes an injected client
   with a `propose()` method; `test/executors.test.js` asserts the executor has
   no `privateKey` property. Gavel is not a Safe owner anywhere in the tree.
4. **Capability gating is adapter-declared.** `assertModeSupported()` reads
   `adapter.capabilities`, so Railgun's `safeSupervised: false` is an adapter
   fact, not a branch inside the Safe executor. The execution layer contains no
   DAO-specific code at all.
5. **Autonomy is a separate, explicit bit.** `autonomyAllowed` is part of the
   hashed material and defaults false; advisory recommendations cannot be
   executed autonomously.
6. **Core purity is enforced by a test.** `test/architecture-boundaries.test.js`
   fails if anything in `packages/core` imports a DAO adapter or a runtime.

## 3. Responsibility mixing, by component

### `transaction-binding.js` mixes construction, validation and attestation

`createPreparedGovernanceTransaction()` accepts a target, calldata and value,
stamps `validated: true` and a `validatedAt`, and computes the intent hash over
its own output. Nothing in the document is evidence that a DAO adapter ever
looked at it. A caller can mint a structurally perfect, hash-consistent
"validated" transaction for arbitrary calldata:

```js
createPreparedGovernanceTransaction({
  adapter: "nouns", action: "CAST_VOTE", chainId: 1,
  target: attacker, calldata: arbitraryData, value: "0", ...
});
```

`assertPreparedGovernanceTransaction()` then accepts it, because the only
invariant it checks is that the hash matches the fields — which it does. The
"only validated intents may execute" invariant is therefore documented but not
enforced: validation is a boolean the constructor writes, not a fact the type
carries. **This is the single most important gap.**

### The vote preparation document mixes four concerns

`votePreparationSchema` is one ~90-field object carrying, at once:

- governance intent (`proposalId`, `selectedSupport`, `reason`)
- voter-model output (`recommendation`, `confidencePercent`, `policySource`)
- chain verification evidence (`verification.*`)
- an execution artifact (`transaction`, `addressRoles`)

There is no DAO-agnostic `VoteIntent` anywhere. The governance decision exists
only as a subset of fields inside a Nouns-shaped document, so no consumer can
take "what Gavel intends" without also taking prediction internals and Nouns
verification structure.

### Execution statuses are Safe's vocabulary

`ExecutionStatus` is `PREPARED | PROPOSED | AWAITING_APPROVAL |
READY_TO_EXECUTE | EXECUTED | REJECTED | EXPIRED | FAILED | BLOCKED`.
`PROPOSED`, `AWAITING_APPROVAL` and `READY_TO_EXECUTE` are Safe Transaction
Service concepts leaking into the provider-neutral schema; a WaaP broadcast has
no meaningful `PROPOSED` step and no notion of approval. There is also no state
machine: any status can follow any other, and nothing rejects
`EXECUTED → PREPARED`.

### Identity is smuggled inside transport clients

There is no identity abstraction in the tree. `SafeSupervisedExecutor` receives
`options.client.propose()`; whatever that closure signs with is invisible to
Gavel. Consequences:

- No `ProposalIdentity` / `ExecutionIdentity` distinction exists, so the
  identity-separation invariant cannot be checked — the same client object can
  be handed to both executors.
- No `SigningIdentity` abstraction exists, so a hosted deployment has nowhere to
  plug per-tenant or KMS-backed signing.
- No capability typing exists, so nothing structurally prevents a
  proposal-only credential from being used to broadcast.
- `.env.example` still advertises `AGENT_PRIVATE_KEY`, used by
  `nouns-dao/scripts/{propose,place_bid,settle_auction}.js`. Those are legacy
  direct-signing scripts outside the executor path, but they are the only
  key-handling pattern the repo demonstrates.

### Executors are single-phase

The interface is `submit(transaction)` plus an optional `getStatus()` on Safe
only, and `type` rather than `mode`. There is no `prepare()` step, so
provider-specific preparation (Safe nonce derivation, `safeTxHash`
precomputation, policy evaluation) has nowhere to live except inside `submit`,
where it cannot be inspected or approved before submission.

### No execution records, idempotency, or replay protection

Nothing persists an execution attempt. Therefore:

- **Retries duplicate.** Running Safe submission twice queues two identical
  Safe transactions; nothing looks up `intentHash + mode + actor`.
- **Replay is unbounded.** A validated intent stays structurally valid after
  the proposal closes. `validatedAt` is hashed but never compared against a
  deadline at submission time.
- **History is unanswerable.** "Why did you create this Safe transaction?"
  cannot be answered from stored state; the audit chain exists only as
  whatever JSON files the operator kept.
- **Mode switching mutates governance.** Moving from an expired Safe proposal
  to WaaP requires rebuilding the preparation document, because provider
  history has nowhere to live but the governance artifact.

### No DAO-declared execution semantics

`adapter.capabilities` says which execution *modes* a DAO supports but nothing
about the DAO's *voting* rules. The adapters differ materially and the
difference is invisible to the execution layer:

| DAO | Semantics | Where it is expressed today |
| --- | --- | --- |
| Nouns | One vote per proposal; `hasVoted` receipt; block-window deadline; refundable-vote client id 38 | Inline `DUPLICATE_VOTE` blocker in `vote.js` |
| ENS | One vote per proposal; `hasVoted`; block-window deadline; no reason attribution | Inline blocker in `ens-adapter` |
| Railgun | **Partial, repeatable votes** by staked amount; separate yay (5d) and nay (6d) timestamp windows; voting-key indirection | Inline `remaining`/`VOTE_AMOUNT_EXCEEDS_POWER` logic in `railgun-adapter` |

Railgun is the case that proves the point: a correct replay rule for Nouns
("one execution per proposal per voter") is wrong for Railgun, which permits
successive partial votes until stake is exhausted. Any replay rule hard-coded
in the execution layer would be wrong for one of them.

### Cross-adapter coupling

Both `ens-adapter` and `railgun-adapter` import `inspectNounsProposal` from
`packages/nouns-adapter/src/security.js`. The function is generic structural
action inspection, so the behaviour is right and the dependency direction is
wrong: two adapters depend on a third adapter's internals. Only Nouns parses its
preparation output through a schema; ENS and Railgun return hand-built object
literals with drifting shapes (`verification.tokenAddress` vs
`verification.nounsTokenAddress` vs `verification.stakingAddress`;
`verification.votingKey` only on Railgun).

### No observability

No structured events are emitted anywhere in the execution path. There is no
`intent.created`, no `execution.submitted`, no correlation on `intentHash`.

## 4. Boundary verdict

| Component | Governance | Wallet | Runtime | Transport | Verdict |
| --- | --- | --- | --- | --- | --- |
| `predict/`, `profile/`, `backtest/` | ✅ | — | — | — | Clean. |
| `governance/lifecycle.js` | ✅ | — | — | — | Clean. |
| `dao/registry.js` | contract only | — | — | — | Clean. |
| `execution/executors/*.js` | — | ✅ | — | mixed | Transport client carries the identity. |
| `execution/transaction-binding.js` | ✅ | — | — | — | Mints its own validation claim. |
| `schema/execution.js` | — | Safe-flavoured | — | — | Provider vocabulary in a neutral schema. |
| adapters' `prepare*()` | ✅ | ✅ | — | — | Emits execution artifacts and address roles directly. |
| `cli/bin/gavel.js` | orchestrates | selects mode | ✅ | — | Acceptable for a runtime; has no submit surface. |
| `nouns-dao/scripts/*.js` | ✅ | ✅ | ✅ | ✅ | Legacy; all four mixed. Outside the executor path. |

## 5. What the refactor must add

Ordered by how much each closes:

1. **Unforgeable validation.** A validated intent must be constructible only by
   the canonical validator, from adapter-supplied evidence. `validated: true`
   as a writable field is the hole.
2. **A canonical `VoteIntent`.** DAO-agnostic, execution-free, so governance
   output stops being a Nouns-shaped document.
3. **A canonical `ExecutionIntent`.** Provider-neutral, so adapters stop
   emitting Safe/WaaP-shaped artifacts.
4. **An identity model.** `ProposalIdentity` vs `ExecutionIdentity`, capability
   typed, over a `SigningIdentity` abstraction — so the separation invariant is
   checkable and hosted deployments have a key-backend seam.
5. **A provider-neutral lifecycle with real transitions**, with the existing
   `PROPOSED` / `READY_TO_SIGN` names mapped in rather than duplicated.
6. **Execution records, idempotency and replay rules**, keyed on
   `intentHash + mode + actor`, with replay governed by DAO-declared semantics.
7. **A three-phase executor contract** (`prepare` / `submit` / `status`).
8. **DAO-declared execution semantics** (`getExecutionSemantics()`), so
   Railgun's repeatable partial votes and Nouns's single vote are both correct
   without an execution-layer branch.
9. **Structured events** correlated on `intentHash`.

## 6. Deliberate non-goals

The voter model, prediction algorithms, backtesting, governance index and
proposal security inspection are out of scope. They sit above the execution
boundary and this work does not touch their behaviour.
