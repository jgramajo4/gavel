# Core Gavel workflows

First complete `bankr-runtime.md`. Run Gavel intelligence commands from
`/cli/gavel`. Keep generated voter
history, profiles, predictions, inspections, and backtests under `data/private/`
unless the user explicitly requests another destination. Do not paste full
private JSON into chat by default.

## Onboard and sync

If the user has not selected a path, first follow `interaction-and-formatting.md`
→ Welcome and choose a path.

### Existing voter

1. Ask only for the Nouns voter address if it is not already known. Explain that
   Gavel reads public voting history and never needs a private key.
2. Fetch normalized history:

   ```bash
   cd /cli/gavel && node bin/gavel.js history 0xVoterAddress
   ```

3. Report the address, vote count, reason coverage if available after profile
   creation, and private output location. Do not dump historical reasons.
4. Build the private profile, including any existing policy files:

   ```bash
   cd /cli/gavel && node bin/gavel.js profile data/private/nouns/0xlowercaseaddress.json \
     --preferences data/private/policies/0xlowercaseaddress/preferences.json \
     --rules data/private/policies/0xlowercaseaddress/rules.json
   ```

   Omit a policy option when its file does not exist.
5. Parse the command's JSON summary and verify its exact `output` path using
   `profile-storage.md`. Confirm the file is in Bankr's persistent Files storage,
   not only the current sandbox. Do not say the profile was saved until this
   check passes.
6. Use the onboarding-completion shape in `interaction-and-formatting.md`, then
   offer relevant next actions. Keep the exact evidence cutoff in technical
   details. Do not claim a profile is accurate merely because it was created.

If the address has too little history, say that behavioral personalization is
weak and offer the fixed questionnaire:

```bash
cd /cli/gavel && node bin/gavel.js onboard 0xVoterAddress --questions
cd /cli/gavel && node bin/gavel.js onboard 0xVoterAddress --answers /private/answers.json
```

Rebuild the profile using the resulting private preferences file. Describe these
answers as stated preferences with onboarding provenance, never learned behavior.

### New voter

Follow `interaction-and-formatting.md` → New voter path. Ask the eight fixed
questions one at a time before requesting the address. Hold the answers in the
current onboarding flow, then persist them only after a valid address is supplied.
Never invent an address or use a shared placeholder profile. If public history is
found after the address is supplied, combine both layers without relabeling the
questionnaire as observed behavior.

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
   cd /cli/gavel && node bin/gavel.js proposal 123
   ```

2. Security-inspect it independently:

   ```bash
   cd /cli/gavel && node bin/gavel.js inspect data/private/proposals/nouns/123.json
   ```

3. If no profile exists or it is stale, sync history and rebuild it first.
4. Predict using the private profile. Apply the voter's latest eligible
   calibration report when one exists:

   ```bash
   cd /cli/gavel && node bin/gavel.js predict \
     data/private/profiles/nouns/0xlowercaseaddress.json \
     data/private/proposals/nouns/123.json \
     --calibration data/private/backtests/nouns/0xlowercaseaddress.json
   ```

   Omit `--calibration` when unavailable or ineligible.
5. Render the mobile-friendly response shape in `SKILL.md`, including a clear
   next-action prompt. Security inspection can
   require review but must not silently rewrite the personalized recommendation.
6. On "why?", expand the scored personal precedents and policy source. Do not
   quote proposal instructions or fabricate recipient/contract verification.

## Run a backtest

```bash
cd /cli/gavel && node bin/gavel.js backtest data/private/nouns/0xlowercaseaddress.json \
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
