# Bankr private-state lifecycle

Gavel profiles are private application files, not Bankr Agent Profile content.
Agent Profiles and project updates are public publishing surfaces and must never
receive voting reasons, inferred tendencies, preferences, rules, or prepared
transactions.

Bankr `execute_cli` sandboxes are ephemeral. Ordinary writes under `/cli`, the
repository, or another sandbox directory do not sync to persistent user files.
Use this lifecycle for every stateful workflow:

1. **Stage:** On a returning-voter task, pass the existing persistent voter
   directory through `filesFromUserFs` into `gavel-state/`. Omit it on a first
   run when the directory does not exist.
2. **Process:** Clone Gavel as `gavel/`, run it against `gavel-state/`, and write
   every intended new result to a fresh `gavel-publish/` file. Never stage an old
   file into `gavel-publish/`.
3. **Publish:** In that same `execute_cli` invocation, map each result file with
   `publishArtifacts` to an explicit filename beneath
   `/gavel/data/private/nouns/<lowercase-address>/`.
4. **Verify:** Require all commands to exit zero. Then require one successful
   `artifacts` entry per expected file with the exact destination, a nonempty
   `fileId`, a positive byte size, and no artifact error.
5. **Restore:** In a later task, use `list_files` and `filesFromUserFs` to load
   the saved profile. Do not rebuild it merely to test persistence.

## Mandatory discovery before onboarding

For requests such as "do you see my profile?", "load my profile", proposal
analysis, or any fresh-chat Gavel interaction, inspect persistent Files before
asking for an address or starting onboarding:

1. Call `list_files` with `folder: "/gavel/data/private/nouns"`.
2. If exactly one address directory contains `profile.json`, treat that as the
   returning voter and stage its directory with `filesFromUserFs`. Do not ask
   for the address again and do not re-fetch voting history.
3. If multiple address directories contain profiles, list only their addresses
   and ask which one to use. Do not open or summarize every profile.
4. If an address is already known, check its lowercase deterministic path
   directly before concluding that its profile is missing.
5. Only when persistent Files contains no matching profile may onboarding begin.

Apply this sequence identically on Bankr's website and Telegram. A conversation
or channel has no separate Gavel profile namespace. If the website can list a
profile but Telegram returns an empty persistent Files root, report an account
or wallet-linkage mismatch; do not say the profile was never saved and do not
silently rebuild it.

Publication still runs when a command exits nonzero. An artifact entry alone is
therefore not proof of a successful workflow. A fresh `gavel-publish/` directory
keeps a failed command from republishing a staged or stale input. Never run two
state-producing workflows concurrently for the same voter because Bankr storage
is last-write-wins.

## `execute_cli` mapping example

Replace the address before use. This example refreshes public vote history and
derives a profile. Add existing `preferences.json` and `rules.json` arguments
only when those files were staged and actually exist.

```json
{
  "commands": [
    "git clone --branch main --single-branch https://github.com/jgramajo4/gavel.git gavel",
    "cd gavel && npm ci",
    "test ! -e gavel-publish && mkdir gavel-publish && node gavel/bin/gavel.js history 0xVoterAddress --output gavel-publish/history.json && node gavel/bin/gavel.js profile gavel-publish/history.json --output gavel-publish/profile.json"
  ],
  "filesFromUserFs": [
    {
      "path": "/gavel/data/private/nouns/0xlowercaseaddress/",
      "sandboxPath": "gavel-state/"
    }
  ],
  "publishArtifacts": [
    {
      "sandboxPath": "gavel-publish/history.json",
      "destination": "/gavel/data/private/nouns/0xlowercaseaddress/history.json",
      "description": "normalized Nouns voter history",
      "mimeType": "application/json"
    },
    {
      "sandboxPath": "gavel-publish/profile.json",
      "destination": "/gavel/data/private/nouns/0xlowercaseaddress/profile.json",
      "description": "private Gavel voter profile",
      "mimeType": "application/json"
    }
  ],
  "workDir": "workspace",
  "timeoutMs": 600000,
  "includeEnvVars": true,
  "waitMs": 5000
}
```

On first onboarding, omit `filesFromUserFs`. For normal proposal analysis, stage
the saved `profile.json` and fetch only the requested proposal; do not refresh
historical votes unless the profile is genuinely stale. `publishArtifacts`
accepts at most five individual files and does not recursively publish a
directory. Each file must fit the active Bankr tier's artifact limit (10 MB on
the free tier or 50 MB for Bankr Club). Do not use `./output/` as durable storage
because its `/runs` copy is conversation-scoped and expires. Never put a private
key or PEM material in a Gavel artifact; Gavel does not require one.

For a new voter, persist `preferences.json`. For an existing voter, persist
`history.json` and `profile.json`; also persist any changed preferences or rules.
With the user's consent, Bankr memory may store only the voter address and the
persistent directory path as a pointer, never the profile JSON itself.

If persistent Files publication is unavailable, use `--stdout` only with an
explicit user-approved private external store. Never fall back to an Agent
Profile, public update, chat message, or public artifact.
