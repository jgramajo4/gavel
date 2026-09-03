# Chronological backtesting and confidence calibration

Phase 5 evaluates Gavel exactly as it would have operated through time. It never
uses a random train/test split and never lets a held-out vote, same-block vote,
future vote, final proposal outcome, or future calibration result enter the
current prediction.

```bash
npm run gavel -- backtest data/private/nouns/0xyourvoteraddress.json
```

The concise metrics are printed and the complete private report is stored under
`data/private/backtests/`. Use `--stdout` to emit the full report without writing
a file.

## Expanding-window methodology

Votes are ordered by block and evaluated in block groups:

```text
strictly earlier blocks -> profile -> predict current block -> score result
                                                    |
                                                    v
                                     add current block to future training
```

- The default first holdout requires 25 earlier votes.
- Every vote in the target block is excluded from every other prediction in
  that block because transaction/log ordering is not present in the normalized
  history.
- Final `state`, `outcome`, and vote tallies are replaced with redacted values
  in training records.
- The profile `asOf`, prediction `asOf`, and generated timestamps are pinned to
  the held-out vote timestamp.
- The prediction engine fails if the target proposal appears in profile
  evidence.

The optional preference and hard-rule files are timestamp-filtered at every
holdout. Current preferences should not be retroactively applied unless their
historical creation timestamps are accurate.

## Reported metrics

The report includes:

- overall predictions, correct predictions, and accuracy;
- majority-class baseline, lift over that baseline, and balanced accuracy;
- recall and precision for `FOR`, `AGAINST`, and `ABSTAIN`;
- the complete confusion matrix;
- accuracy by proposal category and calendar year;
- accuracy above the configured high-confidence threshold;
- raw and online-calibrated Brier scores for correctness confidence;
- raw expected calibration error;
- confidence-bucket counts, accuracy, and recommended calibrated values;
- overlapping failure-mode counts with example proposal IDs;
- one compact record per held-out prediction.

Category totals may exceed the overall prediction count because a proposal may
belong to multiple categories.

## Leakage-free online calibration

Each held-out prediction receives an online calibrated score using only scored
predictions from strictly earlier blocks in the same fixed confidence bucket.
The method uses beta-style shrinkage toward the raw score:

```text
onlineConfidence =
  (earlierCorrect + priorStrength × rawConfidence)
  / (earlierCount + priorStrength)
```

The default prior strength is 10. Online-calibrated Brier score is therefore an
honest out-of-sample metric rather than an in-sample fit.

## Future-use calibration model

After evaluation, Gavel builds a six-bin model from all holdouts. This model is
for later predictions, not for rescoring the report that trained it. Each bin
records:

- sample count and correct count;
- mean raw confidence and empirical accuracy;
- a shrinkage-adjusted recommended confidence;
- whether the bin meets the default 20-sample minimum.

Apply an eligible model to a new prediction:

```bash
npm run gavel -- predict profile.json proposal.json \
  --calibration data/private/backtests/nouns/0xyourvoteraddress.json
```

Pass the complete backtest report, not only its nested calibration model, when
you want the prediction to carry the report's majority-baseline comparison in
`predictionReview`. Calibration only changes how an eligible score bucket is
interpreted. It does not authorize an observed-behavior recommendation for
autonomous execution.

If the selected bucket lacks the minimum sample count, Gavel leaves the raw
confidence unchanged and reports why calibration was not applied. Applied
outputs preserve `rawConfidence`, set `confidenceCalibrated: true`, include the
model ID and evidence count, and remove the old uncalibrated warning.

## Reading failure modes

Failure categories are diagnostic and may overlap:

- `NO_RELEVANT_PRECEDENT`
- `LOW_SCORE_MARGIN`
- `WEAK_PRECEDENT_SIMILARITY`
- `ABSTAIN_CONFUSION`
- `HIGH_CONFIDENCE_ERROR`

They indicate where the model needs improvement; they are not excuses to hide
incorrect predictions.

## Limitations

- One voter report measures that voter, not all Nouns voters.
- Fixed buckets can be noisy in sparse classes, especially `ABSTAIN`.
- A calibration model becomes stale as voter behavior and proposal mix change.
- Full multi-voter evaluation and model-version comparison should be added
  before claiming general product accuracy.
- No live transaction is prepared or broadcast by backtesting.
