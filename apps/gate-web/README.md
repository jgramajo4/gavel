# @gavel/gate-web

The human-facing Gavel Gate client: public Gate discovery, Gate profiles,
enrollment, paid submission composition, quote checkout, settlement state, and
the private voter inbox.

Experimental. The browser is not authoritative for anything that matters.

## Trust boundary

The server owns validation, quote issuance, settlement verification, lifecycle
eligibility, capacity, and the public/private projections. This app:

- reuses `@gavel/gate` for the Markdown allowlist and the EIP-3009 authorization
  derivation rather than reimplementing either, so the two cannot drift;
- treats its own input limits as UX only — a server rejection always wins;
- never fetches, previews, unfurls, or summarizes an advocate's evidence URL;
- never renders raw HTML, images, embeds, or Mermaid, and never uses
  `dangerouslySetInnerHTML`;
- keeps the session token in memory only: nothing is written to `localStorage`,
  `sessionStorage`, IndexedDB, or a cookie;
- logs nothing — no signatures, tokens, wallet proofs, or submission bodies.

## Payment

One EIP-3009 `receiveWithAuthorization` signature, consumed by one `settle` call
on `GavelGateSplitter`. There is no ERC-20 `approve` path, and no USDC ever
moves to a Gavel-operated server address.

Every signed and submitted value is derived from the persisted, server-signed
quote: voter, fee, token, splitter, amount, quote ID, and submission hash all
come from `quote.message` and `quote.domain`.

React state and `history.state` are display caches, never payment authority.
Pressing Pay re-fetches the owner-bound quote from the authenticated resume
endpoint and pays *that* object, so a tampered tab cannot get a mutated amount,
splitter, or chain in front of the wallet. Resume issues nothing, signs nothing,
and extends nothing.

Payment is refused before the wallet is touched when `quoteVersion !== "1"` or
`expiry <= now`. The splitter sets `validBefore = expiry` and reverts at
`block.timestamp >= expiry`, so a signature produced at or after expiry is dead
on arrival. The pay control disappears once a quote is unpayable.

**Chain IDs are never hard-coded.** The chain comes from `quote.domain.chainId`,
which the server signed over, so a Base Sepolia deployment works with no code
change. The API origin comes from `VITE_GATE_API_URL`.

## Settlement semantics

`POST /v1/submissions/:publicId/settlement` returning 202 means only that the
browser's transaction hash was recorded as a hint. It is not payment, delivery,
or acceptance. The UI shows `accepted` strictly when
`GET /v1/submissions/:publicId/status` reports it — never from a wallet success,
a receipt, one confirmation, or the 202 itself.

## Backend gaps

These are deferred backend items this app is written against but cannot
exercise today. None of them is worked around with invented data.

1. **No private inbox API.** PR4–PR6 serve no voter inbox route, so this app
   ships no inbox client at all — no methods, no response types, no parser.
   `/inbox` is a static product-gap page that issues zero requests. A
   speculative client would become that route's undeclared contract the first
   time some future response returned 200. The inbox lands with its backend.
2. **No deployment metadata endpoint.** The splitter address, token, and chain
   are only observable inside an issued quote. Before a quote exists there is no
   way to tell a user which chain to connect to.
3. **No published USDC EIP-712 domain.** The token's `name`/`version` are needed
   to sign the authorization. Rather than assuming `"USD Coin"`/`"2"` — which
   would break on a test token — `readTokenDomain` reads both from the token and
   proves them against the token's own `DOMAIN_SEPARATOR()` before signing. A
   mismatch aborts; it never falls back to a guess.
4. **EOA enrollment only.** The server contract includes ERC-1271 and the
   separate Base `BasePayoutControl` proof, but the merged submission path
   requires an EOA payer, so the UI does not offer Safe enrollment.

## Commands

```bash
npm run dev       --workspace @gavel/gate-web
npm run build     --workspace @gavel/gate-web
npm run typecheck --workspace @gavel/gate-web
npm test          --workspace @gavel/gate-web
```
