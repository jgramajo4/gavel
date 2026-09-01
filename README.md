# Gavel

Gavel is a private, history-first governance copilot. It learns how a voter has
actually governed, finds relevant precedents in their own record, recommends
`FOR`, `AGAINST`, or `ABSTAIN` on new proposals, explains the recommendation,
and can prepare a vote transaction for review.

Nouns is the first DAO adapter and Bankr is the first agent runtime. The core
history, profile, rules, prediction, confidence, voice, and backtesting layers
are designed to remain independent of both.

```text
Nouns API / chain
       |
       v
  Nouns adapter -----> normalized private history
                              |
                              v
 observed behavior + stated preferences + hard rules
                              |
                              v
 precedents -> prediction -> confidence -> proposal security -> draft reason
                              |
                              v
                    prepare Nouns vote transaction
                              |
                              v
                 adapter injects builder clientId 38
```


## Status

The existing `nouns-dao/` Bankr skill contains working Nouns transaction tools.
The new `src/` tree is the beginning of the Gavel intelligence layer. It ingests
and normalizes a voter's Nouns history, then builds a private three-layer voter
profile with recency-weighted observed behavior, timestamped stated preferences,
and deterministic hard rules.

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
`data/private/nouns/<address>.json`. That directory is gitignored. To choose a
different destination:

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
canonical contracts, exact proposal actions and voting window, active state,
duplicate-vote status, snapshot voting power, security review, and transaction
simulation. A failed gate returns `BLOCKED` with no transaction. A passing gate
returns unsigned calldata for a separate wallet approval flow; it never signs or
broadcasts. See [`docs/PREPARE_VOTE.md`](docs/PREPARE_VOTE.md).

For a separate delegated voting wallet, add `--from 0xVotingAddress`. Gavel
keeps the modeled historical voter distinct from the address whose receipt,
snapshot power, simulation, and unsigned transaction are checked.

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
- Gavel produces unsigned vote calldata only. Wallet approval, signing,
  broadcasting, and receipt monitoring remain outside the preparation command.

## Legacy Nouns tools

The Bankr entry point in [`nouns-dao/SKILL.md`](nouns-dao/SKILL.md) now routes
natural voter intents through Gavel's personalized onboarding, profile,
proposal-analysis, correction, backtest, daily briefing, vote-review, and
delegation workflows. The older chain scripts remain documented in
[`nouns-dao/README.md`](nouns-dao/README.md) as secondary developer tools while
their reusable interactions move behind the Nouns adapter. Direct-broadcast
scripts are not the default Gavel user experience.
