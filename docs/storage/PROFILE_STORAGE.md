# Private profile storage

Gavel voter profiles are private application state. They can contain inferred
governance tendencies, preserved voting reasons, stated preferences, hard rules,
and prepared transaction material. Do not publish them to a social profile,
project-update feed, skill package, source repository, or chat transcript.

## Recommended locations

| Runtime | Private state location | Durability requirement |
| --- | --- | --- |
| Bankr | Persistent user files beneath `/gavel/data/private/` | Stage with `filesFromUserFs`, export each file with `publishArtifacts`, and verify the returned artifact metadata |
| Local/BYOH | An absolute, access-controlled `GAVEL_DATA_DIR` | Back it up using the operator's normal encrypted backup policy |
| Railway | A mounted volume such as `/data/gavel` | Set `GAVEL_DATA_DIR` to the volume, not the ephemeral application filesystem |
| Stateless CI or agent | `--stdout` plus a private external store | Never rely on the runner's workspace after the job exits |

Bankr Agent Profiles are public project pages and update feeds. They are not a
database and must not contain Gavel voter profiles. Bankr memory is automatically
loaded into future conversations, so with the user's consent it may hold a
minimal pointer such as the voter address and private profile path, but not the
profile JSON itself.

## Bankr durability check

Bankr sandbox paths, including `/cli`, are ephemeral and do not automatically
sync to persistent user files. After history, onboarding, profile, or policy
output is produced:

1. Stage existing files with `filesFromUserFs` into a sandbox input directory.
2. Write new results to a separate, fresh sandbox output directory.
3. Map at most five individual result files to explicit persistent filenames
   with `publishArtifacts`; recursive directory publication is unsupported. The
   per-file limit is 10 MB on Bankr's free tier and 50 MB for Bankr Club.
4. Require the Gavel commands to exit zero even if artifacts were returned,
   because Bankr attempts publication after a nonzero exit.
5. Verify every expected artifact has the exact destination, a `fileId`, positive
   byte size, and no error. Then use `list_files` from a new task and restore the
   file with `filesFromUserFs` before claiming cross-task persistence.
6. Stop and disclose the failure if any file is absent. Regenerate public history
   if needed, but never invent or silently discard private preferences or rules.

Seeing a file twice inside one sandbox task proves only local writes, not
cross-task durability. Bankr storage is last-write-wins, so serialize stateful
workflows for each voter.

## Future storage adapters

The current storage contract is filesystem-based and selected with
`GAVEL_DATA_DIR`. A future adapter can target encrypted object storage or a
database, but it should preserve the same properties: per-voter isolation,
private-by-default access, atomic writes, schema/version metadata, explicit
export/import, and no implicit publication. Runtime-specific storage must remain
outside `@gavel/core` governance logic.
