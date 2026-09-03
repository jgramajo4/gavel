# Bankr runtime setup and persistence

The installed skill contains instructions and references. Gavel's executable
runtime is the public `jgramajo4/gavel` repository and belongs in Bankr's
persistent `/cli` workspace.

## Install or verify the runtime

Use Bankr's `execute_cli` tool. Never print environment-variable values.

1. Check for `/cli/gavel/package.json` and `/cli/gavel/bin/gavel.js`.
2. Clone the merged public runtime from the default branch:

   ```bash
   git clone --branch main --single-branch https://github.com/jgramajo4/gavel.git /cli/gavel
   ```

   For a catalog release, replace `main` with the immutable release tag created
   from the validated commit. Do not silently switch an existing installation
   to a different revision.

3. Confirm the remote before running code:

   ```bash
   git -C /cli/gavel remote get-url origin
   git -C /cli/gavel status --short --branch
   ```

   The origin must be exactly `https://github.com/jgramajo4/gavel.git` or the
   equivalent GitHub SSH URL. Stop on an unexpected remote or dirty tracked file.
4. Install the locked dependencies without changing the lockfile:

   ```bash
   cd /cli/gavel && npm ci
   ```

5. Run the offline suite before onboarding a real voter:

   ```bash
   cd /cli/gavel && npm test
   ```

Do not silently pull new runtime code during a voter workflow. Upgrade only when
the user asks or the installed skill version requires it; inspect the diff, use a
fast-forward update, reinstall locked dependencies, and rerun tests.

## Command convention

Every reference that says to run a Gavel command assumes:

```bash
cd /cli/gavel && node bin/gavel.js <command>
```

Do not assume Bankr's current directory is the repository root.

## Private persistent state

Keep all voter-specific files under:

```text
/cli/gavel/data/private/
```

The repository excludes this directory from Git. Never run `git add -f` on it,
copy it into a skill resource, publish it in chat, or mix files between voters.

`execute_cli` processes may be short-lived. After any state-producing command,
read its JSON `output` path, verify that exact file is nonempty, and confirm it
appears in Bankr's persistent Files storage. Do not claim persistence merely
because the file exists inside the current sandbox process.

Bankr Agent Profiles and their project-update feeds are public. Never store a
Gavel voter profile, preferences, rules, reasons, or prepared transaction there.
With the user's consent, Bankr memory may retain only a minimal pointer (voter
address and private file path), not the profile JSON. See `profile-storage.md`
for the full policy.

For the persistence pilot:

1. onboard and build a profile;
2. record only the voter address, evidence cutoff, counts, and file path in the
   test notes—not private reasons or preference contents;
3. end the Bankr conversation and start a new one;
4. verify the same profile and policy files are present before rebuilding;
5. add one correction, end the session again, and verify it remains present.

Passing a unit test or seeing a file during the same conversation is not
persistence evidence.

## Network configuration

- Public history/proposal ingestion needs outbound HTTPS.
- Chain-backed commands default to the public `https://eth.drpc.org` endpoint;
  Bankr does not need to provide its own raw RPC URL for the basic workflow.
- `ETHEREUM_RPC_URL` in Bankr's secure Env Vars settings is an optional advanced
  override for higher limits, privacy requirements, or a dedicated provider.
  Archive-heavy proposal checks can require this override. Refer to the variable
  by name and never echo its value.
- No private key is required by Gavel. It produces unsigned calldata only.

If runtime installation, dependency installation, RPC access, or persistence
fails, report the exact stage and stop. Do not downgrade canonical checks.
