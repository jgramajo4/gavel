# Generic CLI / BYOH

`gavel` is the stable headless interface for persistent and interactive agent
runtimes. Successful commands emit JSON. Use `--stdout` when the complete
artifact is needed on standard output and `GAVEL_STRUCTURED_ERRORS=1` for JSON
errors. Set `GAVEL_DATA_DIR` to choose persistent private state independently of
the host runtime.

No Bankr, Hermes, wallet, private key, or always-on agent environment is
required. A shell workflow may run history, profile, proposal, predict, inspect,
prepare-vote, execution-status, and prepare-delegation directly.
