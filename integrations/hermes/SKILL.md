---
name: gavel-governance
description: Analyze Nouns, ENS, and Railgun governance using private voter profiles and prepare review-first transactions where each DAO supports them.
---

# Gavel governance in Hermes

Use the bundled [Gavel runner](scripts/gavel.js) as the only compatibility
boundary. Do not reimplement profile, prediction, proposal, persistence, DAO,
calldata, delegation, or executor logic in Hermes.

On the first Gavel request, run the runner with `--bootstrap-only`. It installs a
pinned, validated Gavel runtime under `HERMES_HOME`, creates a separate private
data directory, and reuses both on later requests. Do not ask the user to clone
the repository, run `npm ci`, use `npm link`, or set a data path for an ordinary
installation. Stop and report the missing prerequisite if Git, npm, or Node.js
20+ is unavailable.

For every Gavel command, invoke this installed skill's `scripts/gavel.js` with
the command arguments. The runner supplies `GAVEL_DATA_DIR`; never print
environment-variable values or bypass the runner with a different checkout.

For an on-demand governance workflow:

1. Select one of `nouns`, `ens`, or `railgun-eth`; keep each DAO's history and
   profile separate. ENS Snapshot and Governor votes are separate venues.
2. Fetch history and build/load the private profile. ENS and Railgun history
   comes from the public governance index with no configuration; Nouns uses its
   subgraph unless `GAVEL_INDEX_API_URL` selects an operator's index. Report a
   stale or failing index as a blocked prerequisite and stop. Do not substitute
   another source, and do not read an empty indexed history as a voter with no
   votes.
3. Fetch the canonical proposal, then predict and inspect it. ENS Governor
   proposals come from the index and are live-verified over RPC. Call an
   uncalibrated value a `heuristic score`, never an accuracy probability. If
   `predictionReview.requiresHumanReview` is true, explain why and keep the
   recommendation advisory.
4. Run `prepare-vote` only after the user explicitly reviews the recommendation
   and confirms its support. Pass `--acknowledge-prediction-review` only for
   that confirmed request; treat `BLOCKED` and any nonzero exit as a hard stop.
5. Leave the transaction unsigned unless the user has configured a supported
   executor and authorized the specific execution step.
6. In Safe mode, propose only; a human Safe owner authorizes execution.
7. In WaaP mode, require adapter autonomy approval, policy success, matching
   execution address, voting power, and delegation. Never submit arbitrary
   target/calldata.

Railgun is binary: refuse `ABSTAIN` and onchain reasons. Let the adapter compute
the staking snapshot hint and default to full remaining voting power unless the
user explicitly chooses `--amount`. Railgun sponsorship is not a vote, and its
per-stake delegation is outside the generic delegation command. ENS vote
preparation targets only the executable Governor venue; do not treat a Snapshot
signature as an ENS Governor transaction.

Describe `security.summary.riskLevel` as the result of structural calldata
inspection. `CLEAR` means no issue was detected by that limited inspection; it
does not establish economic safety, contract safety, or proposal quality.
Gavel never creates or selects a Safe. The user or operator must configure an
existing Safe execution address.

Read [references/runtime.md](references/runtime.md) when bootstrap fails,
overriding state paths, configuring the governance index, moving a profile
between runtimes, configuring address roles, or selecting an executor.
