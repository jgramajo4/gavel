# Leakage-free prediction example

Phase 4 was validated against the pinned Nouncil history used for ingestion and
profile development. This is one chronological holdout, not an accuracy claim
or a substitute for Phase 5 backtesting.

For the final vote in the 761-vote record, Gavel rebuilt the profile with an
`asOf` cutoff one millisecond before the target vote. The target proposal and
vote were therefore absent from all 760 training votes and aggregate profile
features.

```json
{
  "targetProposalId": "988",
  "actualVote": "FOR",
  "trainingVotes": 760,
  "recommendation": "FOR",
  "confidencePercent": 81,
  "confidenceCalibrated": false,
  "matched": true,
  "policySource": "OBSERVED_BEHAVIOR",
  "precedents": [
    { "proposalId": "957", "vote": "FOR", "similarity": 0.7071 },
    { "proposalId": "971", "vote": "FOR", "similarity": 0.6750 },
    { "proposalId": "930", "vote": "FOR", "similarity": 0.7000 },
    { "proposalId": "964", "vote": "FOR", "similarity": 0.6300 },
    { "proposalId": "929", "vote": "FOR", "similarity": 0.6750 }
  ]
}
```

The complete 761-vote history, generated profile, and prediction remain private
and excluded from git. Phase 5 must repeat this process across chronological
holdouts and report accuracy, class-specific metrics, confidence buckets, and
known failure modes.
