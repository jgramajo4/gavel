# Bankr integration

Bankr is a host for Gavel's Nouns, ENS, and Railgun adapters, not a dependency of the governance engine. Its
`execute_cli` containers and arbitrary sandbox paths, including `/cli`, are
ephemeral. Clone Gavel inside the current invocation, stage durable inputs from
private user files with `filesFromUserFs`, and export each intended result with
`publishArtifacts` to `/gavel/data/private/`. The canonical CLI remains unaware
of Bankr and accepts explicit input/output paths or `GAVEL_DATA_DIR`.

Gavel defaults raw Ethereum reads to `https://eth.drpc.org`, because Bankr's
internal transaction tools do not expose a JSON-RPC URL to sandbox scripts.
Advanced users may set `ETHEREUM_RPC_URL` in Bankr's secure environment settings.
The public default is read/verification infrastructure only and does not give
Gavel access to a Bankr wallet. Advanced archive-heavy checks may still require
a dedicated provider override.

The installable compatibility skill remains at [`../../nouns-dao/`](../../nouns-dao/)
until existing Bankr installs have migrated. It calls `gavel`/`bin/gavel.js`,
which is a compatibility shim for `packages/cli/bin/gavel.js`.

Install or update it by sending Bankr:

```text
Install or update the Gavel skill from:
https://github.com/jgramajo4/gavel/tree/main/nouns-dao
```

Bankr replaces an existing skill with the same name. Start a new conversation
afterward so the refreshed instructions are loaded. Skill replacement and
runtime cloning never authorize changes to private Gavel files.

Use `--dao nouns`, `--dao ens`, or `--dao railgun-eth` where a command accepts a
DAO. Keep private state under a DAO-specific directory. ENS preparation is for
the executable Governor venue; Railgun preparation is binary and computes its
staking snapshot hint before producing unsigned calldata.

Do not call legacy direct-signing scripts from new workflows. They remain only
for backward compatibility and require `AGENT_PRIVATE_KEY`; canonical Gavel
preparation and executor APIs do not read that variable.

Bankr Agent Profiles and project updates are public publishing features, not
private Gavel storage. After creating a voter profile, require zero command
exits and successful artifact metadata, then restore it from a new task. See
[`../../docs/storage/PROFILE_STORAGE.md`](../../docs/storage/PROFILE_STORAGE.md).

## Gate

Bankr may host the Gavel CLI, including `gavel gate profile` and
`gavel gate inbox`. That does not make Bankr the settlement authority.

Do not claim:

- Bankr owns payment settlement;
- a Bankr or email notification proves delivery;
- Bankr can bypass Gate quote or settlement verification;
- Bankr supports follow-up, reply, XMTP, Telegram, or policy editing.

Lobbyists pay the attention price plus Gavel's fixed fee through the Gate
splitter. The voter receives 100% of the attention price. Gavel receives only
the disclosed fixed fee. Inbox creation on the Gate backend is the paid-service
completion condition; notification is private and best-effort.

### Gate advocate client

[`SKILL.md`](SKILL.md) is the installable Bankr skill for the advocate/payer
side of Gate: a Bankr user pays to put a Nouns Proposal Candidate in front of an
enrolled Gate voter. Its client code is [`src/`](src/) and its API reference is
[`references/gate-advocate-client.md`](references/gate-advocate-client.md).

Bankr is the advocate/payer client and nothing more. The advocate/payer and the
voter/recipient are different actors; Bankr authenticates the payer wallet on
Gate's existing `base_sender` WalletSession path and never opens a
`dao_profile` or `dao_inbox` session, so it can never read a voter's private
inbox.

Gate keeps every decision: quote issuance, eligibility, capacity, lifecycle,
settlement verification, and inbox creation. The flow is

```
target -> voter -> pitch -> quote -> confirmation -> payment -> verification
```

and each step is a call into Gate's own surfaces:

- a real Nouns Proposal Candidate resolves through canonical index data and maps
  to `PRE_VOTE` / `SPONSOR` — never to `VOTING`, and never with language that
  implies an on-chain vote is open. An active proposal maps to `VOTING`;
- voters come from Gate's public directory, not a parallel Bankr list;
- pitch, disclosures, and evidence URLs are untrusted data. Evidence URLs are
  carried verbatim and are never fetched, unfurled, summarized, or followed;
- every payment value comes from the server-issued quote. Conversational text
  never overrides a quote payment field, and a `409 duplicate` resumes the
  original quote rather than creating a second one;
- Bankr signs and does not broadcast. It produces one EIP-3009 authorization,
  which the client verifies recovers to the quote's payer, and a separate funded
  relayer broadcasts the exact prepared `settle` transaction. The splitter does
  not require `msg.sender == payer`, so the gas payer and the USDC payer are
  different accounts. There is no ERC-20 approve flow and no private key is read;
- that relayer is either in process or remote. A Bankr sandbox holds no funded
  key, so with `GAVEL_GATE_RELAYER_URL` set the client sends Gate the
  authorization signature alone and Gate — which signed the quote — rebuilds the
  settlement from its own record, re-runs the same guard, and broadcasts with a
  gas-only wallet that never holds USDC. No target, calldata, or value crosses
  that boundary in either direction, so it cannot become a transaction relay;
- the broadcast transaction hash goes to Gate as a settlement HINT. Neither a
  mined transaction nor a successful relayer receipt is acceptance: only Gate
  returning the authoritative `accepted` means the request reached the voter's
  private Gate inbox.

Base mainnet, real USDC. `GAVEL_GATE_CHAIN_IDS` defaults to `8453` and the
client refuses a quote for any other chain — Base Sepolia included — before
anything is signed, naming the chain rather than formatting a test-token amount
as though it were real. Splitter, token, and chain are read from the Gate quote
and are never hard-coded here.

Configure `GAVEL_GATE_URL` (the production Gate API origin) and, optionally,
`GAVEL_INDEX_API_URL`. Refer to these by name; never echo a value. The
voter-facing web app is deployed separately at `gate.0773h.com` and is not owned
by this integration. AgentMail is disabled.

Run the focused suite with:

```bash
npm run test:bankr-gate
```
