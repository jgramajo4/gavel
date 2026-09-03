# Private profile storage

Gavel voter profiles are private application state. They can contain inferred
governance tendencies, preserved voting reasons, stated preferences, hard rules,
and prepared transaction material. Do not publish them to a social profile,
project-update feed, skill package, source repository, or chat transcript.

## Recommended locations

| Runtime | Private state location | Durability requirement |
| --- | --- | --- |
| Bankr | `/cli/gavel/data/private/` | Confirm the file appears in Bankr's persistent Files storage and survives a new task |
| Local/BYOH | An absolute, access-controlled `GAVEL_DATA_DIR` | Back it up using the operator's normal encrypted backup policy |
| Railway | A mounted volume such as `/data/gavel` | Set `GAVEL_DATA_DIR` to the volume, not the ephemeral application filesystem |
| Stateless CI or agent | `--stdout` plus a private external store | Never rely on the runner's workspace after the job exits |

Bankr Agent Profiles are public project pages and update feeds. They are not a
database and must not contain Gavel voter profiles. Bankr memory is automatically
loaded into future conversations, so with the user's consent it may hold a
minimal pointer such as the voter address and private profile path, but not the
profile JSON itself.

## Bankr durability check

After history, onboarding, profile, or policy output is written:

1. Read the CLI's JSON summary and capture its absolute `output` path.
2. Verify that exact path is beneath `/cli/gavel/data/private/` and is nonempty.
3. Confirm the file is visible in Bankr's persistent Files storage, not only in
   the current `execute_cli` process.
4. Start a new Bankr task and verify the same file before claiming persistence.
5. Stop and disclose the failure if the file is absent. Regenerate public history
   if needed, but never invent or silently discard private preferences or rules.

Seeing a file twice inside one sandbox task proves only local writes, not
cross-task durability.

## Future storage adapters

The current storage contract is filesystem-based and selected with
`GAVEL_DATA_DIR`. A future adapter can target encrypted object storage or a
database, but it should preserve the same properties: per-voter isolation,
private-by-default access, atomic writes, schema/version metadata, explicit
export/import, and no implicit publication. Runtime-specific storage must remain
outside `@gavel/core` governance logic.
