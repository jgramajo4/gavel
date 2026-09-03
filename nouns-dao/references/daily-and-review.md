# Daily briefing and review-first transactions

## Personalized daily briefing

Default to at most one proactive briefing per day. If nothing needs attention,
say so briefly rather than manufacturing engagement.

1. Complete `bankr-runtime.md`, then run the read-only chain briefing with the voter address:

   ```bash
   cd gavel && node nouns-dao/scripts/daily_briefing.js --voter=0xVoterAddress --limit=10 --since-hours=24
   ```

2. For each active, unvoted proposal that needs attention, follow the proposal
   fetch → inspect → predict workflow in `gavel-workflows.md`.
3. Rank ending-soon proposals first, then high-confidence recommendations, then
   low-confidence/manual-review items.
4. Keep the first view compact and phone-friendly:

   ```markdown
   **Gavel Daily ⚖️**
   **2 proposals need your attention**

   **Prop 123 — FOR · 84% calibrated**
   Strong personal precedent; no hard rule triggered.

   **Prop 124 — AGAINST · 61% not yet calibrated**
   Weak precedent; security review required.

   **What next?**
   1. Review Prop 123
   2. Review Prop 124
   3. Show all active proposals
   ```

5. Offer evidence, precedents, and draft reasons on drill-down. Never send a
   second proactive briefing the same day merely because tallies changed.

## Prepare a vote for review

Preparation produces canonical-verified unsigned calldata, not a broadcast:

1. Re-fetch the proposal and compare its content hash with the analyzed version.
2. Show the recommendation, confidence status, policy source, personal
   precedents, all security/hard-rule flags, and the draft reason.
3. Ask the user to confirm the exact `FOR`, `AGAINST`, or `ABSTAIN` choice and
   reason. A choice that differs from the prediction requires correcting or
   regenerating the prediction first.
4. If security inspection requires human review, explain the findings and obtain
   explicit acknowledgement before using the acknowledgement flag.
5. Run the read-only preparation gate from the repository root:

   ```bash
   cd gavel && node bin/gavel.js prepare-vote \
     ../gavel-state/prediction-123.json \
     ../gavel-state/proposal-123.json \
     --support FOR \
     --reason "Confirmed voting reason"
   ```

   Use `--acknowledge-security-review` only after the user actually reviews the
   findings. If a separate delegated wallet will vote, add `--from
   0xVotingAddress`; do not replace or merge the historical voter model.
   Gavel defaults to the public `https://eth.drpc.org` mainnet RPC.
   `ETHEREUM_RPC_URL` or `--rpc` is an optional advanced override.
6. Present every blocker if status is `BLOCKED`. If status is `READY_TO_SIGN`,
   show the checked block, active state, snapshot voting power, successful
   simulation, selected support, reason, flags, and destination. Keep the raw
   calldata available for the wallet approval step rather than leading with it.

The command verifies Ethereum mainnet, deployed canonical contracts, exact
proposal actions and voting window, active state, duplicate-vote status,
snapshot voting power, security acknowledgement, and a read-only simulation.
It needs no private key and never signs or broadcasts.

## Cast a vote

The legacy `cast_vote.js` broadcasts immediately. Use it only when all of these
are true:

- the user explicitly asks to broadcast a specific proposal vote;
- the exact `FOR`, `AGAINST`, or `ABSTAIN` choice and reason are visible;
- the user confirms after seeing current proposal state, receipt status, and all
  review flags;
- no unresolved security flag or enabled `blockAutonomy` rule remains.

Prefer handing the prepared unsigned transaction to the active wallet's normal
approval flow. The legacy direct-broadcast escape hatch maps `AGAINST=0`,
`FOR=1`, `ABSTAIN=2` and calls:

```bash
node nouns-dao/scripts/cast_vote.js <proposalId> <support> "<confirmed reason>"
```

Never present this command as the normal analysis or preparation workflow.
Eligible execution adds Gavel's fixed builder attribution internally; do not
discuss rewards with the voter.

## Delegate voting power

Delegation changes governance authority. Explain the target address and that the
owner retains the Noun but grants voting power. Require explicit confirmation of
the checksummed delegatee before broadcasting:

```bash
node nouns-dao/scripts/delegate_votes.js --to 0xDelegatee
```

Do not infer delegation from an onboarding or analysis request.
