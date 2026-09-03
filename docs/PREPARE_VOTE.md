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

Gavel uses `https://eth.drpc.org` by default. Advanced users may set
`ETHEREUM_RPC_URL` or pass `--rpc` for a dedicated provider. No private key is
read. The selected support is mandatory and must confirm the prediction. When
no `--reason` is provided, Gavel uses the clearly marked prediction draft if one
exists. A dedicated provider may be needed if the public endpoint limits the
historical log range required for proposal-freshness verification.

The prediction address remains `modelAddress`. If the token owner and voting
address differ, pass `--asset-owner 0xColdAddress` and
`--execution-address 0xVotingAddress`; `--from` remains a compatibility alias
for the latter. Gavel checks the execution address's receipt and snapshot power,
the asset owner's current delegate, and reports all address roles explicitly.

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
5. canonical creation and update events reconstruct the same latest proposal
   description/version as the inspected input;
6. the proposal is currently Active;
7. the voter has not already voted;
8. the execution address had nonzero voting power at the proposal snapshot
   block and the asset owner delegates to that required execution address;
9. the selected support exactly confirms the recommendation;
10. required security review is acknowledged; and
11. `eth_call` and gas estimation succeed from the voter address.

A failed gate produces status `BLOCKED`, explicit blocker codes, and no
transaction. The CLI exits with code 2 after saving the blocked review packet.
RPC failures fail closed.

Freshness is derived from canonical `ProposalCreated`, `ProposalUpdated`,
`ProposalTransactionsUpdated`, and `ProposalDescriptionUpdated` logs at the DAO
proxy. The subgraph is not authoritative for this safety gate. Missing log access
and description-only drift both fail closed.

## Output boundary

`READY_TO_SIGN` means an unsigned call to
`castRefundableVoteWithReason(uint256,uint8,string,uint32)` is ready for the
wallet's separate approval flow. It does not mean the vote has been signed,
submitted, or mined. The fixed Gavel client ID is inserted by the Nouns adapter
as internal attribution plumbing and is not a voter-facing setting.

The older `nouns-dao/scripts/cast_vote.js` command still broadcasts directly and
is retained only as an explicitly confirmed legacy escape hatch.
