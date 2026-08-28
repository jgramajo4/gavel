# Nouncil chronological backtest

Gavel Phase 5 was run against the pinned 761-vote Nouncil history. With the
default 25-vote warm-up, the report contains 736 leakage-free expanding-window
predictions spanning 2022–2026.

The complete report and calibration model remain private and excluded from git.
These aggregates are published so the model's current weaknesses are explicit.

## Headline result

```json
{
  "predictions": 736,
  "correct": 469,
  "accuracy": 0.6372,
  "majorityClass": "FOR",
  "majorityClassAccuracy": 0.6440,
  "accuracyLiftOverMajority": -0.0068,
  "balancedAccuracy": 0.3844,
  "rawBrierScore": 0.2409,
  "onlineCalibratedBrierScore": 0.2288,
  "rawExpectedCalibrationError": 0.1179
}
```

The current predictor does **not** beat the majority-`FOR` baseline overall. It
is not ready for a product accuracy claim or autonomous voting. Online
calibration does improve correctness-confidence Brier score, but calibration
cannot repair poor class discrimination.

## Class performance

| Actual vote | Count | Recall | Predicted count | Precision |
| --- | ---: | ---: | ---: | ---: |
| `FOR` | 474 | 90.7% | 647 | 66.5% |
| `AGAINST` | 164 | 22.6% | 76 | 48.7% |
| `ABSTAIN` | 98 | 2.0% | 13 | 15.4% |

The model strongly overpredicts `FOR`. `ABSTAIN_CONFUSION` appears in 107 of 267
incorrect predictions, and `LOW_SCORE_MARGIN` appears in 43. These categories
overlap.

## Calibration

Three confidence buckets meet the default 20-sample minimum:

| Raw bucket | Samples | Mean raw | Accuracy | Recommended future confidence |
| --- | ---: | ---: | ---: | ---: |
| 60–70% | 125 | 66.8% | 56.0% | 56.8% |
| 70–80% | 444 | 75.1% | 61.0% | 61.3% |
| 80–90% | 166 | 82.9% | 76.5% | 76.9% |

The 90–100% bucket contains only one prediction and is deliberately ineligible.
Applying the saved model to the Phase 4 example lowered its displayed confidence
from roughly 62% raw to 57% calibrated, using 125 predictions in the selected
bucket.

## Accuracy over time

| Year | Predictions | Accuracy |
| --- | ---: | ---: |
| 2022 | 111 | 90.1% |
| 2023 | 193 | 53.4% |
| 2024 | 204 | 60.3% |
| 2025 | 159 | 61.6% |
| 2026 | 69 | 65.2% |

The large temporal variation reinforces that a single aggregate metric is not a
stable product guarantee.

## Product conclusion

Phase 5 succeeds as evaluation infrastructure and falsifies an overly optimistic
reading of the single Phase 4 holdout. Before claiming useful personalized vote
accuracy, model work should:

1. improve `AGAINST` and `ABSTAIN` discrimination without tuning and evaluating
   on the same holdouts;
2. compare against majority, recency-only, and category-majority baselines;
3. validate on additional voters;
4. reserve later periods or separate voters as untouched validation data;
5. recalibrate only after the underlying predictor is improved.

Proposal-security work can proceed independently, but autonomous voting should
remain disabled.
