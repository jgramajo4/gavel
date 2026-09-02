# Gavel

Gavel is a private, history-first governance copilot. It learns how a voter has
actually governed, finds relevant precedents in their own record, recommends
`FOR`, `AGAINST`, or `ABSTAIN` on new proposals, explains the recommendation,
and can prepare a vote transaction for review.

Gavel is one monorepo and one canonical governance engine. Nouns is the first
DAO adapter; Bankr and Hermes are thin runtime integrations. Any compatible
agent or shell can use the same machine-readable `gavel` CLI.

```text
Nouns API / chain
       |
       v
 packages/nouns-adapter -----> normalized private history
                              |
                              v
 observed behavior + stated preferences + hard rules
                              |
                              v
 precedents -> prediction -> confidence -> proposal security -> draft reason
                              |
                              v
                validated governance transaction
                              |
                              v
                 unsigned / Safe / scoped WaaP
```


## Status

The canonical packages are `packages/core`, `packages/nouns-adapter`, and
`packages/cli`. The root `bin/gavel.js` and `nouns-dao/` Bankr skill remain as
verified compatibility entry points. `packages/tui` and `packages/server` are
reserved boundaries; the TUI migration is audited but intentionally non-blocking.

See [`docs/architecture/MONOREPO_AUDIT_AND_PLAN.md`](docs/architecture/MONOREPO_AUDIT_AND_PLAN.md)
for the pre-change audit and staged migration map.

## Requirements

- Node.js 20 or newer
- Network access to the Nouns governance subgraph

```bash
npm install
npm test
```

## Historical vote ingestion

```bash
npm run gavel -- history 0xYourVoterAddress
```

By default, Gavel writes the normalized record under
`data/private/nouns/<address>.json`. Set `GAVEL_DATA_DIR` to let a host runtime
choose a durable private location; no Bankr path is hard-coded in core. To
choose one output file directly:

```bash
npm run gavel -- history 0xYourVoterAddress --output ./history.json
```

Use `--stdout` to emit the complete JSON document without writing a file:

```bash
npm run gavel -- history 0xYourVoterAddress --stdout
```

The default source is `https://www.nouns.camp/subgraphs/nouns`. Override it with
`NOUNS_SUBGRAPH_URL` or `--endpoint`.

## Private voter profile

Build a profile from a normalized history file:

```bash
npm run gavel -- profile data/private/nouns/0xyourvoteraddress.json
```

Gavel defaults to an explicit 365-day exponential half-life and records the
formula and evidence cutoff in the output. Add private, user-maintained policy
inputs with `--preferences <json>` and `--rules <json>`. Example formats live in
[`examples/`](examples/); the full methodology is documented in
[`docs/PROFILE_MODEL.md`](docs/PROFILE_MODEL.md).

Profiles are written to `data/private/profiles/<dao>/<address>.json` unless
`--output` or `--stdout` is supplied. Observed history is never edited by user
corrections. Policy precedence is:

```text
matching hard rule > newest matching stated preference > observed behavior
```

For a new or low-history voter, record the short onboarding questionnaire as
explicit stated preferences, never as learned behavior:

```bash
node bin/gavel.js onboard 0xYourVoterAddress --questions
node bin/gavel.js onboard 0xYourVoterAddress --answers examples/onboarding-answers.json
```

Answers support `DEPENDS` and `SKIP`, preserve optional qualifications, and are
stored with timestamped questionnaire provenance under `data/private/policies/`.

## Current proposal retrieval

Fetch and normalize a current Nouns proposal by ID before inspecting or
predicting it:

```bash
npm run gavel -- proposal 123
```

The default private output is `data/private/proposals/nouns/123.json`. Use
`--stdout`, `--output`, or `--endpoint` with the same semantics as history
ingestion. Proposal prose remains quarantined as untrusted data.

## Proposal prediction

Analyze a normalized proposal using the private profile:

```bash
npm run gavel -- predict \
  data/private/profiles/nouns/0xyourvoteraddress.json \
  examples/normalized-proposal.json
```

The result contains `FOR`, `AGAINST`, or `ABSTAIN`, an explicitly uncalibrated
confidence score, personal historical precedents, evidence-based explanations,
review flags, and a clearly marked draft reason. The full methodology and its
limits are documented in [`docs/PREDICTION_ENGINE.md`](docs/PREDICTION_ENGINE.md).
A leakage-free real-history holdout is recorded in
[`docs/PREDICTION_EXAMPLE.md`](docs/PREDICTION_EXAMPLE.md).

Predictions are private by default and do not prepare, sign, or broadcast votes.

## Review-first vote preparation

After reviewing a prediction, explicitly confirm its support choice and prepare
an unsigned Nouns transaction:

```bash
npm run gavel -- prepare-vote \
  data/private/predictions/nouns/0xyourvoteraddress/123.json \
  data/private/proposals/nouns/123.json \
  --support FOR \
  --reason "Confirmed voting reason"
```

This read-only gate uses `ETHEREUM_RPC_URL` but no private key. It verifies the
canonical contracts, proposal version/description events, exact proposal actions and voting window, active state,
duplicate-vote status, snapshot voting power, security review, and transaction
simulation. A failed gate returns `BLOCKED` with no transaction. A passing gate
returns unsigned calldata for a separate wallet approval flow; it never signs or
broadcasts. See [`docs/PREPARE_VOTE.md`](docs/PREPARE_VOTE.md).

For a separate delegated voting wallet, `--from 0xVotingAddress` remains a
compatibility alias. New integrations should use `--asset-owner` and
`--execution-address`. Gavel keeps `modelAddress`, `assetOwnerAddress`,
`currentDelegateAddress`, `executionAddress`, and `requiredDelegateAddress`
explicit and distinct.

## Execution readiness and delegation

Runtime and wallet are independent choices. Check the selected execution mode
before preparation or submission:

```bash
gavel execution-status --dao nouns --mode safe-supervised --model-address 0xMODEL
gavel execution-status --dao nouns --mode waap-autonomous --model-address 0xMODEL
```

The JSON response reports current/required delegates, voting power,
`redelegationRequired`, and `canVote`. RPC uncertainty fails closed. Prepare an
explicit unsigned delegation change with:

```bash
gavel prepare-delegation --dao nouns --asset-owner-address 0xCOLD --to 0xNEWDELEGATE
```

Safe execution uses a proposer-only client and preserves human approval; no Safe
owner key is required. WaaP execution is available only when the registered DAO
adapter explicitly enables autonomy, the action is allowlisted, delegation and
address roles match, and a policy hook approves the immutable prepared intent.
Live WaaP broadcast is intentionally left to an official deterministic client.
See [`docs/execution/safe.md`](docs/execution/safe.md) and
[`docs/execution/waap.md`](docs/execution/waap.md).

## Proposal security

Inspect a normalized proposal independently of any voter profile:

```bash
npm run gavel -- inspect examples/normalized-proposal.json -- --stdout
```

Gavel quarantines proposal prose as untrusted data, decodes structured Nouns
actions where possible, inspects targets and privileged calls, and flags unknown
or dangerous execution. Conservative mismatch checks compare explicit ETH amount
and recipient claims against decoded actions. Prediction output embeds the same
security report, while keeping security review separate from the personalized
voter recommendation. See [`docs/PROPOSAL_SECURITY.md`](docs/PROPOSAL_SECURITY.md).

## Historical backtesting

Run expanding-window chronological evaluation on a normalized voter history:

```bash
npm run gavel -- backtest data/private/nouns/0xyourvoteraddress.json
```

The report includes overall and class-specific accuracy, confidence buckets,
category/year slices, Brier scores, failure modes, and a minimum-sample-gated
calibration model. Training uses strictly earlier blocks, excludes same-block
votes, and redacts ingestion-time outcomes and tallies. The complete methodology
is documented in [`docs/BACKTESTING.md`](docs/BACKTESTING.md).
The first full Nouncil result—including the finding that the current predictor
does not beat its majority-class baseline—is documented in
[`docs/BACKTEST_EXAMPLE.md`](docs/BACKTEST_EXAMPLE.md).

An eligible model can calibrate a later prediction:

```bash
npm run gavel -- predict profile.json proposal.json --calibration backtest.json
```

## Privacy

Historical votes are public, but the normalized record and all future derived
profiles are private by default. Do not commit `data/private/`. Gavel never mixes
one voter's model with another voter.

## Current boundaries

- The ingestion adapter trusts the subgraph for discovery and rich proposal
  metadata. Vote preparation independently verifies executable actions, voting
  window, state, receipt, and voting power against canonical contracts.
- Proposal content is stored as untrusted evidence. It is never interpreted as
  Gavel instructions. Static action inspection does not replace direct chain
  verification or transaction simulation.
- Raw confidence remains an exposed heuristic. A prediction is marked calibrated
  only when a chronological backtest bucket meets its minimum evidence count.
- Unknown arbitrary calldata is flagged for human review. Preparation requires
  explicit review acknowledgement, and critical findings remain blocked.
- Canonical preparation produces immutable validated calldata. Unsigned mode
  stops there; Safe can propose for human approval, while WaaP remains adapter-
  and policy-scoped.
- The Phase 9 gate status and reproducible evidence are maintained in
  [`docs/PHASE9_LAUNCH_READINESS.md`](docs/PHASE9_LAUNCH_READINESS.md).

Set `GAVEL_STRUCTURED_ERRORS=1` for privacy-scrubbed JSON operational failures.

## Legacy Nouns tools

The Bankr entry point in [`nouns-dao/SKILL.md`](nouns-dao/SKILL.md) now routes
natural voter intents through Gavel's personalized onboarding, profile,
proposal-analysis, correction, backtest, daily briefing, vote-review, and
delegation workflows. The older chain scripts remain documented in
[`nouns-dao/README.md`](nouns-dao/README.md) as secondary developer tools while
their reusable interactions move behind the Nouns adapter. Direct-broadcast
scripts are not the default Gavel user experience.

## License

Gavel is licensed under GPL-3.0. The audited TUI is GPL-3.0-or-later; current
runtime dependencies are permissively licensed and no consolidation conflict
was identified.
