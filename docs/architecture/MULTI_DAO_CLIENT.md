# Gavel as a multi-DAO governance client

Gavel used to be a Nouns TUI with other adapters available behind the CLI. The
governance core was already multi-DAO -- Nouns, ENS and Railgun adapters all
satisfy one `GovernanceAdapter` contract -- but the client on top of it was
not: the home screen was the Nouns proposal list, the only chain reads were
Nouns contract reads, and there was no way to say which DAOs you follow.

This document describes the client layer that closes that gap.

## Layering

```
packages/core        governance, intent, execution  (unchanged invariants)
  src/dao/catalog        which DAOs exist, and what each can do
  src/config/            the client configuration model, migration, secrets
  src/wallet/            the wallet-provider boundary
  src/readiness/         runtime and per-DAO readiness
  src/onboarding/        the setup wizard state machine
  src/view/              the unified inbox view model
packages/daos        catalog id -> live DAO adapter  (the only such table)
packages/cli         the stable BYOH boundary; every setting is reachable here
packages/tui         keyboard and pixels; owns no governance semantics
```

Core cannot import a DAO adapter -- that boundary is asserted in
`test/architecture-boundaries.test.js` -- so `@gavel/daos` holds the mapping
from a catalog id to a constructed adapter, and
`assertDescriptorMatchesAdapter()` checks on every construction that the
catalog told the truth about the adapter it describes.

## The DAO catalog

A descriptor is static data: no RPC, no provider, no network. That is what
lets the wizard list DAOs before anything is configured.

| | Nouns | ENS | Railgun |
|---|---|---|---|
| proposals / voting | yes | yes | yes |
| delegation | yes | yes | yes (voting key) |
| voting-power queries | yes | yes | yes |
| proposal decoding | yes | yes | yes |
| calendar | no | no | no |
| private voting | no | no | no |
| interactive approval | yes | yes | yes |
| Safe-supervised | yes | yes | no |
| autonomous (WaaP) | no* | no | no |

\* Nouns' adapter declares `waapAutonomous: true`; the autonomous *mode* still
requires explicit per-user acknowledgement before it can be selected.

No adapter ships a governance-calendar feed, so `calendar` is false everywhere
rather than omitted: the capability exists so the UI already branches on it.

Each DAO also carries its own vocabulary, because "Votes", "Voting power" and
"Staked voting power" are not the same quantity:

```
nouns        Votes / Delegated votes
ens          Voting power / Delegation
railgun-eth  Staked voting power / Voting key
```

## Proposal identity

Proposal ids are per-DAO counters, so `(dao, proposalId)` is the only identity
Gavel uses internally. Ids are decimal strings: an ENS proposal id is a
uint256 and does not survive `Number()`. The user-facing label always carries
the DAO name (`Nouns #812`, `ENS #123`), because the worst failure of a merged
inbox is acting on the wrong governance system.

## Configuration

Eight independent branches, none of them DAO-shaped:

```json
{
  "schemaVersion": "2.0.0",
  "runtime":       { "dataDir": null, "indexApiUrl": null },
  "identity":      { "address": "0x...", "label": null },
  "wallet":        { "type": "walletconnect", "local": null, "walletconnect": { "session": {} } },
  "execution":     { "mode": "eoa-supervised", "safe": null, "autonomous": null, "payoutAddress": null },
  "followedDaos":  ["nouns", "ens"],
  "inference":     { "mode": "local", "endpointVariable": null },
  "privacy":       { "network": "direct" },
  "notifications": { "proposalAlerts": true, "dailyBriefing": false, "executionAlerts": true, "calendarReminders": false },
  "onboarding":    { "completed": true, "completedAt": "...", "lastStep": "finish" }
}
```

`followedDaos` is a flat list of ids and *not* a per-DAO settings tree. Adding
a DAO is appending a string; everything DAO-specific is answered by the
adapter and the catalog, so a fourth adapter needs no wizard redesign.

No branch can hold a secret. `wallet.local.variable` names an environment
variable and `execution.safe.proposerIdentity` names a keystore label; the
values behind those names are read at the point of use.
`assertNoSecrets()` runs on every write and fails the save rather than
persisting one.

### Old vs new

| Old | New |
|---|---|
| implicit single DAO | `followedDaos: [...]` |
| `wallet` (ambiguous) | `identity.address` + `wallet.type` + `execution.*` roles |
| private key in config / `GAVEL_PRIVATE_KEY` read at bootstrap | a signer reference; the TUI has no key path at all |
| one global readiness boolean | runtime signals + per-DAO monitor/analyze/vote |
| prediction cache at `~/.config/gavel/cache.json`, keyed by proposal id | `GAVEL_DATA_DIR/prediction-cache.json`, keyed by `dao:proposalId` |

### Migration

`migrateGavelConfig()` is idempotent and never *increases* authority.

- `{ dao: "nouns" }` or a config with no DAO at all becomes
  `followedDaos: ["nouns"]`, with a recorded note in the second case.
- An ambiguous `wallet` field becomes the governance identity, read-only, with
  a note saying migration will not grant signing authority on its own.
- A plaintext key or phrase is detected by shape, removed, and never echoed:
  the note says a secret was found and where to put it instead, and nothing
  about its value reaches the config, the note or a log.
- A signing execution mode drops to `unsigned`, because the migrated wallet is
  read-only. Re-selecting it is one explicit step in Settings.

## Wallet providers

One contract, three transports:

```
connect / disconnect / getAccount / getChainId / getCapabilities
getStatus / requestSignature / requestTransaction
```

- **ReadOnlyWalletProvider** -- an address and no authority. A fully supported
  configuration: monitoring, analysis, recommendation and intent preparation
  all work.
- **LocalSignerWalletProvider** -- a signer the host already holds. Gavel keeps
  a reference (`keystore:label` or `environment:VAR`), never material.
- **WalletConnectProvider** -- the protocol lives behind an injected
  `transport`; core holds only the session state machine. Sessions persist as
  `{ topic, account, chainId, expiresAt }` and nothing else; unknown keys from
  a transport are dropped rather than copied, so a relay key cannot reach
  `GAVEL_DATA_DIR`.

Errors name the failing layer: `WALLET_SESSION_EXPIRED`,
`WALLET_REQUEST_REJECTED`, `WALLET_WRONG_CHAIN` ("Connected wallet is on chain
8453; this action requires chain 1"), `WALLET_WRONG_ACCOUNT`,
`WALLET_NOT_CONNECTED`, `WALLET_TRANSPORT_UNAVAILABLE`. Messages are redacted
on construction, so an error built from a transport response cannot leak a
session secret.

**WalletConnect is not an arbitrary-call bypass.** `requestTransaction()`
refuses any request without a validated intent hash, exactly one module in the
monorepo calls it (the interactive execution adapter), and that module rebuilds
the request from `validated.intent` rather than from the preparation payload.
Both are enforced by tests.

No WalletConnect relay client ships in this build, so the wizard shows
WalletConnect as unavailable with its reason rather than pretending it can
pair. `registerWalletConnectTransport()` is the seam a host plugs into.

## Execution

`eoa-supervised` is promoted from a declared-but-unimplemented mode to an
implemented one, backed by `InteractiveWalletExecutionAdapter`. It holds no
credential at all -- its `identityRole` is `null` -- because the key lives in
the user's wallet app and Gavel only ever presents a request. A rejection is a
normal outcome (`CANCELLED` with a reason), not a thrown failure.

Offered modes are filtered by what can actually work: interactive approval
needs a connected wallet, Safe-supervised needs a followed DAO that supports
it, and autonomous is never a one-keystroke choice. Unavailable modes are
shown disabled *with their reason* rather than hidden.

Switching modes never changes delegation. Safe restrictions are untouched: the
Safe adapter's owner checks, read-back verification and intent-derived SafeTx
construction are unchanged by this work.

## Readiness

One boolean cannot describe several DAOs, so readiness is a matrix of three
separable questions per DAO:

```json
{
  "daos": {
    "nouns": { "index": "ready", "identity": "ready", "vote": "ready" },
    "ens":   { "index": "ready", "identity": "ready", "vote": "unavailable" }
  }
}
```

`monitor`, `analyze` and `vote` degrade independently. **Zero voting power is
not an error**: `vote` is unavailable with an `info`-severity reason, and
monitoring and analysis stay ready. One unreachable indexer degrades one row;
`canLaunch` only goes false when the runtime itself cannot function.

## Secrets

Configuration holds references. `resolveSecretAudit()` answers with
`{ variable, source, status }` and nothing else, and `redactSecrets()` is the
backstop applied to config writes, JSON output, status views, logs, errors and
diagnostics. Tests assert with sentinel values that raw secrets never appear in
any of them.

## GAVEL_DATA_DIR

Runtime-owned private state: preferences, followed DAOs, the local governance
profile, recommendation history, non-secret workflow state and cached proposal
metadata. Not a secret vault. Every deployment gets its own by pointing
`GAVEL_DATA_DIR` elsewhere, so a standalone TUI, Hermes, Bankr and a container
never share state.

## CLI parity

Everything the wizard configures is reachable headlessly:

```
gavel daos list|capabilities|follow|unfollow   [--json]
gavel wallet status                            [--json]
gavel readiness                                [--json]
gavel secrets status                           [--json]
gavel config show|path|migrate                 [--json]
```

`gavel readiness --json` answers the questions a harness actually asks: which
DAOs are enabled, whether Gavel can vote in each, which execution mode applies
and whether human approval is required.

## The wizard

```
══════ welcome ══════
⚖  Gavel setup  · step 1/11 · Welcome

Gavel follows governance across the DAOs you choose, recommends how to vote using local or
configured inference, and leaves signing to the wallet you pick.

· Gavel follows governance across the DAOs you choose.
· Recommendations run locally, or through inference you configure.
· Signing stays with the wallet and execution mode you pick.

↵ continue  esc back

══════ data-dir ══════
⚖  Gavel setup  · step 2/11 · Private data

Where Gavel keeps your preferences, followed DAOs and local governance history.

Directory  ~/.gavel

Stored here:
  · your preferences and followed DAOs
  · your local governance profile and voting history
  · recommendation history and local workflow state
  · cached proposal metadata
Never stored here:
  · seed phrases
  · private keys
  · API keys or provider credentials
  · WalletConnect session secrets

↵ continue  esc back

══════ daos ══════
⚖  Gavel setup  · step 3/11 · Follow DAOs

Pick the governance systems you care about.

› [ ] Nouns  (Ethereum)
      Nouns DAO governance on Ethereum mainnet.
  [ ] ENS  (Ethereum)
      ENS DAO governance (OpenZeppelin Governor) on Ethereum mainnet.
  [ ] Railgun  (Ethereum)
      Railgun governance on Ethereum mainnet; votes are cast by staked amount.

↵ continue  esc back  space toggle

══════ wallet ══════
⚖  Gavel setup  · step 4/11 · Connect wallet

How you want to control signing, if at all.

› ◉ WalletConnect (recommended)
    Approve each action in your own wallet app. No key or phrase enters Gavel.
    ⚠ No WalletConnect transport is registered in this build.
  ○ Local wallet
    Use a signer supplied by the host (GAVEL_PRIVATE_KEY) or an encrypted keystore.
    ⚠ Create an encrypted keystore with `gavel identity create`, or provide
GAVEL_PRIVATE_KEY.
  ○ Read-only
    Follow, analyze and prepare votes. Gavel will not sign or broadcast.

↵ continue  esc back

══════ verify ══════
⚖  Gavel setup  · step 5/11 · Check DAOs

What Gavel can see for your identity in each followed DAO.

Nouns         unavailable
  Nouns indexer unavailable: GAVEL_INDEX_API_URL must be an HTTP(S) URL
ENS           unavailable
  ENS indexer unavailable: GAVEL_INDEX_API_URL must be an HTTP(S) URL

A DAO that is down does not block setup. You can continue.

↵ continue  esc back

══════ execution ══════
⚖  Gavel setup  · step 6/11 · Execution

What Gavel may do once it has a recommendation.

› ◉ Prepare only
    Validated calldata handed back for out-of-band signing.
  ○ Interactive approval
    Presented to a user-controlled wallet for explicit human approval.
  ○ Safe-supervised
    Proposed into a Safe queue; human Safe owners authorize and execute.
  ○ Autonomous
    Signed and broadcast by a policy-constrained execution wallet.
    ⚠ Autonomous execution requires explicit setup and acknowledgement.

↵ continue  esc back

══════ inference ══════
⚖  Gavel setup  · step 7/11 · Recommendations

Where recommendations are computed.

› ◉ Local
    Gavel's own precedent engine, in this process. Nothing leaves the machine.
  ○ Remote provider
    A configured scoring endpoint. Proposal text is sent to it.
  ○ Runtime-provided
    The host harness supplies inference (Claude Code, Hermes, Bankr, ...).

↵ continue  esc back

══════ privacy ══════
⚖  Gavel setup  · step 8/11 · Privacy

How Gavel reaches the network.

› ◉ Direct
  ○ Tor
    ⚠ Not implemented in this build.
  ○ Nym
    ⚠ Not implemented in this build.

↵ continue  esc back

══════ notifications ══════
⚖  Gavel setup  · step 9/11 · Alerts

What Gavel tells you about, across every followed DAO.

› [x] Proposal alerts
      New and closing proposals in every followed DAO.
  [ ] Daily briefing
      One summary across all followed DAOs.
  [x] Execution alerts
      When a prepared action needs you.

↵ continue  esc back  space toggle

══════ review ══════
⚖  Gavel setup  · step 10/11 · Review

Everything you chose. No secrets are shown or stored.

DAOs
  Nouns       Unchecked
  ENS         Unchecked
  Railgun     Not selected
Wallet
  WalletConnect · 0x1111111111111111111111111111111111111111
Execution
  Prepare only
Recommendations
  local
Private data
  (default)
Secrets
  ETHEREUM_RPC_URL: not-required (source: none)
  GAVEL_INDEX_API_URL: not-required (source: none)
  PREDICTION_URL: not-required (source: none)
  WALLETCONNECT_PROJECT_ID: not-required (source: none)
  GAVEL_SAFE_PASSPHRASE: not-required (source: none)
  GAVEL_PRIVATE_KEY: not-required (source: none)
  GAVEL_GATE_TOKEN: not-required (source: none)

Overall Ready

↵ continue  esc back

══════ finish ══════
⚖  Gavel setup  · step 11/11 · Finish

Open Gavel.

Setup complete.
Press ↵ to open Gavel.

↵ continue  esc back
```

## The client

```
══════ home — unified inbox ══════
Nouns · ENS · Railgun · eoa-supervised                              nouns client 38 · 0.0000 ETH
⚖  Gavel  · Governance inbox                                         (pending) · 🔗
3 need attention · 3 DAOs · updated 0s ago                          WalletConnect 0x1111…1111

Needs attention
› ENS #123          Treasury diversification tranch…  ends soon     7h 59m
  Nouns #811        Retro funding round               voting open   1d 15h
  Nouns #812        Fund the client incentives prog…  new proposal  4d 23h

Following
Nouns         1 active
ENS           1 active
Railgun       unavailable     governance index 503: Service Unavailable

↑/↓ j/k move  ↵ open  f filter by DAO  r refresh  s settings  q quit

══════ settings ══════
Nouns · ENS · Railgun · eoa-supervised                              nouns client 38 · 0.0000 ETH
⚖  Gavel  · Settings                                                 (pending) · 🔗
~/.gavel/config.json                                                WalletConnect 0x1111…1111

› Followed DAOs
  Wallet connection
  Execution mode
  Recommendations
  Alerts
  Secrets

↑/↓ move  ↵ open  esc back
```
