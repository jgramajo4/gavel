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
 precedents -> prediction -> confidence -> draft reason
                              |
                              v
                    prepare Nouns vote transaction
                              |
                              v
                 adapter injects builder clientId 38
```

Client ID `38` is builder-side attribution plumbing. It is automatically added
to eligible Nouns transactions and is not a voter preference or voter-facing
rewards feature. Reward maintenance and withdrawals remain admin-only.

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

## Privacy

Historical votes are public, but the normalized record and all future derived
profiles are private by default. Do not commit `data/private/`. Gavel never mixes
one voter's model with another voter.

## Current boundaries

- The ingestion adapter trusts the subgraph for discovery and rich proposal
  metadata. Direct onchain verification will be added before transaction
  preparation ships.
- Proposal content is stored as untrusted evidence. It is never interpreted as
  Gavel instructions.
- Confidence is an exposed Phase 4 heuristic, not yet an empirically calibrated
  probability. Chronological calibration is the next backtesting phase.
- Prediction does not yet decode arbitrary calldata, prepare votes, or broadcast
  transactions.

## Legacy Nouns tools

The original Bankr skill remains in [`nouns-dao/`](nouns-dao/README.md). Those
scripts are being retained while their reusable chain interactions move behind
the Nouns adapter. Direct-broadcast scripts are not the intended default Gavel
user experience.
