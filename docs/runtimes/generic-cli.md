# Generic CLI / BYOH

`gavel` is the stable headless interface for persistent and interactive agent
runtimes. Successful commands emit JSON. Use `--stdout` when the complete
artifact is needed on standard output and `GAVEL_STRUCTURED_ERRORS=1` for JSON
errors. Set `GAVEL_DATA_DIR` to choose persistent private state independently of
the host runtime.

No Bankr, Hermes, wallet, private key, or always-on agent environment is
required. A shell workflow may run history, profile, proposal, predict, inspect,
prepare-vote, execution-status, and prepare-delegation directly.

Chain-backed commands default to the public Ethereum endpoint
`https://eth.drpc.org`. `ETHEREUM_RPC_URL` or `--rpc` is an optional advanced
override for higher limits, privacy requirements, or a self-hosted node. Public
RPC availability and archive access are not guaranteed; Gavel fails closed
rather than weakening a chain verification when the endpoint is unavailable.

The default `./data/private` directory is private by convention, not magically
durable. Persistent runtimes should set an absolute `GAVEL_DATA_DIR` backed by
their own filesystem, volume, or private artifact store. See
[`../storage/PROFILE_STORAGE.md`](../storage/PROFILE_STORAGE.md).
