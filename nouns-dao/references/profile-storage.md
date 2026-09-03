# Private voter profile persistence

Gavel profiles are private application files, not Bankr Agent Profile content.
Agent Profiles and project updates are public publishing surfaces and must never
receive voting reasons, inferred tendencies, preferences, rules, or prepared
transactions.

Use `/cli/gavel/data/private/` in Bankr's persistent Files storage. After a
state-producing CLI command:

1. parse the JSON summary and capture its absolute `output` path;
2. require the path to be beneath `/cli/gavel/data/private/`;
3. verify the file is nonempty and visible through Bankr's persistent Files
   storage, not only the current `execute_cli` sandbox;
4. in a later task, verify the same path before loading or rebuilding it;
5. disclose and stop on a missing file instead of pretending memory persisted.

For a profile, verify both the immutable public-history cache and the derived
private profile. For a new voter, also verify the preferences file. With the
user's consent, Bankr memory may store the voter address and private file path
as a pointer, but not the JSON profile itself.

If private Files persistence is unavailable, use `--stdout` only with an
explicit user-approved private external store. Never fall back to an Agent
Profile, public update, chat message, or published artifact.
