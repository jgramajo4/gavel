# Bankr integration

Bankr is a host for Gavel, not a dependency of the governance engine. Its
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

Do not call legacy direct-signing scripts from new workflows. They remain only
for backward compatibility and require `AGENT_PRIVATE_KEY`; canonical Gavel
preparation and executor APIs do not read that variable.

Bankr Agent Profiles and project updates are public publishing features, not
private Gavel storage. After creating a voter profile, require zero command
exits and successful artifact metadata, then restore it from a new task. See
[`../../docs/storage/PROFILE_STORAGE.md`](../../docs/storage/PROFILE_STORAGE.md).
