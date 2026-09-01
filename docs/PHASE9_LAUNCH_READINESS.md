# Phase 9 launch readiness

This checklist is evidence-based. An unchecked gate is not satisfied by unit-test
coverage or by the presence of an implementation.

## Model

- [x] Frozen expanding-window protocol reproduced with strictly earlier blocks.
- [x] Current Nouncil snapshot evaluated: 763 votes, 25-vote warm-up, 738 predictions.
- [ ] Predictor beats the majority-class baseline.
- [ ] Minority-class behavior is launch-quality.

```bash
node bin/gavel.js history 0xcC2688350d29623E2A0844Cc8885F9050F0f6Ed5 --page-size 100
node bin/gavel.js backtest data/private/nouns/0xcc2688350d29623e2a0844cc8885f9050f0f6ed5.json
```

Current result (2026-09-01, subgraph block 25883998):

| Metric | Result |
| --- | ---: |
| Accuracy | 63.69% |
| Majority `FOR` baseline | 64.36% |
| Lift | -0.68 pp |
| Balanced accuracy | 38.44% |
| `FOR` recall | 90.74% |
| `AGAINST` recall | 22.56% |
| `ABSTAIN` recall | 2.02% |
| Raw Brier score | 0.2411 |
| Online-calibrated Brier score | 0.2289 |

The result is consistent with the pinned 761-vote Phase 5 report. A class-weight
search was selected using only 2022–2024 chronological records and evaluated once
on 2025–2026. No candidate both beat the development majority baseline and
materially improved both minority recalls. The best balanced candidate traded
accuracy down to 56.10% in development and 53.04% in validation, so no model
change was shipped. This is one voter and the private full report is gitignored.

## Vote preparation and freshness

- [x] Unit positive path returns unsigned calldata only.
- [x] Unit blocked paths cover inactive, duplicate, zero-power, action drift,
  missing confirmation, security review, stale prose, unavailable event history,
  and simulation failure.
- [x] Canonical version is reconstructed from `ProposalCreated`,
  `ProposalUpdated`, `ProposalTransactionsUpdated`, and
  `ProposalDescriptionUpdated` events emitted by the Nouns DAO proxy.
- [x] Description-only drift blocks preparation.
- [ ] A `READY_TO_SIGN` path has been executed against a pinned mainnet fork.

```bash
MAINNET_FORK_RPC_URL=http://127.0.0.1:8545 \
GAVEL_FORK_PREDICTION=/private/prediction.json \
GAVEL_FORK_PROPOSAL=/private/proposal.json \
GAVEL_FORK_VOTING_ADDRESS=0xEligibleDelegate \
node --test test/mainnet-fork.test.js
```

The test is skipped unless all required variables are present. This environment
had no mainnet-fork RPC, so the unchecked gate remains a launch blocker.

## Bankr

- [ ] Installation in the actual Bankr runtime.
- [ ] State persistence across runtime restart.
- [ ] Proposal/recommendation/correction journey in Bankr.
- [ ] Delegated wallet and wallet-approval handoff in Bankr.

No Bankr runtime or credential was available. Repository skill tests are not
represented as runtime proof.

## New voter

- [x] Eight-question fixed questionnaire with `FOR`, `AGAINST`, `ABSTAIN`,
  `DEPENDS`, and `SKIP`.
- [x] Answers persist under the private policy directory.
- [x] Each answer has timestamped `ONBOARDING_QUESTIONNAIRE` provenance.
- [x] Answers enter the stated-preference layer, preserving
  `hard rule > newest applicable stated preference > observed behavior`.

```bash
node bin/gavel.js onboard 0xVoter --questions
node bin/gavel.js onboard 0xVoter --answers examples/onboarding-answers.json
```

## Operations and privacy

- [x] Failures are categorized by stage as retryable infrastructure, stale data,
  safety block, user correction, unsupported input, or software defect.
- [x] `GAVEL_STRUCTURED_ERRORS=1` emits machine-readable failure events.
- [x] Likely URL secrets and long transaction/key material are redacted.
- [x] Private state remains under gitignored `data/private/`.

## Conservative readiness assessment

| Readiness level | Result | Reason |
| --- | --- | --- |
| Controlled demo | **YES** | Review-first paths and fail-closed unit evidence pass. |
| Supervised public V1 | **NO** | Model, mainnet-fork positive path, and real Bankr E2E gates remain open. |
| Autonomous voting | **NO** | Out of scope; Gavel never signs or broadcasts. |
