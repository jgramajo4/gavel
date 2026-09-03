# Preferences, hard rules, and corrections

Policy files are private per voter:

```text
/gavel/data/private/nouns/0xlowercaseaddress/preferences.json
/gavel/data/private/nouns/0xlowercaseaddress/rules.json
```

These are Bankr persistent user-file destinations, not paths to edit directly in
the sandbox. Follow `profile-storage.md`: stage existing files into
`gavel-state/`, create the changed policy as a fresh file in `gavel-publish/`,
validate the full array by rebuilding the profile, then publish both the changed
policy and rebuilt profile. Create a missing policy as an empty JSON array before
appending its first entry. Preserve existing entries.

## Preference or correction

Use a stated preference for a current view, a change of mind, writing preference,
or correction that is not deterministic enough to be a hard rule.

1. Restate the interpretation in one sentence if the user's wording is
   ambiguous. Do not ask for confirmation when the mapping is straightforward.
2. Append an entry with a stable ID, the user's statement, the current ISO-8601
   timestamp, `active: true`, relevant categories, and an optional recommendation.
3. To supersede an old preference, retain it but set `active: false`; append the
   new entry. Never delete historical onchain evidence.
4. Rebuild the profile and re-run any proposal the correction concerned.
5. Explain whether the new result changed and which policy entry applied.

Example:

```json
{
  "id": "current-treasury-caution-2026-08-31",
  "statement": "I am now more conservative about treasury spending.",
  "createdAt": "2026-08-31T12:00:00.000Z",
  "active": true,
  "categories": ["TREASURY"],
  "recommendation": "AGAINST"
}
```

Allowed categories are `TREASURY`, `PUBLIC_GOODS`, `RECURRING_FUNDING`,
`RETROACTIVE_FUNDING`, `GOVERNANCE_UPGRADE`, `PROTOCOL_DEVELOPMENT`,
`MARKETING`, `EVENTS`, `EXPERIMENTAL`, `AUCTION`, and `OTHER`.

## Hard rule

Use a hard rule only when the user intends deterministic behavior: "always",
"never", a typed category constraint, a treasury threshold, or a recipient
constraint. Hard rules override preferences and observed behavior when matched.

Supported condition shapes:

```json
{ "type": "always" }
{ "type": "category", "categories": ["GOVERNANCE_UPGRADE"] }
{ "type": "treasury-transfer-above", "thresholdWei": "100000000000000000000" }
{ "type": "recipient", "addresses": ["0x0000000000000000000000000000000000000001"] }
```

Effects may set a recommendation, add a review flag, or block autonomy. At least
one is required:

```json
{
  "id": "governance-upgrade-review",
  "description": "Governance upgrades always require manual review.",
  "createdAt": "2026-08-31T12:00:00.000Z",
  "enabled": true,
  "condition": { "type": "category", "categories": ["GOVERNANCE_UPGRADE"] },
  "effect": {
    "flag": "Governance upgrade requires manual review.",
    "blockAutonomy": true
  }
}
```

If the requested rule cannot be represented by a supported typed condition, save
it as a stated preference and clearly say it is not yet deterministic. Never
pretend free-form text is an enforced execution constraint.

## "Your recommendation was wrong"

Ask what the voter would choose and why only when they did not already say. Record
the response as a timestamped preference/correction, not as an observed vote.
Keep the old prediction and backtest history intact. A correction changes future
policy; it does not retroactively turn a model miss into a correct prediction.
