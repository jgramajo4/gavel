# Private voter profile

Gavel builds a voter profile from normalized history without changing the
underlying record. The profile has three intentionally separate layers:

1. **Observed behavior** is derived from historical votes and reasons. It is
   evidence, not an editable preference list.
2. **Stated preferences** are timestamped user corrections or current views.
3. **Hard rules** are typed, deterministic constraints. Matching hard rules
   override stated preferences and observed behavior.

The profile is stored under `data/private/profiles/` by default. It contains a
minimal precedent index but does not copy full proposal descriptions or full
vote reasons.

## Build a profile

First ingest history, then build the profile:

```bash
npm run gavel -- history 0xYourVoterAddress
npm run gavel -- profile data/private/nouns/0xyourvoteraddress.json
```

Include user-maintained preference and rule files:

```bash
npm run gavel -- profile data/private/nouns/0xyourvoteraddress.json \
  --preferences examples/stated-preferences.json \
  --rules examples/hard-rules.json
```

Use `--output` to choose a private destination or `--stdout` for machine
integration. By default, `asOf` is the profile build time. `--as-of` creates a
historical point-in-time profile and excludes later votes, preferences, and
rules. That cutoff is required for leakage-free backtesting.

## Recency method

The default half-life is 365 days:

```text
weight = 0.5 ^ (ageDays / halfLifeDays)
```

A vote cast on the profile's `asOf` timestamp has weight `1`. A vote exactly one
half-life old has weight `0.5`; a vote two half-lives old has weight `0.25`.
Override the default with `--half-life-days`. The method, parameter, formula,
cutoff, and source-evidence digest are written into every profile.

## Observed features

The initial deterministic feature layer includes:

- raw and recency-weighted support distributions;
- category-specific support distributions and evidence strength;
- proposal categories such as treasury, recurring funding, public goods,
  governance upgrades, protocol development, marketing, events, and auctions;
- executable-action value and recipient facts;
- a minimal precedent index for the prediction phase;
- reason coverage, typical length, first-person/caveat/question rates, and common
  terms for later draft-reason generation.

Proposal descriptions remain untrusted. Classification performs only
deterministic feature extraction; proposal text cannot create preferences,
rules, or instructions.

## Policy precedence

When a future proposal is evaluated, the policy resolver applies layers in this
order:

```text
matching hard rule > newest matching stated preference > observed behavior
```

Rules may also add review flags or block autonomous execution without forcing a
vote recommendation. Typed rule conditions currently support categories,
treasury-transfer thresholds, recipient addresses, and unconditional policies.

## Current boundary

This phase creates the private evidence and policy model. Similarity scoring,
vote prediction, confidence calibration, and generated draft reasons belong to
the next prediction phase.
