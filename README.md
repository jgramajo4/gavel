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
The new `src/` tree is the beginning of the Gavel intelligence layer. The first
implemented vertical slice ingests and normalizes a voter's Nouns history while
preserving onchain reasons, proposal actions, timestamps, weights, outcomes, and
source provenance.

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
- This phase does not yet predict votes, produce calibrated confidence, or
  broadcast transactions.

## Legacy Nouns tools

The original Bankr skill remains in [`nouns-dao/`](nouns-dao/README.md). Those
scripts are being retained while their reusable chain interactions move behind
the Nouns adapter. Direct-broadcast scripts are not the intended default Gavel
user experience.
