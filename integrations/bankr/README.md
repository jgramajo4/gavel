# Bankr integration

Bankr is a host for Gavel, not a dependency of the governance engine. Its
current install contract remains `/cli/gavel`, with private state at
`/cli/gavel/data/private/`. The canonical CLI now honors `GAVEL_DATA_DIR`, so a
Bankr deployment may set that path explicitly without putting it in core.

The installable compatibility skill remains at [`../../nouns-dao/`](../../nouns-dao/)
until existing Bankr installs have migrated. It calls `gavel`/`bin/gavel.js`,
which is a compatibility shim for `packages/cli/bin/gavel.js`.

Do not call legacy direct-signing scripts from new workflows. They remain only
for backward compatibility and require `AGENT_PRIVATE_KEY`; canonical Gavel
preparation and executor APIs do not read that variable.
