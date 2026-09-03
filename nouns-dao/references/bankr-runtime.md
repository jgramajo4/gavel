# Bankr runtime setup

The installed skill contains instructions and references. Gavel's executable
runtime is the public `jgramajo4/gavel` repository. Bankr `execute_cli`
containers and arbitrary paths inside them are ephemeral; `/cli/gavel` is not a
persistent installation and must never be treated as one.

## Install inside the current sandbox

Run installation and the requested Gavel workflow in the same `execute_cli`
invocation whenever possible. Use `workDir: "workspace"` and never print
environment-variable values.

1. Clone the merged public runtime into the sandbox:

   ```bash
   git clone --branch main --single-branch https://github.com/jgramajo4/gavel.git gavel
   ```

   For a catalog release, replace `main` with the immutable release tag created
   from the validated commit. Do not silently switch revisions mid-workflow.
2. Confirm the remote before running code:

   ```bash
   git -C gavel remote get-url origin
   git -C gavel status --short --branch
   ```

   The origin must be exactly `https://github.com/jgramajo4/gavel.git` or the
   equivalent GitHub SSH URL. Stop on an unexpected remote or dirty tracked file.
3. Install locked dependencies without changing the lockfile:

   ```bash
   cd gavel && npm ci
   ```

4. Run the offline suite before the first real-voter workflow for that release:

   ```bash
   cd gavel && npm test
   ```

Re-cloning in a fresh task is expected. Durable voter state is restored
separately with `filesFromUserFs`; it must not depend on the cloned repository
surviving. See `profile-storage.md` before every state-producing command.

## Command convention

Every reference that says to run a Gavel command assumes the repository was
cloned as `workspace/gavel` and the command runs inside the current sandbox:

```bash
cd gavel && node bin/gavel.js <command>
```

Paths created by that command remain ephemeral unless the same `execute_cli`
invocation exports each intended file with `publishArtifacts`.

## Private persistent state

Bankr's durable, wallet-scoped state root for Gavel is:

```text
/gavel/data/private/
```

This is a persistent user-files path, not a sandbox path and not part of the
skill. Never publish private state to an Agent Profile, project update, chat,
`/runs` artifact, skill resource, or Git repository.

For the persistence pilot:

1. onboard and build a profile in one staged `execute_cli` workflow;
2. require a successful command result and successful `artifacts` entries;
3. record only the voter address, evidence cutoff, counts, persistent paths,
   file IDs, and byte sizes—not private reasons or preference contents;
4. end the Bankr conversation and start a new one;
5. use `list_files`, then stage the same files with `filesFromUserFs` and verify
   the profile without rebuilding it;
6. add one correction, republish it, end the session again, and verify it remains.

Passing a unit test or seeing a file inside one sandbox is not persistence
evidence.

## Network configuration

- Public history/proposal ingestion needs outbound HTTPS.
- Chain-backed commands default to the public `https://eth.drpc.org` endpoint;
  Bankr does not need to provide its own raw RPC URL for the basic workflow.
- `ETHEREUM_RPC_URL` in Bankr's secure Env Vars settings is an optional advanced
  override for higher limits, privacy requirements, or a dedicated provider.
  Archive-heavy proposal checks can require this override. Refer to the variable
  by name and never echo its value.
- No private key is required by Gavel. It produces unsigned calldata only.

If runtime installation, dependency installation, RPC access, command execution,
artifact publication, or later restoration fails, report the exact stage and
stop. Do not downgrade canonical checks or claim state was saved.
