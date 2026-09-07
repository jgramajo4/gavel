# Hermes runtime configuration

The bundled `scripts/gavel.js` runner performs first-use installation. It fetches
the pinned Gavel commit into a versioned directory, verifies the repository
origin and exact commit, installs locked production dependencies without package
scripts, and reuses that immutable runtime on later calls.

By default it uses:

```text
runtime: $HERMES_HOME/runtimes/gavel/<pinned-commit>/
data:    $HERMES_HOME/data/gavel/
```

`HERMES_HOME` defaults to the current user's `.hermes` directory. The runtime
and data roots may be overridden with `GAVEL_RUNTIME_DIR` and `GAVEL_DATA_DIR`,
but they must not overlap. Container operators must mount `HERMES_HOME` or the
chosen data directory on a persistent private volume. Bootstrap never deletes,
moves, imports, or overwrites voter data.

The ordinary end-user flow is only:

```bash
hermes skills install https://raw.githubusercontent.com/jgramajo4/gavel/main/integrations/hermes/SKILL.md --yes
```

Then invoke `/gavel-governance` with a natural-language request. The skill runs
its bootstrap automatically; users do not clone Gavel or install it globally.

## Update an existing installation

Hermes remembers the direct skill URL. Check for upstream changes and refresh
installed skills with:

```bash
hermes skills check
hermes skills update
```

Start a new session or use `/reset` after updating so Hermes reloads the skill.
`hermes update` updates Hermes itself; it does not replace
`hermes skills update`. A refreshed Gavel skill points its runner at a new
immutable runtime directory. Bootstrap never overwrites `GAVEL_DATA_DIR`, so
updating code and preserving private voter state remain separate operations.

Common non-secret/runtime settings are `NOUNS_SUBGRAPH_URL`,
`GAVEL_INDEX_API_URL`, `GAVEL_INDEX_MAX_STALENESS_SECONDS`,
`GAVEL_MODEL_ADDRESS`, `GAVEL_ASSET_OWNER_ADDRESS`, `GAVEL_SAFE_ADDRESS`, and
`GAVEL_WAAP_ADDRESS`. Chain-backed commands default to `https://eth.drpc.org`.
`ETHEREUM_RPC_URL` or `--rpc` is an optional advanced override; store any RPC
credentials through Hermes secret facilities and do not persist or echo raw
private keys.

## Governance index

Governance history for DAOs without a public subgraph comes from a Gavel
governance index. No configuration is required: clients read the public index at
`https://index.0773h.com` by default, which needs no endpoint value, no shared
secret, and no special network setup.

> **Open item:** the public endpoint is being stood up separately from this
> client change. Until it is serving, ENS and Railgun reads need
> `GAVEL_INDEX_API_URL` pointing at an operator's index.

Default behavior, with nothing configured:

- `gavel history --dao ens` and `--dao railgun-eth` read the public index. No
  public subgraph serves these DAOs, so this is their only source.
- `gavel proposal --dao ens` resolves `ProposalCreated` metadata from the public
  index and live-verifies it against the Governor over RPC.
- `gavel history --dao nouns` and `gavel proposal --dao nouns` keep using the
  Nouns subgraph; `gavel proposal --dao railgun-eth` keeps using direct contract
  reads.

`GAVEL_INDEX_API_URL` overrides that default with a private or self-hosted
index, and then applies to every DAO including Nouns. The runner does not set
it; export it in the environment that invokes `scripts/gavel.js`, which the
runtime inherits. It is an endpoint, not voter state, so it belongs in operator
configuration and never inside `GAVEL_DATA_DIR`.

```bash
export GAVEL_INDEX_API_URL=http://127.0.0.1:18080
```

Put no credentials in that URL. The client sends no authentication of any kind
and has no header or token mechanism today, so a private index must sit behind a
network boundary that authenticates for it. Adding a client credential requires
adding that mechanism to `IndexApiClient` first, not encoding a secret in the
endpoint.

Every indexed read gates on checkpoint freshness first. The CLI refuses to
build a history document from an index that has no checkpoint, reports a sync
error, or is staler than `GAVEL_INDEX_MAX_STALENESS_SECONDS` (default `3600`).
Report that refusal as a stale or failing index and stop; do not silently fall
back to another source, and never present an empty indexed history as a voter
with no votes.

The address roles are independent:

- model address: historical behavior being modeled;
- asset owner: optional cold/token-owning address;
- execution address: the Safe, WaaP, or unsigned voting address;
- required delegate: always the configured execution address for the mode.

Check readiness before preparing execution:

```bash
gavel execution-status --dao nouns --mode safe-supervised --model-address 0xMODEL
gavel execution-status --dao nouns --mode waap-autonomous --model-address 0xMODEL
gavel execution-status --dao ens --mode safe-supervised --model-address 0xMODEL
gavel execution-status --dao railgun-eth --mode unsigned --model-address 0xMODEL
```

If the result reports `redelegationRequired`, disclose both addresses and use
`gavel prepare-delegation` for Nouns or ENS; that command never submits the
change. Railgun delegation is per stake and is intentionally not handled by the
generic command.

Safe clients integrate with the proposer-only `SafeSupervisedExecutor` API.
Gavel does not create a Safe or choose its address; operators configure an
existing Safe. No Safe owner key belongs in Gavel. WaaP clients integrate with the
`WaapAutonomousExecutor` API and must provide a policy hook; live WaaP broadcast
is intentionally not supplied by this integration.

## Profile portability

Hermes storage is independent from Bankr Files and Railway volumes. Do not imply
that installing this skill imports another runtime's profile. Until a portable
export/import command is shipped, users may securely copy `history.json`,
`profile.json`, `preferences.json`, and `rules.json` into the configured Hermes
data directory, preserving their private access controls. Never fetch another
runtime's private store implicitly or rebuild over imported policy files.
