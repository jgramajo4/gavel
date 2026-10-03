# Gate invariants

Durable rules for changing Gate code. They come from prior reviews and incidents. `docs/GAVEL_GATE_TECHNICAL_SPEC.md` and `docs/GAVEL_GATE_MVP_DECISIONS.md` remain normative. If this file conflicts with them, the spec wins; report the conflict.

## Authority and boundaries

- Payment, quote issuance, settlement verification and inbox creation live only in `packages/server`. CLI, web, Hermes and Bankr call existing HTTP routes.
- Never add a client method for a route the server does not serve. Add the route in the same change, or leave the client without it.
- Identity comes from the session, never from the body or query. Wrong role is 401. Foreign or guessed ids return identical 404s.
- `authenticateSession` defaults the expected audience to the service's own audience. `base_sender` is also bound to the service's Base chain (8453 production, 84532 test). A role match alone is not an environment boundary.
- Bankr (payer) signs but never broadcasts. A separate relayer broadcasts only the prepared `{ to, data, value }`. The relayer re-derives and re-checks every settle field against the signed quote.
- One Gate database per environment. Do not add `environment` to `gate.profiles`, and do not delete `splitter_deployments` rows. Isolation is a startup check (`assertEnvironmentIsolation`) behind an explicit `disabled`/`enforced` switch.
- Wall-clock expiry only moves a reservation to `expiry_pending_reconciliation`. Capacity is released only inside `gate.record_scanner_range` (the scanner range transaction) or `gate.release_expired_reservation`. Both re-check persisted scanner coverage. Production wires only the scanner path; `releaseReservation` has no production caller. Never add a request-path or operator release.

## Privacy and telemetry

- Public serializers are constructed, never stripped private objects. Tests must fail if destination, notification, capacity, quote signature, session or provider fields appear.
- Telemetry is aggregate-only and default-deny: allowlisted metric names, label keys and values, and alert source/code pairs. Never emit wallets, identifiers, hashes, destinations, signatures, bodies, headers or raw exceptions.
- Error messages reach logs only through explicit allowlists of first-party constants or strictly anchored templates. Never regex-redact and forward upstream text. Sink failures must not replace the original error or suppress the alert.
- Advocate pitch, disclosures and evidence URLs are untrusted data: render them as data, and never fetch or execute them.

## Notifications

- An adapter sets `durableIdempotency === true` only when the provider durably dedupes on the worker's `idempotencyKey`. AgentMail needs a valid `Idempotency-Key` header. A 409 is a private terminal conflict, not success.
- A notification failure never changes public `accepted` or rolls back settlement. The notification is an optional settlement side effect, isolated behind a savepoint in PostgreSQL.
- Destinations are encrypted with an authenticated envelope bound to the profile id. Startup proves an encrypt-then-decrypt round trip and binds that exact cipher to writes and reads.
- Notifier mode is explicit (`disabled` or the named provider). Blank provider variables in Compose still fail `disabled` mode.

## Startup and runtime

- Before listening, startup must:
  - prove the runtime role's capabilities, privileges, migration checksum and catalog manifest;
  - check canonical-index freshness;
  - read `eth_chainId` over a transport request, never from static provider metadata;
  - confirm on-chain splitter, token and domain attestation;
  - confirm the signer identity matches the submission service.
- Start workers only after all checks pass. On shutdown, stop scheduling, `Promise.allSettled` the active workers, then close the listener, then the pool.
- Scanner receipts are the only discovery authority. `record_scanner_range` requires one canonical header per height with parent continuity. Use `toQuantity` for block tags. Use raw `send`, not cached `getBlock`, for reorg re-reads.

## Migrations (`packages/server/migrations/001_gate.sql`)

- The marker checksum is exact-match. A new marker requires every preflight classification and final allowlist entry to be updated. Roll back by restoring the previous marker, then the old image.
- Do not `CREATE OR REPLACE` `gavel_gate_catalog_manifest` before the preflight that calls it; its body is part of the stored snapshot.
- Evaluate catalog predicates only inside their checksum-gated branch. PostgreSQL 16 deparses `IN (8453,84532)` as `= ANY (ARRAY[...])`.
- Treat a NULL `relacl`/`nspacl` as `acldefault(...)`, not as no access. Dump and restore can change the JSON without changing authorization.
- Drop only specifically named legacy constraints. Changing a `RETURNS TABLE` shape requires dropping the old signature first.
- When upgrading data protected by an immutable trigger, backfill by disabling only that named trigger inside the migration and re-enabling it immediately.
- Migration regex tests are scaffolding. Only a disposable PostgreSQL run (see `docs/TESTING.md`) proves ordering, triggers, legacy upgrades and rerun idempotence.
- Build legacy fixtures as coherent historical schemas, not fresh schemas with an old checksum written in.
- Runtime privileges are defined twice: SQL grants and `verifyGatePermissions` in `packages/governance-index/src/roles.js`. Keep exact parity and test it.

## Governance provenance used by Gate

- Gate quote issuance reads only Nouns `/v1/gate/daos/nouns/proposals|targets`. Missing `chainId`/`governorAddress` is an identity mismatch (409), not unavailable (503).
- Bind projections to the exact canonical source identity and record key. Persist block number, block hash, observation head and normalized state as one snapshot under a canonical-key lock.
- Validate action collections as dense arrays (`Array.from`, not `map`), with indexes equal to position and exactly five fields.
- Candidate identity is `keccak256(UTF-8 slug)` recomputed at every trust boundary. Issuance accepts only eligible `ACTIVE`/`PRE_VOTE` Candidates; settlement must still read terminal `CLOSED`.
