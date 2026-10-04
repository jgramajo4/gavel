# Safe supervised execution

This is the operator guide for the real Safe provider. The execution model and
threat analysis live in [`docs/architecture/execution.md`](../architecture/execution.md).

## Authority boundary

```text
ValidatedExecutionIntent
        ↓
Gavel + official Safe Protocol Kit / API Kit
        ↓
verified pending Safe proposal
        ↓
human Safe owners review, authorize, and execute
```

**Gavel proposes. Human Safe owners authorize and execute.** Gavel does not hold
an owner key, become an owner, add confirmations, satisfy the Safe threshold, or
execute the transaction. There is no CLI option that accepts arbitrary
`to`/`data`/`value`; submission always re-runs a built-in DAO adapter and accepts
only its `ValidatedExecutionIntent`.

The identities are deliberately different:

```text
Safe proposal identity != Safe owner != WAAP execution identity
```

A proposal identity can sign only a Safe proposal. It cannot broadcast a
transaction. A WAAP execution identity has autonomous execution authority and
must never reuse a Safe proposal credential.

Built-in DAO adapters and execution components are part of Gavel's trusted
computing base. The sealed intent proves that Gavel validation ran and that the
intent was not mutated; it does not make arbitrary third-party adapter code
trustworthy.

## 1. Configure private storage

`GAVEL_DATA_DIR` holds encrypted identities, their portable local unlock
credentials, delegate bindings, intent audit artifacts, and execution records.
Choose a persistent, private directory once for the installation:

```bash
export GAVEL_DATA_DIR="$HOME/.local/share/gavel"
mkdir -p "$GAVEL_DATA_DIR"
chmod 700 "$GAVEL_DATA_DIR"
```

For an agent, configure `GAVEL_DATA_DIR` in its runner **once**, not in each vote
command. The bundled Hermes `integrations/hermes/scripts/gavel.js` runner sets it
to its own private data directory by default. A direct CLI without this variable
uses a working-directory-relative `data/private`; do not rely on that default
for an unattended installation whose working directory might change.

The default Safe proposer setup generates a random unlock credential at
`$GAVEL_DATA_DIR/credentials/<label>.secret` (mode `0600`, owner-only `0700`
parent) and an encrypted keystore at
`$GAVEL_DATA_DIR/identities/<label>.json` (mode `0600`). There is no password
prompt, shell export, profile `.env`, third-party product, or passphrase CLI
argument. Keep this directory out of source control. Back up **both** files
and restore them with the same owner and permissions; losing either means
creating and reauthorizing a new delegate. Treat a backup as containing a
usable signing key: because ciphertext and unlock credential are on the same
filesystem, encryption does **not** protect against someone who can read both.
Restrict filesystem access, protect backups, and never put the credential on a
shared volume.

Credential resolution follows the identity document, not whatever secrets
happen to be exported in a shell: a local-reference identity reads only its
corresponding protected file; an env-managed identity reads only its named
process variable; otherwise it fails closed. An explicitly supplied **empty**
variable fails. Legacy identity documents without a local credential reference
continue to require their recorded environment variable.
`--passphrase-env <VARIABLE>` remains available for deliberately env-managed
new identities. Never put the value in argv, a profile, a committed `.env`, or
shell history. The core signer interface admits future secret stores and remote
signers, but this CLI implements only environment compatibility and the local
credential file today. Human/direct-signing wallets are separate and do not
silently inherit machine-unlocked proposer credentials.

## 2. Create the proposal identity

```bash
gavel identity create \
  --type safe-proposer \
  --safe 0xYourSafe \
  --chain-id 1 \
  --label safe-proposer-main
```

The command generates the dedicated proposal key locally and encrypts it with
a random 32-byte credential stored separately under
`$GAVEL_DATA_DIR/credentials/safe-proposer-main.secret`. It writes mode-`0600`
identity JSON to:

```text
$GAVEL_DATA_DIR/identities/safe-proposer-main.json
```

The document stores the encrypted keystore, public address, Safe/chain scope,
`credentialRef: "local:safe-proposer-main"`. It does not record an unrelated
environment override. It never stores the passphrase or plaintext key. Record
the printed public address; that address is the proposal identity. **Never add
it as a Safe owner, fund it, or reuse it as a human/autonomous wallet.**

For an existing env-managed deployment, keep the old identity document and its
recorded variable; no migration is required. For a newly created env-managed
identity, opt in explicitly by naming the variable:

```bash
gavel identity create ... --passphrase-env GAVEL_IDENTITY_PASSPHRASE
```

Supply its secret through your existing host mechanism. Merely naming a
variable does not write its value. The CLI's canonical compatibility name is
`GAVEL_IDENTITY_PASSPHRASE`; the older secrets catalog's
`GAVEL_SAFE_PASSPHRASE` is an optional inventory name, **not** a second implicit
fallback. Name it explicitly with `--passphrase-env` if you intend to use it.

## 3. Authorize it as a delegate, never an owner

Check current state:

```bash
gavel safe delegate status \
  --safe 0xYourSafe \
  --chain-id 1 \
  --identity local:safe-proposer-main \
  --rpc "$ETHEREUM_RPC_URL" \
  --safe-api-url "$GAVEL_SAFE_API_URL"
```

The result is exactly one of `authorized`, `not-authorized`, `owner-conflict`,
or `service-unavailable`. Owner membership is read from the Safe contract through
Protocol Kit, not inferred from Transaction Service metadata. `status` checks
delegation **without unlocking** the proposer: `authorized` does not prove the
local credential is present. The `setup` command below unlocks the identity
before checking delegation; run it as the non-interactive credential readiness
check during installation.

Ask an **existing Safe owner** to authorize the printed proposal address with
the official `@safe-global/api-kit` owner-side flow. In an owner-controlled app,
connect the owner's wallet signer and call:

```js
await apiKit.addSafeDelegate({
  safeAddress: "0xYourSafe",
  delegateAddress: "0xPrintedProposalIdentity",
  delegatorAddress: await ownerSigner.getAddress(),
  label: "gavel",
  signer: ownerSigner,
});
```

The `signer` and `delegatorAddress` must identify the same current Safe owner.
This operation runs outside Gavel: never pass the owner signer, seed phrase, or
private key to Gavel. Do not add the proposal address to the Safe owner set.

The setup command is fail-closed guidance and verification; it does not acquire
or use owner authority:

```bash
gavel safe delegate setup \
  --safe 0xYourSafe \
  --chain-id 1 \
  --identity local:safe-proposer-main \
  --rpc "$ETHEREUM_RPC_URL" \
  --safe-api-url "$GAVEL_SAFE_API_URL"
```

Run it before owner authorization to print the required action, then again after
authorization. Only a verified `authorized` result persists the binding at:

```text
$GAVEL_DATA_DIR/safe/delegates/1-0xyoursafe.json
```

The provider accepts only an unexpired delegate entry whose delegator remains a
current onchain Safe owner. It repeats both owner and delegate checks at prepare
and submit, so an owner-set change or delegate expiry fails closed.

## 4. Configure RPC, Transaction Service, and API key

```bash
export ETHEREUM_RPC_URL='https://your-chain-rpc.example'
export GAVEL_SAFE_API_URL='https://your-safe-transaction-service.example'
export GAVEL_SAFE_API_KEY='read-from-your-secret-manager'
```

`--rpc` overrides `ETHEREUM_RPC_URL`. `safe delegate` accepts
`--safe-api-url`; execution submission reads the profile's
`transactionServiceUrl`, falling back to `GAVEL_SAFE_API_URL`. API Kit reads
`GAVEL_SAFE_API_KEY`. Never commit the API key or embed it in the profile URL.
The configured Transaction Service must correspond to the profile chain.

Create a private execution profile, for example
`$GAVEL_DATA_DIR/profiles/safe-main.json`:

```json
{
  "version": 1,
  "mode": "safe-supervised",
  "safe": {
    "address": "0xYourSafe",
    "chainId": 1,
    "proposalIdentity": "local:safe-proposer-main",
    "transactionServiceUrl": "https://your-safe-transaction-service.example"
  }
}
```

Profiles contain identity references, never secrets.

## 5. Validate, review, and submit

First create the review artifact from live chain state:

```bash
gavel execution prepare prediction.json proposal.json \
  --support FOR \
  --execution-address 0xYourSafe \
  --asset-owner 0xVotingPowerOwner \
  --acknowledge-security-review \
  --acknowledge-prediction-review \
  --rpc "$ETHEREUM_RPC_URL"
```

Review the generated intent and retain its `intentHash`. The file is an audit
artifact, not authority. Submission takes the original governance inputs and
revalidates them live:

```bash
gavel execution submit prediction.json proposal.json \
  --support FOR \
  --asset-owner 0xVotingPowerOwner \
  --profile "$GAVEL_DATA_DIR/profiles/safe-main.json" \
  --mode safe-supervised \
  --expect-intent 0xReviewedIntentHash \
  --acknowledge-security-review \
  --acknowledge-prediction-review \
  --rpc "$ETHEREUM_RPC_URL"
```

`--expect-intent` stops if live revalidation produces a different transaction.
On success the CLI prints the `safeTxHash`, Safe nonce, status, and execution
record id. **Stop there.** Human owners inspect the queue entry in Safe, decide
whether to confirm it, and execute it through Safe if they choose.

For Hermes, run each shown `gavel ...` command as
`node <installed-gavel-skill>/scripts/gavel.js ...` instead of calling a
versioned `runtimes/gavel/<sha>/packages/cli/bin/gavel.js` path. The runner
supplies the pinned runtime and `GAVEL_DATA_DIR` to its child; it does not copy
a credential into argv or require a secret in its parent environment. The
runner's pinned `RUNTIME_REF` must be updated **after** the reviewed Forgejo
commit is published; until then it still invokes its older CLI. For a direct
non-Hermes installation, install the reviewed Gavel version and persist
`GAVEL_DATA_DIR` in the service/agent configuration once.

## Proposal construction and readback

`SafeProposalProvider` uses official Safe Protocol Kit and API Kit. It:

1. reads owners and verifies the proposer is not one;
2. verifies owner-authorized, unexpired delegation;
3. obtains API Kit's next available nonce (it does not use `current + 1`);
4. constructs one canonical transaction from the sealed validated intent with
   `safeTxGas = baseGas = gasPrice = 0` and both `gasToken` and
   `refundReceiver` equal to the zero address;
5. supports only the explicitly reviewed Safe versions `1.3.0` and `1.4.1`,
   requiring typed data whose domain
   contains the configured chain id and Safe address;
6. independently computes the EIP-712 digest of that full body and requires it
   to equal Protocol Kit's `safeTxHash` before signing;
7. signs and proposes that same canonical body through the Transaction Service;
8. reads the transaction back by `safeTxHash`; and
9. requires Safe, chain, target, value, calldata, operation, all five payment
   fields, nonce, proposer, and hash to match before reporting submission.

Safe `1.2.x` and earlier—including chainless `1.1.1` typed-data domains—and
unknown `1.5.x` or later versions fail with `UNSUPPORTED_SAFE_VERSION`. Broadening
that allowlist requires dedicated version-specific tests; semantic-version shape
alone is not evidence of compatible hashing.

Gavel does not support Safe gas refunds or payment tokens in supervised
execution. A non-zero gas field or non-zero token/refund address fails with
`UNSAFE_SAFE_PAYMENT_FIELDS` before signing or POST. A typed-data/hash split
fails with `HASH_TYPED_DATA_MISMATCH`.

Missing or mismatched service fields are errors. A provider's `isExecuted` claim
never overrides an integrity mismatch. The proposal identity must not appear as
an owner confirmation.

## Records, locking, retry, and unknown outcomes

Records are stored as mode-`0600` JSON under:

```text
$GAVEL_DATA_DIR/executions/<mode>/<intentHash-without-0x>/<attempt>.json
```

They persist `intentHash`, Safe, mode, lifecycle, `safeTxHash`, nonce,
timestamps, reconciliation status, and audit fields. Retries key on
`intentHash + mode + actor` and reconcile an existing hash before any new POST.
A timeout after POST is an **unknown submission outcome**, not proof of failure:
keep the record and rerun the same submission. Gavel reads by the persisted
`safeTxHash`; if a prepared hash is definitely absent, it rebuilds using the
persisted nonce rather than silently allocating a new action.

`FileExecutionRecordStore` uses atomic writes plus lock files for the intent and
Safe nonce. This implementation requires **Linux `/proc`** for crash-safe PID
fingerprints and fails before acquiring a lock when `/proc` is unavailable.
Those locks coordinate cooperating processes only when they share
the **same local filesystem and lock directory**. They are not a distributed
lock and no correctness claim is made for separate hosts, independent data
directories, or filesystems with unreliable lock/create semantics. Multi-host
or hosted deployments must implement the record-store interface on a database
with transactional/distributed coordination.

## Revocation and incident response

An existing Safe owner can revoke the delegate independently of the Safe owner
set. After revocation, verify:

```bash
gavel safe delegate status ...
# expected: not-authorized
```

Then stop Gavel processes, remove or quarantine the encrypted identity file, and
rotate any Transaction Service API key that may also be exposed. Revocation
prevents new Gavel proposals; it does not delete already pending Safe queue
entries. Human owners must reject/remove those in Safe. Never "fix" an
`owner-conflict` by continuing—the identity must first be removed as an owner or
replaced with a separate proposal-only identity.

## Opt-in real Safe integration test

The default suite never contacts Safe and reports one skipped live test:

```bash
npm run test:safe-live
```

A live run creates a **real pending queue entry**. No calldata fixture is bundled
because inventing a vote call would bypass the validated-intent boundary. The
operator must provide a currently valid, reviewed governance fixture and pin the
exact intent hash. The test fails closed if any required input is missing.

Required environment:

```text
GAVEL_SAFE_INTEGRATION_TEST=1
GAVEL_SAFE_TEST_RPC_URL
GAVEL_SAFE_TEST_SERVICE_URL
GAVEL_SAFE_API_KEY
GAVEL_SAFE_TEST_SAFE_ADDRESS
GAVEL_SAFE_TEST_CHAIN_ID
GAVEL_SAFE_TEST_PROFILE
GAVEL_SAFE_TEST_IDENTITY_REFERENCE=local:<label>
GAVEL_SAFE_TEST_PREDICTION=/absolute/path/prediction.json
GAVEL_SAFE_TEST_PROPOSAL=/absolute/path/proposal.json
GAVEL_SAFE_TEST_SUPPORT=FOR|AGAINST|ABSTAIN
GAVEL_SAFE_TEST_ASSET_OWNER
GAVEL_SAFE_TEST_EXPECTED_INTENT_HASH=0x...
GAVEL_SAFE_TEST_REVIEWED_FIXTURE=1
GAVEL_DATA_DIR
<the passphrase variable named in the encrypted identity document>
```

Optional: `GAVEL_SAFE_TEST_REASON`.

Set `GAVEL_SAFE_TEST_REVIEWED_FIXTURE=1` only after confirming that the files
represent the intended active governance vote, the expected hash came from
`gavel execution prepare`, the Safe is dedicated to testing, and a pending queue
entry is acceptable. Then run `npm run test:safe-live`.

The live test verifies real owner state, delegate authorization, official SDK
proposal construction, the CLI's `SafeSupervisedExecutionAdapter` path, service
readback by `safeTxHash`, proposer identity, all transaction fields, and durable
record persistence.

**Live-test success boundary:** a real, non-executed Safe proposal exists in the
configured Transaction Service queue and exactly matches the reviewed validated
intent. The test does not provide an owner signature, authorize to threshold,
or execute the transaction. Those remain explicit manual Safe-owner actions.
