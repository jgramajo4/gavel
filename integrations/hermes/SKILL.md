---
name: gavel-governance
description: Use the canonical Gavel CLI from Hermes to analyze DAO governance, build private voter profiles, predict votes, and prepare or supervise explicitly supported governance actions. Do not use for trading, arbitrary wallet operations, or unsupported DAOs.
---

# Gavel governance in Hermes

Use the installed `gavel` executable as the only Gavel compatibility boundary.
Do not reimplement profile, prediction, proposal, persistence, Nouns, calldata,
delegation, or executor logic in Hermes.

Before a workflow, run `npm run health-check --workspace @gavel/integration-hermes`
or `gavel --help`. Set `GAVEL_DATA_DIR` to a persistent private Hermes workspace
and never print environment-variable values.

For an on-demand governance workflow:

1. Fetch history and build/load the private profile.
2. Fetch the canonical proposal, then predict and inspect it.
3. Run `prepare-vote`; treat `BLOCKED` and any nonzero exit as a hard stop.
4. Leave the transaction unsigned unless the user has configured a supported
   executor and authorized the specific execution step.
5. In Safe mode, propose only; a human Safe owner authorizes execution.
6. In WaaP mode, require adapter autonomy approval, policy success, matching
   execution address, voting power, and delegation. Never submit arbitrary
   target/calldata.

Read [references/runtime.md](references/runtime.md) when installing, choosing
state paths, configuring address roles, or selecting an executor.
