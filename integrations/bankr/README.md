# Bankr integration

Bankr is a host for Gavel, not a dependency of the governance engine. Its
current install contract remains `/cli/gavel`, with private state at
`/cli/gavel/data/private/`. The canonical CLI now honors `GAVEL_DATA_DIR`, so a
Bankr deployment may set that path explicitly without putting it in core.

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
private Gavel storage. After creating a voter profile, verify its exact path in
Bankr's persistent Files storage and again from a new task. See
[`../../docs/storage/PROFILE_STORAGE.md`](../../docs/storage/PROFILE_STORAGE.md).
