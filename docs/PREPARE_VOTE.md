# Vote preparation

Phase 8 connects a Gavel prediction to the existing Nouns vote transaction
without giving the recommendation path signing authority. The result is a
private, structured review document containing unsigned calldata only when all
canonical checks pass.

## Command

```bash
npm run gavel -- prepare-vote \
  data/private/predictions/nouns/0xvoter/123.json \
  data/private/proposals/nouns/123.json \
  --support FOR \
  --reason "Confirmed reason"
```

Set `ETHEREUM_RPC_URL` or pass `--rpc`. No private key is read. The selected
support is mandatory and must confirm the prediction. When no `--reason` is
provided, Gavel uses the clearly marked prediction draft if one exists.

The prediction address remains the private model owner. If a distinct delegated
wallet will cast the vote, pass `--from 0xVotingAddress`. Gavel checks that
address's receipt and snapshot voting power, uses it as the unsigned
transaction's `from`, and separately reports the model address's current
delegatee. This avoids confusing the person being modeled with the operational
wallet.

If proposal security reports require human review, inspect the findings first
and then pass `--acknowledge-security-review`. Critical findings cannot be
overridden by that acknowledgement.

## Canonical gates

Before returning a transaction, Gavel verifies:

1. the RPC is Ethereum mainnet;
2. code exists at the canonical Nouns Governor and token addresses;
3. the prediction, normalized proposal, and security report identify the same
   proposal content;
4. canonical proposal ID, voting window, targets, values, signatures, and
   calldata exactly match the inspected input;
5. the proposal is currently Active;
6. the voter has not already voted;
7. the selected voting address had nonzero voting power at the proposal snapshot
   block, with the model address's current delegatee reported separately;
8. the selected support exactly confirms the recommendation;
9. required security review is acknowledged; and
10. `eth_call` and gas estimation succeed from the voter address.

A failed gate produces status `BLOCKED`, explicit blocker codes, and no
transaction. The CLI exits with code 2 after saving the blocked review packet.
RPC failures fail closed.

## Output boundary

`READY_TO_SIGN` means an unsigned call to
`castRefundableVoteWithReason(uint256,uint8,string,uint32)` is ready for the
wallet's separate approval flow. It does not mean the vote has been signed,
submitted, or mined. The fixed Gavel client ID is inserted by the Nouns adapter
as internal attribution plumbing and is not a voter-facing setting.

The older `nouns-dao/scripts/cast_vote.js` command still broadcasts directly and
is retained only as an explicitly confirmed legacy escape hatch.
