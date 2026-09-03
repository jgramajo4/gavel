# Hermes runtime configuration

Install the repository, run `npm ci`, and make the root `gavel` bin available.
Choose a durable, private directory owned by the Hermes runtime:

```bash
export GAVEL_DATA_DIR=/persistent/private/gavel
```

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

Safe clients integrate with the proposer-only `SafeSupervisedExecutor` API. No
Safe owner key belongs in Gavel. WaaP clients integrate with the
`WaapAutonomousExecutor` API and must provide a policy hook; live WaaP broadcast
is intentionally not supplied by this integration.
