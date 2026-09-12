# Safe supervised execution

The full model, including diagrams, the identity model and the threat model, is
in [`docs/architecture/execution.md`](../architecture/execution.md). This page is
the operator's view.

## What supervised mode does

```
User asks Gavel to prepare a vote
        ↓
Gavel analyzes + validates
        ↓
Gavel proposes the validated transaction to the Safe
        ↓
Pending transaction appears in Safe
        ↓
Human reviews
        ↓
Human Safe owners sign and execute
```

Gavel analyzes, recommends, constructs, validates and proposes. The human
authorizes, signs and executes.

## Gavel is not a Safe owner

Gavel has a separate **proposal identity** whose entire authority is to place a
transaction into the Safe's approval queue. Authorize it as a Safe **delegate**,
never as an owner.

The proposal identity cannot execute anything, holds no funds, holds no
governance delegation, and does not count toward the Safe threshold.

This is enforced, not configured. `ProposalIdentity` has no signing or broadcast
method to call, and `SafeSupervisedExecutionAdapter` **requires an onchain owner
reader** (`safeInfo.getOwners`) — it will not construct without one, because
nothing else establishes that Gavel's signature does not count toward the
threshold. The owner set is re-read on every prepare and every submit, so an
address added to the Safe later is caught rather than missed by a cached
snapshot. A proposal the Transaction Service reports as *confirmed* by the
proposal identity is refused for the same reason.

It is revocable on its own — remove the delegate entry and Gavel loses its
proposal authority without any change to the Safe's owners.

## Creating a proposal identity (BYOH)

```
export GAVEL_IDENTITY_PASSPHRASE='…at least 12 characters…'
gavel identity create --type safe-proposer --safe 0xYourSafe --chain-id 1
```

The key is generated locally and written only encrypted, at mode `0600`, under
`GAVEL_DATA_DIR`. The passphrase is never written to disk. The command prints
the address and the next steps:

1. add that address as a **delegate** (not an owner) of the Safe;
2. verify the delegation;
3. reference it from an execution profile as
   `safe.proposalIdentity: "local:<label>"`.

Preferred credential backends, in order: OS keychain or system secret store,
encrypted local keystore (what `identity create` produces), hardware- or
KMS-backed keys. A plaintext `.env` private key is a development-only backend —
`EnvironmentSigningIdentity` requires an explicit `acknowledgeDevelopmentOnly`
flag, and `assertProductionReady()` rejects a profile that uses one.

For hosted deployments, resolve a separate `RemoteSigningIdentity` per user or
per Safe rather than sharing one global key. Nothing in this adapter changes
between BYOH and hosted.

## Execution profile

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

## What the adapter owns

The Safe address, the nonce, the `safeTxHash`, the Transaction Service, the
proposer identity, the proposal metadata, and the status lookup. No DAO adapter
knows any of it, and the Safe adapter knows no DAO.

The operator supplies an existing Safe address. Gavel does not create a Safe,
choose a Safe, or request an owner key.

## The service is not trusted, and silence is not consent

The `safeTxHash` is computed locally from the EIP-712 SafeTx payload, recomputed
at submit from the validated intent, and compared; a mismatch fails closed. The
signature is produced over the recomputed body, so it can never belong to a
transaction other than the one being sent.

Verification is a **read-back**, not a check of the propose response: the real
Safe API answers a successful propose with an empty body, so the response cannot
be the check. After proposing, the proposal is read back and every
execution-critical field — `safeTxHash`, `safe`, `chainId`, `to`, `data`,
`value`, `operation`, `nonce` — must be present and must match. The same check
runs on every status poll.

**An absent field is an error, not a pass.** This mattered: the checks were
originally written as `if (field && mismatch)`, so a service returning
`{ isExecuted: true }` with no `to`, `data` or `safeTxHash` satisfied all of
them and reported a successful execution of whatever Gavel thought it had
proposed.

Your service client must report the chain it queried. The Safe Transaction
Service is per-chain by endpoint and does not always carry `chainId` in the
body, but a field that is sometimes absent is a field an attacker can omit — and
the client is your code, so it can always surface it.

## Lifecycle

`VALIDATED → PREPARED → SUBMITTED → AWAITING_AUTHORIZATION → AUTHORIZED →
EXECUTED`, or terminating in `FAILED`, `CANCELLED` or `EXPIRED`. The previous
`PROPOSED` / `AWAITING_APPROVAL` / `READY_TO_EXECUTE` names map onto
`SUBMITTED` / `AWAITING_AUTHORIZATION` / `AUTHORIZED`.

Retries are idempotent on `intentHash + mode + actor`, so running submission
twice returns the existing proposal instead of queueing a second identical Safe
transaction. A standalone `prepare()` does not count as an attempt in flight —
nothing left the process — so a dry run does not block the real submission.

Deduplication is only as durable as the execution record store. Use
`FileExecutionRecordStore`, or your own implementation of the same interface:
the engine refuses to construct without an explicit store, because an in-memory
default loses every guarantee on restart and the failure mode is a duplicate
vote.

## Before you start

Run `gavel execution-status --mode safe-supervised` first. The cold asset owner
must currently delegate voting power to the **Safe** — the address the vote is
cast from — not to the proposal identity, which holds no voting power and never
originates the call.

## Not bundled

No live Safe Transaction Service client ships with Gavel. `gavel execution
submit` validates the profile and the intent and then reports that no backend is
registered, rather than pretending to submit. Register a
`SafeSupervisedExecutionAdapter` with an official, deterministic, testable
service client — without weakening the gates above.
