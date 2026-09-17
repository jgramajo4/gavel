# Optional server boundary

`@gavel/server` is the canonical composition boundary for the self-hosted Gavel
HTTP service. `createGateServerRuntime` accepts the existing auth, profile, and
submission services and injects PR6 settlement dependencies into the same HTTP
server; it does not create or deploy a second backend.

Settlement is opt-in. Without `GAVEL_GATE_SPLITTER`, the settlement route and
jobs are absent. Partial or invalid settlement configuration throws during
composition instead of exposing a nonfunctional route.

PR6 settlement settings:

- `GAVEL_GATE_ENVIRONMENT` — required when configured; exactly `production` or `test`
- `GAVEL_GATE_BASE_CHAIN_ID` — `8453` for production or `84532` for test
- `GAVEL_GATE_BASE_USDC` — canonical Base native USDC in production; an explicitly configured test-token address in test
- `GAVEL_GATE_TEST_TOKEN_LABEL` — required and nonblank for test; the variable must be completely absent in production (empty or whitespace values are rejected)
- `GAVEL_GATE_SPLITTER` — enables settlement and is then required to be an address
- `GAVEL_GATE_QUOTE_SIGNER_ADDRESS` — required public signer identity; must match the registry, splitter immutable, and quote service
- `GAVEL_GATE_OWNER_RECIPIENT` — required recipient identity; must match the registry and splitter immutable
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

Configured startup calls `store.getDeployment({ chainId, splitter })`, verifies the
RPC-reported chain, then uses the bundled RPC attestor (`getCode` plus read-only
`call`) before HTTP composition. It reads deployed runtime bytecode, splitter
`usdc`, `quoteSigner`, `gavelRecipient`, `GAVEL_FEE_AMOUNT`, splitter domain
separator, and token `name`, `version`, and domain separator. Startup compares
those values to explicit runtime configuration, the persisted registry tuple,
the quote service's frozen non-secret issuance identity, fixed fee `250000`, and
computed EIP-712 domains.

The Base RPC client, lifecycle reader, and optional narrow notification provider
are injected. A notification provider must set `durableIdempotency = true` and
durably deduplicate every external send by the supplied `idempotencyKey`; the
worker rejects providers that cannot make that guarantee.

PR8 adds a library adapter at `src/gate/notifiers/email.js`. It speaks the PR6
worker interface. `createEmailNotifier` never hardcodes
`durableIdempotency = true`; it inherits that flag from the injected `send`
function. A dummy sender is rejected by the worker.

`createAgentMailSender` is the only bundled sender that sets
`durableIdempotency = true`. It stamps a non-empty `Idempotency-Key` header on
`POST /v0/inboxes/{inbox}/messages/send`, times out at 10s, and does not follow
redirects. That flag is justified by AgentMail's primary docs, not by a mock:

- https://docs.agentmail.to/idempotency.md
- https://docs.agentmail.to/knowledge-base/preventing-duplicate-sends.md

Those pages document send-path idempotency via `Idempotency-Key` (not
`clientId`, which is create-only): a retry with the same key returns the
original message and sends no second email; the same key with a different body
is `409 Conflict`; keys expire 24 hours after the send completes. This guarantee
is time-bounded, not perpetual. The first attempt and 24-hour deadline are
persisted; retries stop before the deadline and enter private manual
reconciliation. A `409` follows the same terminal reconciliation path and is
never treated as a successful or automatically retryable send. Missing or
invalid keys fail before any fetch. Operator alerts contain only a stable error
code and source, never the key, destination, body, response, or headers. Legacy
claimed attempts with unknowable provider history also require reconciliation.
This adapter has not live-probed AgentMail. An unusable `message_id` is dropped
(`null`) instead of failing a send that already went out.

The adapter is not composed into `createGateServerRuntime` in this PR. There is
no `resolveDestination` decryptor and no `AGENTMAIL_*` wiring.

Private inbox HTTP (exact `dao_inbox` session equal to the enrolled profile
wallet):

- `GET /v1/gate/me/profile` — public profile projection for the session wallet
- `GET /v1/gate/me/inbox`
- `GET /v1/gate/me/inbox/:id`
- `POST /v1/gate/me/inbox/:id/archive` — idempotent; does not change public accepted state
