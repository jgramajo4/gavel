# Daily briefing and review-first transactions

## Personalized daily briefing

Default to at most one proactive briefing per day. If nothing needs attention,
say so briefly rather than manufacturing engagement.

1. Run the read-only chain briefing with the voter address:

   ```bash
   node nouns-dao/scripts/daily_briefing.js --voter=0xVoterAddress --limit=10 --since-hours=24
   ```

2. For each active, unvoted proposal that needs attention, follow the proposal
   fetch → inspect → predict workflow in `gavel-workflows.md`.
3. Rank ending-soon proposals first, then high-confidence recommendations, then
   low-confidence/manual-review items.
4. Keep the first view compact:

   ```text
   Gavel Daily
   2 proposals need attention.

   Prop 123 — FOR · 84% calibrated
   Strong personal precedent; no hard rule triggered.

   Prop 124 — AGAINST · 61% raw
   Weak precedent; security review required.
   ```

5. Offer evidence, precedents, and draft reasons on drill-down. Never send a
   second proactive briefing the same day merely because tallies changed.

## Prepare a vote for review

Preparation is a review packet, not a broadcast:

1. Re-fetch the proposal and compare its content hash with the analyzed version.
2. Confirm the proposal appears active, and use `getReceipt` through the legacy
   tools to check that the signing wallet has not voted.
3. Show the recommendation, confidence status, policy source, personal
   precedents, all security/hard-rule flags, and the draft reason.
4. State that direct canonical chain verification and transaction preparation
   are completed in Phase 8. Until that gate exists, stop at the review packet;
   do not claim a transaction is ready to sign.

## Cast a vote

The legacy `cast_vote.js` broadcasts immediately. Use it only when all of these
are true:

- the user explicitly asks to broadcast a specific proposal vote;
- the exact `FOR`, `AGAINST`, or `ABSTAIN` choice and reason are visible;
- the user confirms after seeing current proposal state, receipt status, and all
  review flags;
- no unresolved security flag or enabled `blockAutonomy` rule remains.

Then map `AGAINST=0`, `FOR=1`, `ABSTAIN=2` and call:

```bash
node nouns-dao/scripts/cast_vote.js <proposalId> <support> "<confirmed reason>"
```

Never present this command as the normal analysis workflow. Eligible execution
adds Gavel's fixed builder attribution internally; do not discuss rewards with
the voter.

## Delegate voting power

Delegation changes governance authority. Explain the target address and that the
owner retains the Noun but grants voting power. Require explicit confirmation of
the checksummed delegatee before broadcasting:

```bash
node nouns-dao/scripts/delegate_votes.js --to 0xDelegatee
```

Do not infer delegation from an onboarding or analysis request.
