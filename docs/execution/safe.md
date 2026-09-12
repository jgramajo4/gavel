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
governance delegation, and does not count toward the Safe threshold. This is
structural rather than a matter of configuration: `ProposalIdentity` has no
signing or broadcast method to call, and `SafeSupervisedExecutionAdapter` refuses
to run if that identity appears in the Safe's owner set, or if the Transaction
Service reports it as a confirming owner. It is revocable on its own — remove the
delegate entry and Gavel loses its proposal authority without any change to the
Safe's owners.

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

## The service is not trusted

The `safeTxHash` is computed locally from the EIP-712 SafeTx payload and
compared with the one the Transaction Service returns; a mismatch fails closed.
On every status poll the returned target and calldata are re-checked against the
validated intent, so a service that starts describing a different transaction
for a known hash surfaces immediately rather than silently.

## Lifecycle

`VALIDATED → PREPARED → SUBMITTED → AWAITING_AUTHORIZATION → AUTHORIZED →
EXECUTED`, or terminating in `FAILED`, `CANCELLED` or `EXPIRED`. The previous
`PROPOSED` / `AWAITING_APPROVAL` / `READY_TO_EXECUTE` names map onto
`SUBMITTED` / `AWAITING_AUTHORIZATION` / `AUTHORIZED`.

Retries are idempotent on `intentHash + mode + actor`, so running submission
twice returns the existing proposal instead of queueing a second identical Safe
transaction.

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
