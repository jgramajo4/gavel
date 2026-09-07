# Generic CLI / BYOH

`gavel` is the stable headless interface for persistent and interactive agent
runtimes. Successful commands emit JSON. Use `--stdout` when the complete
artifact is needed on standard output and `GAVEL_STRUCTURED_ERRORS=1` for JSON
errors. Set `GAVEL_DATA_DIR` to choose persistent private state independently of
the host runtime.

No Bankr, Hermes, wallet, private key, or always-on agent environment is
required. A shell workflow may run history, profile, proposal, predict, inspect,
prepare-vote, execution-status, and prepare-delegation directly.

DAO-aware commands use `nouns`, `ens`, or `railgun-eth`. Nouns has direct
subgraph history and proposal ingestion. Railgun has direct Ethereum proposal
reads. Vote history for every DAO, and Nouns and ENS proposal metadata, come
from a governance index; the CLI live-verifies indexed ENS `ProposalCreated`
metadata against the Governor before using it. Once history is available,
analysis, vote preparation, execution readiness, and delegation are the same for
every DAO. ENS Snapshot data is a separate venue and is not accepted as Governor
transaction metadata.

No index configuration is required. Clients read the public index at
`https://index.0773h.com` by default, so a harness needs no endpoint value, no
shared secret, and no network setup. `GAVEL_INDEX_API_URL` selects a private or
self-hosted index instead. Credentials must not be embedded in that URL: the
client sends no authentication and exposes no header or token mechanism, so a
private index must sit behind a network boundary that authenticates for it.

The index carries indexed history and proposal metadata only. Anything that must
be current is read over RPC: voting power, delegation, proposal state, Railgun
proposal reads, and the canonical proposal verification `prepare-vote` performs
against the live Governor before producing calldata. An orchestrator therefore
still needs an Ethereum endpoint. `history --dao nouns --endpoint <url>` opts a
Nouns read back onto a subgraph when the index is unavailable.

Indexed reads gate on checkpoint freshness before returning anything: an index
with no checkpoint, a source reporting a sync error, or a newest checkpoint
older than `GAVEL_INDEX_MAX_STALENESS_SECONDS` (default `3600`) fails the
command, and `GAVEL_STRUCTURED_ERRORS=1` reports it under category
`STALE_DATA`. An orchestrator must treat that as a hard stop, never as a voter
with no votes, and must not silently fall back to another source.
`packages/governance-index` ships the worker, schema, and read-only API for
operators who self-host one.

Railgun vote preparation refuses `ABSTAIN` and reason text, computes the staking
snapshot hint, and uses all remaining voting power unless `--amount` is supplied.
The generic delegation command does not handle Railgun's per-stake delegation.

Chain-backed commands default to the public Ethereum endpoint
`https://eth.drpc.org`. `ETHEREUM_RPC_URL` or `--rpc` is an optional advanced
override for higher limits, privacy requirements, or a self-hosted node. Public
RPC availability and archive access are not guaranteed; Gavel fails closed
rather than weakening a chain verification when the endpoint is unavailable.

The default `./data/private` directory is private by convention, not magically
durable. Persistent runtimes should set an absolute `GAVEL_DATA_DIR` backed by
their own filesystem, volume, or private artifact store. See
[`../storage/PROFILE_STORAGE.md`](../storage/PROFILE_STORAGE.md).
