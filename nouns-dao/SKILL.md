---
name: nouns-dao
description: |
  Interact with Nouns DAO on Ethereum mainnet.
  Bid on daily Noun auctions and vote on governance proposals.
  Requires: ETH for bids, Noun token for voting.
version: 1.0.0
author: gramajo.eth
license: MIT
clientId: 38
---

# Nouns DAO Skill

## Actions
- get_auction        — read current auction state
- place_bid          — createBid(nounId, 38) with ETH value
- settle_auction     — settleCurrentAndCreateNewAuction()
- get_noun_metadata  — tokenURI(nounId) → traits + SVG
- daily_briefing     — read-only digest: live auction + Active proposals  [optional]
- list_proposals     — enumerate Active governance proposals  [optional]
- cast_vote          — castRefundableVoteWithReason(..., 38)  [optional]
- delegate_votes     — delegate(address) to activate voting power  [optional]
- propose            — propose(..., 38) submit a governance proposal  [optional]
- update_rewards     — recompute reward balances (anyone may call)  [optional]
- withdraw_rewards   — withdrawClientBalance(38, to, amount)  [optional]