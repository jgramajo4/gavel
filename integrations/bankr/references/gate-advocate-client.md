# Gate advocate client

The Bankr-side client lives at `integrations/bankr/src/`. It is a thin client
over Gate's existing advocate surfaces: Gate keeps every decision, and nothing
here can override one.

```js
const {
  createBankrGateFlow,
  createEip1193Wallet,
  sendAttentionRequest,
} = require("./integrations/bankr/src");
```

## Modules

| File | Responsibility |
| --- | --- |
| `config.js` | `GAVEL_GATE_URL`, `GAVEL_INDEX_API_URL`, `GAVEL_GATE_CHAIN_IDS`. No address, price, or fee. |
| `gate-api.js` | HTTP client for the advocate-facing Gate routes. No `/v1/gate/me/*`. |
| `index-api.js` | Read-only canonical governance index client. |
| `targets.js` | Candidate/proposal resolution, `PRE_VOTE`/`SPONSOR` vs `VOTING`, stage language. |
| `discovery.js` | Voter discovery and selection from Gate's public directory. |
| `session.js` | Gate's `base_sender` WalletSession exchange. |
| `submission.js` | Advocate content validation, the Gate body, create-or-resume. |
| `quote.js` | Quote parsing, payability, and the confirmation summary. |
| `wallet.js` | The Bankr SIGNING capability surface and the EIP-1193 adapter. |
| `splitter.js` | Splitter ABI, `settle` encoding, and calldata decoding. |
| `relayer.js` | The narrow broadcaster boundary and its pre-broadcast assertions. |
| `remote-relay.js` | The Gate remote relay client, for a sandbox with no funded key. |
| `payment.js` | `authorizePayment` (sign + prepare) and `broadcastPayment` (relay). |
| `settlement.js` | Settlement hint, authoritative status polling, state copy. |
| `flow.js` | The ordered advocate flow and `sendAttentionRequest`. |

## Payer / relayer split

The Gate splitter does not require `msg.sender == payer`. The payer's authority
travels entirely inside the EIP-3009 authorization signature, which binds
`from`, `to`, `value`, and the quote id as its nonce. So the account that pays
gas is separate from the account that pays USDC:

```
Bankr wallet  --signs--> EIP-712 WalletSession proof
              --signs--> EIP-3009 ReceiveWithAuthorization
                             |
                             v
                   prepared { to, data, value }     (immutable, re-derived)
                             |
                             v
Relayer       --broadcasts--> splitter.settle()     (pays gas; is NOT the payer)
                             |
                             v
                        tx hash = HINT for Gate
```

Bankr signs; it never broadcasts. There is no broadcast fallback.

The relayer is either in process or **remote**. A Bankr sandbox is ephemeral and
holds no funded key, so the funded wallet normally lives on the Gate server and
the client reaches it through `remote-relay.js`. An in-process relayer, when one
is supplied, takes priority; with neither, payment fails by name with
`RELAYER_UNAVAILABLE`.

## Wallet capability surface (signing only)

Bankr owns the keys. The client asks only for public material.

```ts
getAddress(): Promise<string>
getChainId(): Promise<number>
switchChain?(chainId: number): Promise<void>
signTypedData({ account?, domain, types, primaryType, message }): Promise<string>   // 65-byte signature
call({ to, data }): Promise<string>                                                  // eth_call return data
```

There is no `sendTransaction`, and the EIP-1193 adapter exposes no
transaction-sending method.

## Relayer interface

```ts
getAddress(): Promise<string>                          // pays gas; MUST NOT be the payer
sendTransaction({ to, data, value }): Promise<string>   // tx hash
```

`{ to, data, value }` is the only object that crosses this boundary. A relayer
never receives a Gate session token, a Bankr API credential, an RPC credential,
or any advocate content, and there is no arbitrary-call abstraction.

Immediately before broadcast, `assertPreparedTransaction` re-derives the
transaction from the authoritative quote and refuses unless all of these hold:

- `to` equals `quote.domain.verifyingContract` (the splitter Gate signed over);
- the calldata selector is exactly the splitter's `settle`;
- `value` is zero;
- the decoded quote tuple matches the signed quote field for field, including
  the Gate quote signature;
- the decoded authorization's `from` is the Bankr payer, `to` is the splitter,
  `value` is the quote total, and its nonce is the quote id;
- the quote has not expired;
- the prepared object carries no field beyond `to`, `data`, and `value`;
- the relayer address is not the payer.

## Remote relay

```
POST {GAVEL_GATE_RELAYER_URL}/v1/submissions/{publicId}/relay
Authorization: Bearer <Gate base_sender session>

{ "authorization": { "signature": "0x<65 bytes>" } }   ->  200 { txHash, chainId, relayer }
```

The request body is the entire wire contract. There is no `to`, no `data`, and
no `value`: Gate resolves the quote from its OWN owner-bound record of this
submission, rebuilds the `settle` calldata from it, re-runs the same
`assertPreparedSettlement` guard server-side, and only then hands its gas-only
wallet `{ to, data, value: 0 }`. A body carrying a transaction field is refused
by name, not ignored, so the relay cannot become a general transaction relay.

Before sending, the client still runs the full guard locally and reads the
signature back out of the calldata the guard approved — which is what proves the
signature it sends belongs to this quote and no other.

`GAVEL_GATE_RELAYER_URL` is origin-only and must be a public HTTPS hostname. An
IP literal, a loopback, a LAN address, plain HTTP, a path, a query, credentials,
or a reserved test name (`.local`, `.test`, `.internal`, `example.com`, ...) is
a configuration failure, not a fallback: the client refuses to build a relay
with one.

On a transport failure the outcome is **UNKNOWN** - the relay may have broadcast
before the connection dropped. Read the submission's Gate status; never sign a
second payment.

`createEip1193Wallet(provider)` adapts a standard provider. The only
adaptation is adding the `EIP712Domain` type entry `eth_signTypedData_v4`
requires — the domain, the ordered types, the primary type, and every message
field pass through exactly as Gate issued them, so the digest signed is Gate's
digest.

There is no method that reads, derives, exports, or accepts a private key.

## Worked example

```js
const flow = createBankrGateFlow({
  wallet: createEip1193Wallet(provider),   // signs
  // Broadcasting: either an in-process `relayer` object, or
  // GAVEL_GATE_RELAYER_URL in the environment for Gate's remote relay. Both are
  // separate funded accounts; neither is ever the payer.
  env: process.env,
});

const target = await flow.resolveTarget({ proposer, slug });          // PRE_VOTE / SPONSOR
const voters = await flow.discoverVoters({ stage: target.stage });     // Gate's own directory

const result = await sendAttentionRequest({
  flow,
  target,
  voterWallet: voters[0].wallet,
  pitch,                 // untrusted; carried verbatim, never interpreted
  disclosures,           // untrusted
  evidenceUrls,          // untrusted; NEVER fetched
  confirm: async (summary) => showAndAwaitYes(summary.text),           // must return exactly true
});

result.delivered; // true only when Gate returned the authoritative `accepted`
```

## Gate endpoints used

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/gates` | Public voter discovery. |
| `GET` | `/v1/gates/:wallet` | Public voter profile, price, and policy. |
| `POST` | `/v1/gate/auth/challenge` | WalletSession challenge for `base_sender`. |
| `POST` | `/v1/gate/auth/verify` | Exchange the signed proof for a payer session. |
| `POST` | `/v1/gates/:wallet/submissions` | Create exactly one submission; `409` is a duplicate receipt. |
| `GET` | `/v1/submissions/:id/resume` | Owner-bound recovery of the ORIGINAL quote. |
| `POST` | `/v1/submissions/:id/settlement` | Record the broadcast tx hash as a HINT. |
| `GET` | `/v1/submissions/:id/status` | The authoritative public receipt state. |

Index: `GET /v1/gate/daos/nouns/targets/:targetId` and
`GET /v1/gate/daos/nouns/proposals/:id`.

`/v1/gate/me/profile` and `/v1/gate/me/inbox*` are deliberately absent. They are
the voter's routes, and this client must never reach them.

## Never logged

The WalletSession token, any typed-data signature, any private key, and any RPC
credential. Errors carry a coarse code and user-facing copy; they never echo
signature material, a session token, or advocate content.
