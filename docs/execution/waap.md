# WaaP scoped autonomy

The full model is in [`docs/architecture/execution.md`](../architecture/execution.md).
This page is the operator's view.

## What autonomous mode does

```
ValidatedExecutionIntent
        ↓
governance autonomy check
        ↓
policy evaluation
        ↓
WaaP execution identity signs
        ↓
transaction broadcast
        ↓
confirmation
```

Gavel analyzes, decides, constructs, validates, signs and executes. No human
stands between the decision and the chain, which is why every gate below fails
closed.

## The identity is separate, always

The autonomous **execution identity** must never be the Safe **proposal
identity**, even for the same Gavel voter profile. The autonomous key has
materially more authority: compromising it means transactions, not queue
entries.

This is enforced, not advised. `WaapAutonomousExecutionAdapter` requires an
`ExecutionIdentity`, and a `ProposalIdentity` structurally cannot be one —
different types, private-field brand checks, and no exported conversion.
`ExecutionIdentitySet.assertSeparation()` additionally refuses two identities
that resolve to the same address, and an execution profile cannot name one
credential reference for both roles.

## Gates

Every one of these must pass, and each fails closed:

- the input is a `ValidatedExecutionIntent` — arbitrary calldata has no path in;
- the DAO adapter declares `waapAutonomous: true` and supports the action;
- `validation.autonomyAllowed` is true. An advisory observed-behavior
  recommendation sets it false and is never executed autonomously, whatever the
  policy would have said;
- the actor, chain and target match the configured execution identity;
- the calldata's selector is one the DAO adapter declared for the action against
  a target it declared;
- the policy returns an explicit `{ allowed: true }`. A throw, a rejected
  promise, a falsy return and a truthy-but-unshaped value are all refusals.
  There is no default-allow policy, and a missing policy hook is a constructor
  error.

Policy runs in `prepare()`, before anything can be broadcast, so a rejection
costs nothing and is recorded as a `FAILED` attempt rather than passing
silently.

## Execution profile

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

`policy` is required. Beyond the architectural gates above, wallet policy is
where allowlists, rate limits and governance-specific constraints belong — a
compromised autonomous key is a higher-severity event than a compromised
proposal identity, and policy is the layer that bounds it.

## Lifecycle

`VALIDATED → PREPARED → AUTHORIZED (by policy) → EXECUTING → EXECUTED`, or
terminating in `FAILED`. A mined-but-reverted transaction reports `FAILED` even
when the provider calls it confirmed: the chain's outcome decides, not the
provider's verdict.

A confirmed execution is never rebroadcast — idempotency on `intentHash + mode +
actor` returns the existing attempt.

## Before you start

`gavel execution-status --mode waap-autonomous` verifies that the asset owner
delegates to the WaaP execution address and that the address has voting power.
Switching from a Safe address to a different WaaP address reports
`redelegationRequired` and cannot vote until that explicit transition happens.

## Not bundled

No live WaaP broadcaster ships with Gavel. Add one only against an official,
deterministic, testable client, and without weakening any gate above.
