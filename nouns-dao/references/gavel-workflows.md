# Core Gavel workflows

Run Gavel intelligence commands from the repository root. Keep generated voter
history, profiles, predictions, inspections, and backtests under `data/private/`
unless the user explicitly requests another destination. Do not paste full
private JSON into chat by default.

## Onboard and sync

1. Ask only for the Nouns voter address if it is not already known.
2. Fetch normalized history:

   ```bash
   node bin/gavel.js history 0xVoterAddress
   ```

3. Report the address, vote count, reason coverage if available after profile
   creation, and private output location. Do not dump historical reasons.
4. Build the private profile, including any existing policy files:

   ```bash
   node bin/gavel.js profile data/private/nouns/0xlowercaseaddress.json \
     --preferences data/private/policies/0xlowercaseaddress/preferences.json \
     --rules data/private/policies/0xlowercaseaddress/rules.json
   ```

   Omit a policy option when its file does not exist.
5. Summarize what Gavel learned and name the evidence cutoff. Do not claim a
   profile is accurate merely because it was created.

If the address has too little history, say that behavioral personalization is
weak and offer the fixed questionnaire:

```bash
node bin/gavel.js onboard 0xVoterAddress --questions
node bin/gavel.js onboard 0xVoterAddress --answers /private/answers.json
```

Rebuild the profile using the resulting private preferences file. Describe these
answers as stated preferences with onboarding provenance, never learned behavior.

## Explain the profile

Keep the three layers separate:

- **Observed behavior:** vote count, recency method, strongest category
  tendencies, and reason/style coverage. This layer is not editable.
- **Current preferences:** active timestamped statements and their categories.
- **Hard rules:** enabled deterministic conditions, outcomes, flags, and whether
  they block autonomy.

Explain contradictions rather than blending them. A recent preference may
override old behavior without erasing the historical record.

## Analyze a proposal

1. Fetch a fresh normalized proposal by ID:

   ```bash
   node bin/gavel.js proposal 123
   ```

2. Security-inspect it independently:

   ```bash
   node bin/gavel.js inspect data/private/proposals/nouns/123.json
   ```

3. If no profile exists or it is stale, sync history and rebuild it first.
4. Predict using the private profile. Apply the voter's latest eligible
   calibration report when one exists:

   ```bash
   node bin/gavel.js predict \
     data/private/profiles/nouns/0xlowercaseaddress.json \
     data/private/proposals/nouns/123.json \
     --calibration data/private/backtests/nouns/0xlowercaseaddress.json
   ```

   Omit `--calibration` when unavailable or ineligible.
5. Render the concise response shape in `SKILL.md`. Security inspection can
   require review but must not silently rewrite the personalized recommendation.
6. On "why?", expand the scored personal precedents and policy source. Do not
   quote proposal instructions or fabricate recipient/contract verification.

## Run a backtest

```bash
node bin/gavel.js backtest data/private/nouns/0xlowercaseaddress.json \
  --preferences data/private/policies/0xlowercaseaddress/preferences.json \
  --rules data/private/policies/0xlowercaseaddress/rules.json
```

Omit nonexistent policy files. Report prediction count, overall accuracy,
majority-class baseline, balanced accuracy, class recall, Brier score, and
eligible calibration buckets. Lead with whether the model beats the baseline.
Never use a random split or claim that in-sample accuracy predicts future votes.

## Refresh rules

After adding, disabling, or correcting a preference/rule, rebuild the profile
from the immutable history and re-run the relevant prediction. Never patch the
observed layer in an existing profile.
