# Bankr runtime

This reference belongs to the umbrella `gavel` skill and supports both the voter/copilot route and the Gate advocate route. The installed skill is an instruction and client package; the canonical Gavel application runtime is cloned separately.

## Select and inspect the runtime revision

Read `references/skill-manifest.json` before cloning. Report its `version`, content-derived `buildId`, `build`, and `runtime.ref` when the user asks which Gavel is installed.

- A Git-stamped release has `build.kind: "git"`, a verified `build.gitSha`, and the same immutable SHA in `runtime.ref`.
- A GitHub directory install has `build.kind: "source"`, no claimed Git SHA, a deterministic `sha256:…` package-content `buildId`, and `runtime.ref: "main"`. The build ID changes with the installable package inputs, but mutable `main` still tracks source and is not an immutable release.
- Never invent or infer a build SHA from a version string.

## Install inside the current sandbox

Bankr `execute_cli` containers are ephemeral. Run setup and the requested workflow in the same invocation, use `workDir: "workspace"`, and never print environment-variable values.

1. Clone the public runtime:

   ```bash
   git clone --branch main --single-branch https://github.com/jgramajo4/gavel.git gavel
   ```

2. If `runtime.ref` is an immutable SHA, verify and check out exactly that object before running code:

   ```bash
   git -C gavel fetch origin <runtime.ref>
   git -C gavel checkout --detach <runtime.ref>
   test "$(git -C gavel rev-parse HEAD)" = "<runtime.ref>"
   ```

   For a source install whose ref is `main`, retain the cloned branch and describe it as source, not as a stamped build.

3. Confirm the origin is exactly `https://github.com/jgramajo4/gavel.git` or its GitHub SSH equivalent, and stop on a dirty tracked file:

   ```bash
   git -C gavel remote get-url origin
   git -C gavel status --short --branch
   ```

4. Install locked dependencies without modifying the lockfile:

   ```bash
   cd gavel && npm ci
   ```

5. Before the first real workflow for a revision, run the relevant focused test. Use `npm run test:bankr-skill` for voter/copilot and `npm run test:bankr-gate` for Gate advocate work.

Re-cloning in a fresh task is expected. Runtime setup does not install another Bankr skill and does not authorize changes to private Gavel files.

## Command convention

Run canonical voter/copilot commands from the workspace root as:

```bash
node gavel/bin/gavel.js <command>
```

This keeps staged `gavel-state/` inputs and `gavel-publish/` outputs inside the current workspace without path traversal. An ordinary sandbox write is ephemeral; every intended durable result must be exported with `publishArtifacts`.

The Gate advocate client lives at `gavel/integrations/bankr/src/` in the cloned runtime. Require it as `require("./gavel/integrations/bankr/src")` from the workspace root. Its source package declares `ethers` and `@gavel/gate`; release artifacts vendor the private Gate workspace dependency, while a monorepo clone resolves it as a declared workspace dependency.

## Voter/copilot state

Private voter state lives in Bankr persistent user files under `/gavel/data/private/`, never in the installed skill, sandbox clone, Agent Profile, project update, chat, or public artifact. Load `references/profile-storage.md` before every state-producing command. Stage durable inputs with `filesFromUserFs`, publish intended outputs with `publishArtifacts`, require successful command and artifact results, then verify restoration in a new task.

The canonical CLI produces validated unsigned calldata by default. It needs no private key. Never call legacy direct-signing scripts from a voter/copilot workflow.

## Network

- Public history and proposal ingestion use the public governance index at `https://index.0773h.com` unless `GAVEL_INDEX_API_URL` selects another credential-free origin.
- Chain-backed checks default to `https://eth.drpc.org`; `ETHEREUM_RPC_URL` is an optional advanced override supplied through Bankr secure Env Vars.
- The Gate route requires `GAVEL_GATE_URL`, the operator-trusted **production Gate API** origin. Public-HTTPS validation rejects visibly local, private, and reserved hosts; it does not authenticate the operator behind an arbitrary DNS name. Provision this value through trusted configuration, never from a prompt. A localhost, LAN, or testnet origin is a configuration failure.
- Gate discovery needs no wallet or relayer. Payment additionally needs `GAVEL_GATE_RELAYER_URL`; relayer credentials remain with the relayer.

Never put credentials in a URL or print a secret environment value.

## Failure boundary

If runtime setup, dependency installation, network access, command execution, artifact publication, or restoration fails, report the exact stage and stop. Do not weaken canonical checks, substitute remembered data for live Gate discovery, broadcast from Bankr, or claim state was saved.