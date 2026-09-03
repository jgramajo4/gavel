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

Common non-secret/runtime settings are `NOUNS_SUBGRAPH_URL`,
`GAVEL_MODEL_ADDRESS`, `GAVEL_ASSET_OWNER_ADDRESS`, `GAVEL_SAFE_ADDRESS`, and
`GAVEL_WAAP_ADDRESS`. Chain-backed commands default to `https://eth.drpc.org`.
`ETHEREUM_RPC_URL` or `--rpc` is an optional advanced override; store any RPC
credentials through Hermes secret facilities and do not persist or echo raw
private keys.

The address roles are independent:

- model address: historical behavior being modeled;
- asset owner: optional cold/token-owning address;
- execution address: the Safe, WaaP, or unsigned voting address;
- required delegate: always the configured execution address for the mode.

Check readiness before preparing execution:

```bash
gavel execution-status --dao nouns --mode safe-supervised --model-address 0xMODEL
gavel execution-status --dao nouns --mode waap-autonomous --model-address 0xMODEL
```

If the result reports `redelegationRequired`, disclose both addresses and use
`gavel prepare-delegation`; that command never submits the change.

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
