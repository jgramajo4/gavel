# Gate remote relay (Base mainnet, gas only)

This runbook turns on the narrow relay route that lets an advocate client with
no funded key — the Bankr Gavel umbrella's Gate route — have the Gate server broadcast a
settlement it has already authorized.

It changes nothing about who decides what. Gate still issues and signs the
quote, the payer still signs the EIP-3009 authorization, the scanner still
verifies the on-chain `QuoteSettled` log independently, and only Gate's
`accepted` means delivered. What this adds is one wallet that pays gas.

## What the relay is, and what it is not

```
Bankr          --signs--> EIP-3009 ReceiveWithAuthorization
               --POST-->  /v1/submissions/{publicId}/relay
                          { "authorization": { "signature": "0x..." } }
                                  |
Gate server    quote from its OWN owner-bound record of this submission
               -> rebuild settle calldata
               -> assertPreparedSettlement (the shared guard)
               -> simulate, populate, and sign { to, data, value: 0 }
               -> persist signed tx bytes + deterministic tx hash
               -> broadcast those exact signed bytes
                                  |
                          200 { txHash, chainId, relayer }   = a HINT
```

- It is **not** a transaction relay. The endpoint accepts no `to`, no `data`,
  and no `value`; a body carrying one is refused by name. The transaction is
  built server-side from the quote Gate signed, so there is no request shape
  that broadcasts anything else.
- It is **not** a payment authority. The transaction hash is a settlement hint;
  the scanner reaches the same verdict with no hint at all.
- It is **not** a USDC path. The relayer pays gas. The USDC leg is the payer's
  EIP-3009 authorization, from the payer to the splitter.

## Prerequisites

1. A Gate deployment already running per `GAVEL_GATE_EXPERIMENTAL.md`, with a
   configured settlement runtime (`GAVEL_GATE_ENVIRONMENT=production`, chain
   `8453`, canonical native USDC, verified splitter). The relay refuses to
   start without one.
2. A **dedicated** EOA that exists for nothing else. Not the quote signer, not
   the deployer, not the Gavel recipient, not a treasury, not any payer wallet.
   Startup fails closed if it is the quote signer, the splitter, or the token,
   and a relay is refused at request time if it is ever the payer of the quote
   being settled.
3. ETH on Base mainnet on that address, and **no USDC**. A USDC balance there is
   an operator mistake, not a capability: nothing in this path can spend it.

## Deployment steps

Run these on the Gate host, after the change is merged and the image is built.

1. **Generate or import the relayer key into the deployment secret store.** It
   belongs in the same store as `GAVEL_GATE_QUOTE_SIGNER` — never in the root
   app `.env`, the indexer, the Cloudflare worker, the CLI config, Postgres, a
   browser bundle, or a log line.

   ```sh
   umask 077
   # existing key: install the 0x-prefixed 32-byte hex key you already hold.
   # new key: generate it offline, on the host, and never echo it afterwards.
   ```

2. **Add the pair to `.env.server.local` (or the platform's secret store).**
   Both or neither; a partial pair fails startup.

   ```text
   GAVEL_GATE_RELAYER_KEY=<0x + 64 hex>
   GAVEL_GATE_RELAYER_ADDRESS=<the address that key derives>
   ```

   For the current deployment that address is
   `0xEFA2FF7173CBaeF587d937D36DCFeD94DbaB2828`. Startup fails closed if the
   key does not derive exactly this address, so a mismatch is caught before the
   process serves anything.

3. **Confirm the funding, before restarting.**

   ```sh
   cast balance 0xEFA2FF7173CBaeF587d937D36DCFeD94DbaB2828 --rpc-url "$BASE_RPC_URL"
   cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
     "balanceOf(address)(uint256)" 0xEFA2FF7173CBaeF587d937D36DCFeD94DbaB2828 \
     --rpc-url "$BASE_RPC_URL"     # expect 0
   ```

   ETH: enough for the expected settlement volume. USDC: zero.

4. **Retire the out-of-repo implementation.** `/srv/gavel-gate/relayer-impl.js`
   is superseded by `packages/server/src/gate/relay-signer.js`, which is in the
   image and under test. Move it aside rather than deleting it until the new
   path has settled once:

   ```sh
   sudo mv /srv/gavel-gate/relayer-impl.js /srv/gavel-gate/relayer-impl.js.retired
   ```

   Nothing in the repo reads that file. If any unit file, cron entry, or wrapper
   script on the host references it, remove that reference in the same change.

5. **Restart the Gate process and verify it came up.**

   ```sh
   docker compose -f docker-compose.server.yml up -d --build gate
   curl -fsS https://<gate-origin>/health
   ```

   A startup failure here is the intended behaviour for a bad pair: read the
   process log, fix the secret, restart. The process does not degrade to
   "running without a relay" once the keys are present.

6. **Prove the route is mounted and closed.** Unauthenticated, it must be 401 —
   never 404 (which would mean no relay) and never 200.

   ```sh
   curl -si -X POST https://<gate-origin>/v1/submissions/AAAAAAAAAAAAAAAAAAAAAA/relay \
     -H 'content-type: application/json' -d '{"authorization":{"signature":"0x00"}}' | head -1
   ```

7. **Point the advocate client at it.** In the Bankr skill's secure environment
   variables:

   ```text
   GAVEL_GATE_RELAYER_URL=https://<gate-origin>
   ```

   Origin only, HTTPS, public hostname. The client refuses an IP literal, a
   loopback, a LAN address, plain HTTP, a path, a query, credentials, or a
   reserved test name. Unset, the client fails with `RELAYER_UNAVAILABLE` and
   does not broadcast from Bankr.

8. **First live settlement: watch it, do not batch it.** Run exactly one real
   request end to end and confirm, in order: the relay returns a transaction
   hash; the transaction on Basescan is `settle` from the relayer address with
   zero ETH value; the USDC moves from the payer, not the relayer; Gate's public
   status reaches `accepted`. Stop and investigate if any of those differ.

## Rotation

No on-chain state references the relayer address, so rotation is not a
migration:

1. Pause issuance (or wait for a quiet window).
2. Let in-flight quotes expire or settle; `/v1/submissions/{id}/status` is the
   authority.
3. Swap `GAVEL_GATE_RELAYER_KEY` and `GAVEL_GATE_RELAYER_ADDRESS` together.
4. Restart, re-run steps 3, 5, 6, and 8.
5. Sweep the retired address's remaining ETH.

## Turning it off

Remove both variables and restart. The route disappears (404), the client fails
with `RELAYER_UNAVAILABLE`, and no other Gate behaviour changes.

## Operating notes

- **Relay deduplication survives process restarts.** Gate atomically claims the
  quote's EIP-3009 nonce, persists the exact signed transaction bytes and their
  deterministic hash before broadcast, and returns the stored hash for later
  duplicate calls. Concurrent calls for the same quote converge on the same
  durable row. Across different quotes, a PostgreSQL advisory lock keyed to the
  funded relayer account serializes the durable claim, nonce selection,
  simulation, signing, write-ahead, and broadcast across every Gate process.
  The claim is created on the lock-owning database session before signing; if
  that session is lost, the durable `claimed` row fences all later relay work
  until an operator reconciles it.
- **Failures are split by whether broadcast was possible.** Validation,
  simulation, population, or signing failures occur before the broadcast
  primitive and release the claim for a later retry. Once broadcasting starts,
  an RPC error is ambiguous: Gate persists `reconciliation_required`, refuses
  automatic rebroadcast, and operators must inspect the stored hash/on-chain
  state. Never clear or retry that state merely because the HTTP response was
  lost. While any relay for the chain is `broadcasting` or
  `reconciliation_required`, Gate also refuses every new relay from that funded
  account; resolve the persisted raw transaction and hash before resuming.
- **The scanner remains settlement authority.** A persisted or returned relay
  hash is only a hint. Only the independently observed canonical
  `QuoteSettled` log can move the submission to `accepted`.
- **A refusal is free.** Every check — owner binding, quote signature, chain and
  splitter identity, authorization recovery, expiry, the prepared-settlement
  guard — runs before the broadcast primitive. A refused relay spends no gas.
- **`RELAYER_IS_PAYER` (503) is a configuration alarm**, not a user error: it
  means the funded wallet was handed a quote it is itself paying. Investigate
  before restarting.
- **A settlement that would revert is normally stopped before broadcast.** The
  relayer performs a read-only simulation while populating the exact transaction,
  before it signs or calls the broadcast primitive. A spent EIP-3009 nonce or a
  payer who moved the USDC should therefore fail without gas. This is defense in
  depth, not settlement truth; watch the relayer's ETH balance and investigate a
  sustained drop with no matching `QuoteSettled` logs.
- **A relay is never acceptance.** If the relay succeeds and Gate stays
  `pending_settlement`, that is the scanner doing its job. Do not re-issue.
