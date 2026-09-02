# Bankr runtime setup and persistence

The installed skill contains instructions and references. Gavel's executable
runtime is the public `jgramajo4/gavel` repository and belongs in Bankr's
persistent `/cli` workspace.

## Install or verify the runtime

Use Bankr's `execute_cli` tool. Never print environment-variable values.

1. Check for `/cli/gavel/package.json` and `/cli/gavel/bin/gavel.js`.
2. During the pre-merge pilot, clone the same reviewed branch as the installed
   skill:

   ```bash
   git clone --branch phase9-launch-hardening --single-branch https://github.com/jgramajo4/gavel.git /cli/gavel
   ```

   Before catalog submission, replace this branch with the immutable release
   tag created from the merged commit. Do not publish a catalog skill that
   silently tracks a development branch.

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

For the persistence pilot:

1. onboard and build a profile;
2. record only the voter address, evidence cutoff, counts, and file path in the
   test notes—not private reasons or preference contents;
3. end the Bankr conversation and start a new one;
4. verify the same profile and policy files are present before rebuilding;
5. add one correction, end the session again, and verify it remains present.

Passing a unit test or seeing a file during the same conversation is not
persistence evidence.

## Required environment

- Public history/proposal ingestion needs outbound HTTPS.
- Vote preparation needs `ETHEREUM_RPC_URL` configured in Bankr's secure Env Vars
  settings. Refer to the variable by name and never echo its value.
- No private key is required by Gavel. It produces unsigned calldata only.

If runtime installation, dependency installation, RPC access, or persistence
fails, report the exact stage and stop. Do not downgrade canonical checks.
