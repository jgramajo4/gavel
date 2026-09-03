---
name: gavel-governance
description: Analyze Nouns governance using private voter profiles.
---

# Gavel governance in Hermes

Use the bundled [Gavel runner](scripts/gavel.js) as the only compatibility
boundary. Do not reimplement profile, prediction, proposal, persistence, Nouns,
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

1. Fetch history and build/load the private profile.
2. Fetch the canonical proposal, then predict and inspect it. Call an
   uncalibrated value a `heuristic score`, never an accuracy probability. If
   `predictionReview.requiresHumanReview` is true, explain why and keep the
   recommendation advisory.
3. Run `prepare-vote` only after the user explicitly reviews the recommendation
   and confirms its support. Pass `--acknowledge-prediction-review` only for
   that confirmed request; treat `BLOCKED` and any nonzero exit as a hard stop.
4. Leave the transaction unsigned unless the user has configured a supported
   executor and authorized the specific execution step.
5. In Safe mode, propose only; a human Safe owner authorizes execution.
6. In WaaP mode, require adapter autonomy approval, policy success, matching
   execution address, voting power, and delegation. Never submit arbitrary
   target/calldata.

Describe `security.summary.riskLevel` as the result of structural calldata
inspection. `CLEAR` means no issue was detected by that limited inspection; it
does not establish economic safety, contract safety, or proposal quality.
Gavel never creates or selects a Safe. The user or operator must configure an
existing Safe execution address.

Read [references/runtime.md](references/runtime.md) when bootstrap fails,
overriding state paths, moving a profile between runtimes, configuring address
roles, or selecting an executor.
