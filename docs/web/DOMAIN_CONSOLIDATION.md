# Domain consolidation: gavel.0773h.com

**Status: repository side done; infrastructure side NOT done.** Nothing in
this document has been applied to Cloudflare, DNS, or any host. Each
"Operator" step is for Sysadmin/Deployer.

## Target

| Host | Today | Target |
| --- | --- | --- |
| `gavel.0773h.com` | Static `website/` (Cloudflare Worker assets, `autumn-smoke-1812`) | **Gavel Web** (`apps/web` build), SPA fallback to `index.html` |
| `gate.0773h.com` | Standalone Gate SPA | **Legacy entrypoint**: permanent redirect to `gavel.0773h.com` |
| `api.0773h.com` / `api-mainnet.0773h.com` | Gate API | Unchanged; CORS adds `https://gavel.0773h.com` |
| `index.0773h.com` | Index API, **no CORS** (browsers cannot read it) | Unchanged; set `GAVEL_INDEX_CORS_ORIGINS=https://gavel.0773h.com` |

## Legacy URL mapping (the only mapping)

Implemented once, in `legacyGateTarget` (`apps/web/src/routes.ts`), unit-tested.

| Old `gate.0773h.com` path | Canonical `gavel.0773h.com` path |
| --- | --- |
| `/` | `/gate` |
| `/gates/:wallet` | `/gate/voters/:wallet` |
| `/gates/:wallet/compose` | `/gate/voters/:wallet/compose` |
| `/checkout/:publicId` | `/gate/checkout/:publicId` |
| `/inbox` | `/gate/inbox` |
| `/enroll` | `/gate/enroll` |

Query strings are preserved. Sessions never travel in URLs, so nothing secret
is carried.

**Edge rule (Operator):** one rule on `gate.0773h.com`:

- `/` → `301 https://gavel.0773h.com/gate`
- everything else → `301 https://gavel.0773h.com${path}${query}`

The app then forwards the old path in-app. Unknown or malformed old paths render
Gavel Web's not-found page rather than guessing.

## Cutover order (Operator)

Order matters: each step must work before the next, and each is reversible.

1. **Index CORS.** Deploy the index with
   `GAVEL_INDEX_CORS_ORIGINS=https://gavel.0773h.com`. Verify:
   `curl -sI -H 'Origin: https://gavel.0773h.com' https://index.0773h.com/v1/daos`
   returns `access-control-allow-origin: https://gavel.0773h.com`, and a
   different Origin gets no ACAO header.
2. **Gate CORS.** Add `https://gavel.0773h.com` to `GAVEL_GATE_CORS_ORIGINS`
   on the Gate API the build will target. Keep `https://gate.0773h.com` until
   step 5.
3. **Build Gavel Web** with explicit origins (the build refuses otherwise):
   `VITE_GAVEL_GATE_API_URL` and `VITE_GAVEL_INDEX_API_URL`. Serve `apps/web/dist` at
   `gavel.0773h.com` with SPA fallback (deep links like `/daos/ens/proposals`
   and `/gate/inbox` must return `index.html`, not 404).
4. **Redirect `gate.0773h.com`** with the edge rule above.
5. **Drop the legacy CORS origin** `https://gate.0773h.com` from
   `GAVEL_GATE_CORS_ORIGINS` once it only redirects.
6. Retire `website/` (the static page) in a follow-up PR once step 3 is live.
   It stays in the repository until then so the current deployment is not
   orphaned.

**Rollback:** remove the redirect (step 4) and redeploy the previous assets on
`gavel.0773h.com`. CORS additions are additive and safe to leave.

## Open question for Sysadmin (blocking step 3)

Which Gate API is production for the web app? The Gate VPS runbook names
`api-mainnet.0773h.com` as production, but the live `gate.0773h.com` bundle
calls `api.0773h.com`, which older notes map to the staging container. The
build must be pointed at one deliberately; this repository does not choose.

## Audit of frontend-origin references

| Area | Finding | Action in this PR |
| --- | --- | --- |
| App config | Single `VITE_GATE_API_URL`, same-origin default | Replaced by validated `VITE_GAVEL_GATE_API_URL` + `VITE_GAVEL_INDEX_API_URL`; old name refused |
| CORS | Gate: exact allowlist. Index: none | Index: opt-in exact allowlist; `.env` examples list `gavel.0773h.com` |
| Session audience | Gate API host, not frontend | No change needed |
| Callback/redirect URLs | Gate server builds no frontend URLs; `resumeUrl` is an API path | No change needed |
| CSP / `connect-src` | No CSP anywhere | None to update; adding one is a follow-up |
| Bankr | SKILL.md named `gate.0773h.com` as the web app; `GAVEL_GATE_URL` is the API/relay origin | Copy updated; manifest build ID refreshed. Test fixtures keep `gate.0773h.com` as an arbitrary HTTPS origin |
| Hermes skill | No frontend URL | None |
| Docs | `apps/gate-web` paths, `gate-web` scripts | Updated; old script names aliased |
| Plans (`docs/plans/*`) | Historical `apps/gate-web` references | Left as history |
