# Gate advocate runtime (Bankr)

This file belongs to the **`gavel-gate` skill package** and is loaded as
`references/runtime.md` from that package's own `SKILL.md`.

It is deliberately self-contained. An installed skill is only its own
directory: a path that climbs out of it (`../../nouns-dao/...`) resolves in a
repository checkout and resolves nowhere once the skill is published, so the
Gate advocate skill reaches for nothing outside this folder. `gavel-gate` and
the general `gavel` voter/copilot skill are separate installs, and neither may
assume the other is present.

## Install inside the current sandbox

Bankr `execute_cli` containers are ephemeral, and arbitrary paths inside them —
`/cli/gavel` included — are not a persistent installation. Run the install and
the requested Gate workflow in the **same** `execute_cli` invocation. Use
`workDir: "workspace"` and never print an environment variable's value.

1. Clone the public runtime:

   ```bash
   git clone --branch main --single-branch https://github.com/jgramajo4/gavel.git gavel
   ```

   For a catalog release, replace `main` with the immutable release tag built
   from the validated commit. Do not silently switch revisions mid-workflow.

2. Confirm the remote before running any code:

   ```bash
   git -C gavel remote get-url origin
   git -C gavel status --short --branch
   ```

   The origin must be exactly `https://github.com/jgramajo4/gavel.git` or its
   GitHub SSH equivalent. Stop on an unexpected remote or a dirty tracked file.

3. Install locked dependencies without touching the lockfile:

   ```bash
   cd gavel && npm ci
   ```

4. Before the first real-money workflow for a release, run the advocate suite:

   ```bash
   cd gavel && npm run test:bankr-gate
   ```

The advocate client is `integrations/bankr/src/`. Require it as
`require("./integrations/bankr/src")` from the repository root.

Re-cloning in a fresh task is expected.

## Network

- The Gate API and the canonical governance index are reached over ordinary
  outbound HTTPS. No tunnel, no shared secret, no private network.
- `GAVEL_GATE_URL` must be the **production Gate API origin**, supplied through
  Bankr's secure Env Vars. Origin only: no path, query, fragment, or
  credentials. The client fails closed on anything else.
- `GAVEL_INDEX_API_URL` is an optional override; unset, the client reads the
  public index at `https://index.0773h.com`. An override must be reachable from
  a Bankr sandbox, which runs outside any operator network — a loopback- or
  LAN-bound index is not. Never put credentials in the URL; the client sends no
  authentication and has no mechanism for one.
- A relayer broadcasts; its credentials live with the relayer, never here.

## Secrets

No private key is required, accepted, or derivable anywhere in this
integration. Never ask for, accept, print, or store a private key, a seed
phrase, an RPC credential, a Gate session token, or a signature. Refer to an
environment variable by name and never echo its value.

## State

This skill produces no durable voter state. The private voter profile paths
used by the general `gavel` skill are not part of the advocate flow, and an
advocate never reads a voter's private Gate inbox.
