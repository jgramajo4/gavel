# Prediction engine

Phase 4 turns a private voter profile and a normalized proposal into a
structured `FOR`, `AGAINST`, or `ABSTAIN` recommendation. The output includes
personal precedents, explicit evidence scores, explanations, flags, a
first-class review decision, and a clearly marked draft reason.

```bash
npm run gavel -- predict \
  data/private/profiles/nouns/0xyourvoteraddress.json \
  examples/normalized-proposal.json
```

The concise result is printed and the complete prediction is stored privately
under `data/private/predictions/`. Use `--stdout` for the complete JSON without
writing a file.

After a chronological backtest produces an eligible calibration model, apply it
with `--calibration <backtest.json>`. Gavel preserves the raw confidence and
only marks the result calibrated when the selected bucket meets the configured
minimum sample count. See [`BACKTESTING.md`](BACKTESTING.md).

## Precedent similarity

Similarity is structural and deterministic. It is not based only on keywords.
The initial score combines:

| Signal | Weight | Meaning |
| --- | ---: | --- |
| Proposal categories | 45% | Overlap in treasury, public goods, governance, marketing, and other typed categories |
| Executable ETH value | 25% | Distance between total native-value actions on a logarithmic scale |
| Recipient addresses | 20% | Overlap among executable action targets, when present |
| Title tokens | 10% | Small lexical signal from untrusted proposal titles |

Recency is intentionally separate from structural similarity. A precedent's
evidence weight is:

```text
evidenceWeight = similarity × (0.35 + 0.65 × recencyWeight)
```

This lets old but highly relevant votes remain visible while giving recent
behavior substantially more influence. Gavel fails closed if the target
proposal is already present in profile evidence because aggregate profile
features could otherwise leak the known vote. Backtests must rebuild a profile
with an `asOf` cutoff before each target vote.

## Recommendation

Gavel combines a small deterministic prior with the voter's overall weighted
support distribution, matching category behavior, and the strongest personal
precedents. `ABSTAIN` is discounted unless matching history establishes a real
abstention pattern. Low confidence therefore produces a best prediction rather
than automatically becoming `ABSTAIN`.

After the observed recommendation is computed, policy layers apply in order:

```text
matching hard rule > newest matching stated preference > observed behavior
```

## Score labeling and review

Uncalibrated confidence is explicitly labeled `confidenceKind:
"HEURISTIC_SCORE"` and `confidenceCalibrated: false`. It is a bounded
heuristic for Phase 4, not an LLM self-assessment and not yet an empirical
probability until a qualifying Phase 5 calibration model is applied. The raw
output exposes these normalized components:

- margin between the top two support scores;
- average similarity of the strongest precedents;
- quantity of weighted precedent evidence;
- recency of that evidence;
- total history depth;
- whether an explicit preference or deterministic hard rule overrides history.

The observed-behavior formula is:

```text
0.34
+ 0.22 × margin
+ 0.16 × similarity
+ 0.14 × sufficiency
+ 0.10 × recency
+ 0.04 × historyDepth
```

Matching hard-rule decisions are deterministic and report confidence `1` in
the configured policy outcome. Matching stated preferences have a minimum
heuristic confidence of `0.85`. Phase 5 chronological backtesting must measure
accuracy by confidence bucket and replace or calibrate these raw values.

Observed-behavior recommendations are currently advisory even when a bucket is
calibrated. Their `predictionReview` requires human review and sets
`autonomyAllowed: false`. When the complete chronological backtest report is
passed to `--calibration`, the prediction records accuracy, majority-baseline
accuracy, lift, balanced accuracy, and report identity. A result that does not
beat its majority baseline is flagged explicitly. Calibration changes score
interpretation; it does not silently promote the predictor into autonomous use.

## Draft reasons

Draft reasons are deterministic templates shaped by the profile's historical
reason length, first-person usage, and caveat rate. They never copy full old
reasons, never include proposal instructions, and are always returned with
`isDraft: true`. Gavel declines to draft in a personalized style when fewer than
three historical reasons and no stated preferences are available.

## Safety and current limits

- Proposal prose is untrusted feature input and cannot become Gavel policy or
  appear verbatim in explanations or draft reasons.
- Phase 6 security output is embedded under `security`. Structured actions are
  decoded where possible; injection suspicion, privileged calls, unknown
  calldata, and conservative prose/action contradictions require human review.
  See [`PROPOSAL_SECURITY.md`](PROPOSAL_SECURITY.md).
- Category extraction is deterministic and intentionally conservative.
- Confidence remains a heuristic score until an eligible chronological
  backtest bucket is applied, and observed-behavior output remains advisory.
- This phase recommends only. It does not prepare, sign, or broadcast a vote.
