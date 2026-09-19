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

## Private voter inbox

`/inbox` reads the merged owner-bound routes and nothing else:

| Route | Method | Purpose |
| --- | --- | --- |
| `/v1/gate/me/inbox` | `GET` | List this voter's accepted submissions |
| `/v1/gate/me/inbox/:id` | `GET` | Open one item (404 for missing *and* foreign) |
| `/v1/gate/me/inbox/:id/archive` | `POST` | Idempotent archive |

All three require a `dao_inbox` WalletSession bearer token. The page requests a
`dao_inbox` challenge, signs it with the enrolled governance wallet, exchanges
the signature for a session, and refuses to use a session the server issued for
any other role — an advocate's `base_sender` token is never sent to an inbox
route. There is no public inbox endpoint, and no reply or follow-up control,
because the server serves neither.

Items arrive only after Gate's scanner independently verified settlement, so the
inbox never claims a submission landed before the backend accepted it.

A **Nouns proposal candidate** (`canonicalFacts.kind === "candidate"`, target ID
`candidate:…`, no `proposalId`) is labelled **Seeking sponsorship** and marked a
PRE_VOTE sponsorship request. An active proposal keeps the server's normalized
stage vocabulary (`PRE_VOTE` / `VOTING` / `CLOSED`). The two never share a badge.

Advocate content in an item is untrusted: the pitch and disclosures go through
the frozen `@gavel/gate` CommonMark allowlist, and evidence URLs go through
`ExternalLink`, which links absolute HTTPS only and renders anything else as
inert text with no `href`. Nothing on the page fetches, previews, unfurls, or
summarizes an evidence URL, and no submission body is logged or measured.

## Settlement semantics

`POST /v1/submissions/:publicId/settlement` returning 202 means only that the
browser's transaction hash was recorded as a hint. It is not payment, delivery,
or acceptance. The UI shows `accepted` strictly when
`GET /v1/submissions/:publicId/status` reports it — never from a wallet success,
a receipt, one confirmation, or the 202 itself.

## Backend gaps

These are deferred backend items this app is written against but cannot
exercise today. None of them is worked around with invented data.

1. **No deployment metadata endpoint.** The splitter address, token, and chain
   are only observable inside an issued quote. Before a quote exists there is no
   way to tell a user which chain to connect to.
2. **No published USDC EIP-712 domain.** The token's `name`/`version` are needed
   to sign the authorization. Rather than assuming `"USD Coin"`/`"2"` — which
   would break on a test token — `readTokenDomain` reads both from the token and
   proves them against the token's own `DOMAIN_SEPARATOR()` before signing. A
   mismatch aborts; it never falls back to a guess.
3. **EOA enrollment only.** The server contract includes ERC-1271 and the
   separate Base `BasePayoutControl` proof, but the merged submission path
   requires an EOA payer, so the UI does not offer Safe enrollment.

## Commands

```bash
npm run dev       --workspace @gavel/gate-web
npm run build     --workspace @gavel/gate-web
npm run typecheck --workspace @gavel/gate-web
npm test          --workspace @gavel/gate-web
```
