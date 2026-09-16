# Optional server boundary

`@gavel/server` is the canonical composition boundary for the self-hosted Gavel
HTTP service. `createGateServerRuntime` accepts the existing auth, profile, and
submission services and injects PR6 settlement dependencies into the same HTTP
server; it does not create or deploy a second backend.

Settlement is opt-in. Without `GAVEL_GATE_SPLITTER`, the settlement route and
jobs are absent. Partial or invalid settlement configuration throws during
composition instead of exposing a nonfunctional route.

PR6 settlement settings:

- `GAVEL_GATE_BASE_CHAIN_ID` — defaults to `8453`
- `GAVEL_GATE_SPLITTER` — enables settlement and is then required to be an address
- `GAVEL_GATE_CONFIRMATION_DEPTH` — defaults to `1`
- `GAVEL_GATE_REORG_OVERLAP_BLOCKS` — defaults to `64`
- `GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE` — defaults to `5000` and must exceed the overlap
- `GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS` — defaults to `5000`
- `GAVEL_GATE_BASE_RPC_TIMEOUT_MS` — defaults to `10000`; every settlement RPC operation is bounded
- `GAVEL_GATE_NOTIFICATION_LEASE_MS` — defaults to `300000` and is capped at one hour

The injected Base RPC client must expose canonical blocks with their transaction
hashes, complete per-block receipt enumeration, and an independent transaction count
(`getBlock`, `getBlockReceipts(blockNumber)`, and
`getBlockTransactionCount(blockNumber)`). Scanner no-match evidence is accepted only
when the canonical transaction hashes, receipt transaction hashes, and independent
count agree exactly; filtered `eth_getLogs` results are never authoritative for
capacity release.

The Base RPC client, lifecycle reader, and optional narrow notification provider
are injected. A notification provider must set `durableIdempotency = true` and
durably deduplicate every external send by the supplied `idempotencyKey`; the
worker rejects providers that cannot make that guarantee.

PR8 adds the first concrete adapter at `src/gate/notifiers/email.js`. It speaks
the PR6 worker interface and sends AgentMail with the `Idempotency-Key` header
set to Gate's durable notification id. AgentMail documents that a retry with the
same key returns the original message and does not send a second email. Keys
expire 24 hours after the send completes.

Private inbox HTTP (exact `dao_inbox` session equal to the enrolled profile
wallet):

- `GET /v1/gate/me/profile` — public profile projection for the session wallet
- `GET /v1/gate/me/inbox`
- `GET /v1/gate/me/inbox/:id`
- `POST /v1/gate/me/inbox/:id/archive` — idempotent; does not change public accepted state
