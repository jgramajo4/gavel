# Gavel Web architecture

Gavel Web (`apps/web`) is the one human-facing Gavel application, served at
`https://gavel.0773h.com`. It replaced two frontends: the static landing page
(`website/`) and the standalone Gate app (`gate.0773h.com`).

Gavel is the product. Gate, and later Receipts, Signals, Calendar and the
governance copilot, are **capabilities inside Gavel**, not sibling websites.
The Governance Indexer is the data spine underneath them.

## The capability contract

> A new Gavel capability should normally be addable as a **DAO capability**, a
> **governance-object action**, a **personal-governance feature**, or a
> **global data surface**, without requiring another standalone frontend.

| Kind | Where it lives | Example today | How to add one |
| --- | --- | --- | --- |
| DAO capability | `/daos/:dao/:section` tab or a feature flag on a section | Proposals (section), Gate entry point (feature) | Add to `CAPABILITIES` in `src/daos.ts`, render it in `pages/DaoPage.tsx`, list it on the DAOs whose data exists |
| Governance-object action | Inside an object page (proposal detail) | none yet | Add to the object page; gate it on the DAO's capability list |
| Personal-governance feature | Wallet/session-scoped surface | Gate inbox, enrollment | Under its capability's route prefix; requires a role session |
| Global data surface | Top-level route | Home latest-proposals | One route in `App.tsx` + `paths` in `src/routes.ts` |

Reserved and **not built**: `/me` (My Governance) and `/feed` (global
cross-DAO feed). They appear only as comments in `src/routes.ts`. There are no
placeholder pages or disabled tabs.

## Principles (enforced, with where)

- **DAOs are first-class objects.** `src/daos.ts` is the only list of DAOs.
  Navigation, the DAO index, the DAO shell, and the homepage all read it; no
  page names a DAO.
- **Unsupported capabilities do not appear.** A capability a DAO does not list
  has no tab, no route (`findSection` → not-found), and no empty page.
  Listing a capability before its index data exists is how fake tabs happen;
  don't.
- **Public exploration needs no wallet.** Home, `/daos/**`, and `/install`
  never call the wallet provider (tested).
- **Wallet addresses are canonical identity.** ENS is presentation only, from
  the server's verified `label`. The browser never resolves names.
- **Personalized functionality needs a role session.** Connecting a wallet
  grants nothing. Each workflow signs its own challenge for its own role
  (`dao_profile`, `dao_inbox`, `base_sender`).
- **The frontend is not an indexer.** It reads `index.0773h.com` and the Gate
  API; it never reads DAO contracts for governance data.
- **Provenance stays visible.** Index data is labelled as onchain facts from
  the Governance Indexer. The derived `effectiveStatus` is shown as the status;
  the raw source `state` is never promoted into it. Proposal text is author
  content, rendered inert (no HTML).
- **Mobile is first-class.** One header, one nav landmark, one wallet control
  at every width; a menu toggle under 720px. Every canonical route is tested at
  390px and 1280px.

## Route model

`src/routes.ts` owns every path (`paths.*`). Components never build URL
strings by hand.

| Path | Surface |
| --- | --- |
| `/` | Home: latest proposals per DAO, install entry, Governance Brief |
| `/daos`, `/daos/:dao`, `/daos/:dao/:section` | DAO index, overview, sections |
| `/daos/:dao/proposals/:id` | Proposal detail |
| `/install` | Agents, hosted, self-host, Governance Brief |
| `/gate/**` | Gate: directory, `voters/:wallet`, `voters/:wallet/compose`, `checkout/:publicId`, `inbox`, `enroll` |

Route params are untrusted: unknown DAO ids, unsupported sections, malformed
wallets, and non-numeric-or-hex proposal ids render not-found **before** any
API call.

Legacy Gate paths map deterministically through `legacyGateTarget`. See
[`DOMAIN_CONSOLIDATION.md`](DOMAIN_CONSOLIDATION.md).

## Data and error layer

```
component → domain client (gate-api.ts | index-api.ts) → requestJson (http.ts) → configured origin (config.ts)
```

- `config.ts` is the only reader of `import.meta.env`. Production builds fail
  on missing/invalid origins (see `apps/web/README.md`).
- `http.ts` is the only `fetch` call site. It produces one `ApiError` with a
  `kind`: `retryable` (network, 408/429/5xx), `not_found`, `action` (auth,
  validation, wrong role), or `defect` (malformed response). Pages render the
  kind, never a raw status.
- `index-api.ts` sends no credentials, bounds page size to 100, rejects rows
  for a different DAO than requested, and projects only fields it renders.
- `use-resource.ts` loads one keyed entity with abort on change and never
  shows a previous key's data (tested with deliberately late responses).

Two index facts the client works around and does not hide:

1. The index orders by proposal id. ENS (OpenZeppelin Governor) ids are
   hashes, so newest-first takes a full page plus a client sort
   (`newestFirst`, `proposalIds: 'hashed'` in the registry). This is marked
   **transitional**; the right fix is a `createdAt` order in the index API.
2. `effectiveStatus` can be absent; the UI then says so instead of falling
   back to the raw state.

## Wallet and session

One provider, one `WalletConnectionProvider`, one `SessionProvider`, at the
root. `SessionWalletBinding` (mounted once in the shell) drops the role session
when the account changes or the wallet locks, on every route. A chain switch
does not clear the session and never blocks public pages. Sessions are memory
only — never `localStorage`, `sessionStorage`, IndexedDB, or cookies.

The Gate auth **audience is the Gate API host**, not the frontend origin, so the
domain move changes CORS allowlists only, not session binding.

## What this issue deliberately did not do

- No change to Gate's security, auth, quote, or payment protocol.
- No new backend endpoints. Index CORS is the only server change (opt-in,
  exact-origin allowlist, same contract as Gate's).
- No Feed, Contracts, Streams, Delegates, `/me`, or `/feed` implementation.
