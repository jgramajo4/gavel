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
| `wallet.js` | The Bankr wallet capability surface and the EIP-1193 adapter. |
| `payment.js` | EIP-3009 authorization and the single splitter `settle` call. |
| `settlement.js` | Settlement hint, authoritative status polling, state copy. |
| `flow.js` | The ordered advocate flow and `sendAttentionRequest`. |

## Wallet capability surface

Bankr owns the keys. The client asks only for public material.

```ts
getAddress(): Promise<string>
getChainId(): Promise<number>
switchChain?(chainId: number): Promise<void>
signTypedData({ account?, domain, types, primaryType, message }): Promise<string>   // 65-byte signature
sendTransaction({ from, to, data, value }): Promise<string>                          // tx hash
call({ to, data }): Promise<string>                                                  // eth_call return data
```

`createEip1193Wallet(provider)` adapts a standard provider. The only
adaptation is adding the `EIP712Domain` type entry `eth_signTypedData_v4`
requires — the domain, the ordered types, the primary type, and every message
field pass through exactly as Gate issued them, so the digest signed is Gate's
digest.

There is no method that reads, derives, exports, or accepts a private key.

## Worked example

```js
const flow = createBankrGateFlow({
  wallet: createEip1193Wallet(provider),
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
