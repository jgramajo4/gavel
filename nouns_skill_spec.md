# Bankr Skill Technical Specification
## Nouns DAO — Auction & Governance
**Version 1.0 | skills.bankr.bot**

---

## 1. Overview

This document defines the technical specification for a Bankr Skill that gives agents the ability to participate in Nouns DAO on Ethereum mainnet. The skill is scoped to two capability areas: auction participation (bidding on Nouns) and governance participation (voting on proposals). Auction support is the required minimum; governance is a recommended extension.

### 1.1 Skill Identity

| Field | Value |
|-------|-------|
| Skill Name | `nouns-dao` |
| Platform | skills.bankr.bot |
| Network | Ethereum Mainnet (chainId: 1) |
| Skill File | SKILL.md (required) + scripts/ |
| Repo Structure | nouns-dao/ per bankr convention |

### 1.2 Contracts in Scope

| Contract | Address |
|----------|---------|
| Auction House Proxy | `0x830BD73E4184ceF73443C15111a1DF14e495C706` |
| Auction Implementation | `0x1D835808ddca38fbe14e560d8e25b3d256810aF0` |
| Governance Proxy | `0x6f3E6272A167e8AcCb32072d08E0957F9c79223d` |
| Nouns Token (ERC-721) | `0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03` |

---

## 2. Skill Actions

| Skill Action | Priority | Notes |
|--------------|----------|-------|
| Get Current Auction | **Required** | Fetch live auction state: Noun ID, current bid, end time, bidder |
| Place Bid | **Required** | Submit ETH bid via `createBid()`; enforce min increment + reserve price |
| Settle Auction | **Required** | Call `settleCurrentAndCreateNewAuction()` once auction clock has expired |
| Get Noun Metadata | **Required** | Resolve on-chain SVG image, traits, and seed for a given Noun ID |
| Daily Briefing | Optional | Read-only digest composing live auction state, Active proposals, and recent on-chain changes (bids, settlements, new proposals, votes from event logs) into one morning summary. Signs nothing |
| List Active Proposals | Optional | Fetch all proposals in Active state from governance contract |
| Get Proposal Detail | Optional | Return full proposal data: description, vote counts, state, calldata |
| Cast Vote | Optional | Call `castRefundableVoteWithReason(proposalId, support, reason, clientId)` |
| Get Vote Receipt | Optional | Check if agent wallet has already voted on a given proposal |
| Delegate Votes | Optional | Call `delegate(address)` on the Nouns Token to assign voting power |

---

## 3. Contract Interfaces

### 3.1 Auction House — Key Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `auction()` | `view → Auction` | Returns the current auction struct |
| `createBid()` | `createBid(nounId, clientId) payable` | Place a bid. msg.value must be ≥ reservePrice AND ≥ lastBid × (1 + minBidIncrementPercentage/100) |
| `settleCurrentAndCreateNewAuction()` | `nonReentrant, whenNotPaused` | Settles finished auction and starts the next one atomically |
| `settleAuction()` | `whenPaused, nonReentrant` | Settles auction only (used when contract is paused) |
| `reservePrice()` | `view → uint256` | Minimum opening bid in wei |
| `minBidIncrementPercentage()` | `view → uint8` | % each new bid must exceed the last (currently 2%) |
| `duration()` | `view → uint256` | Auction duration in seconds (86400 = 24h) |
| `timeBuffer()` | `view → uint256` | Seconds added to endTime on late bid (currently 600) |

#### Auction Struct

```solidity
struct Auction {
  uint256 nounId;      // Token ID being auctioned
  uint256 amount;      // Current highest bid (wei)
  uint256 startTime;   // Unix timestamp auction opened
  uint256 endTime;     // Unix timestamp auction closes (may extend)
  address bidder;      // Current highest bidder (address(0) if no bids)
  bool    settled;     // True once auction is finalized
}
```

#### Key Events

| Event | Parameters | Description |
|-------|-----------|-------------|
| `AuctionBid` | `nounId, sender, value, extended` | Fires on every new bid. extended=true if endTime was pushed |
| `AuctionCreated` | `nounId, startTime, endTime` | Fires when a new 24-hour auction begins |
| `AuctionSettled` | `nounId, winner, amount` | Fires on settlement; winner is address(0) if no bids (Noun burned) |
| `AuctionExtended` | `nounId, endTime` | Fires when a last-minute bid extends the auction clock |

---

### 3.2 Governance — Key Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `state()` | `state(proposalId) view → ProposalState` | 0=Pending, 1=Active, 2=Canceled, 3=Defeated, 4=Succeeded, 5=Queued, 6=Expired, 7=Executed |
| `proposals()` | `proposals(proposalId) view → Proposal` | Full proposal including for/against/abstain counts |
| `castRefundableVoteWithReason()` | `(proposalId, support, reason, clientId)` | Cast vote with reason + clientId attribution. Gas refunded by DAO |
| `castRefundableVote()` | `(proposalId, support, clientId)` | Cast vote with clientId, no reason string |
| `getReceipt()` | `getReceipt(proposalId, voter) view → Receipt` | Check if address has voted and their position |
| `propose()` | `(targets, values, sigs, calldatas, description, clientId)` | Submit a proposal with client attribution |
| `quorumVotes()` | `view → uint256` | Dynamic quorum (% of total supply) |
| `proposalCount()` | `view → uint256` | Total proposals ever created |

**Proposal State Machine:**
```
Pending → Active → Succeeded / Defeated → Queued → Executed
                ↘ Canceled / Expired
```
> Only call `castRefundableVoteWithReason()` when `state == 1` (Active).

---

### 3.3 Nouns Token — Relevant Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `delegate()` | `delegate(delegatee) nonpayable` | Delegate votes to address (or self). Required before voting |
| `delegates()` | `delegates(account) view → address` | Returns the address an account delegates to |
| `getCurrentVotes()` | `getCurrentVotes(account) view → uint96` | Returns current vote weight |
| `ownerOf()` | `ownerOf(tokenId) view → address` | Returns owner of a specific Noun |
| `tokenURI()` | `tokenURI(tokenId) view → string` | Base64-encoded JSON with on-chain SVG + trait metadata |

---

## 4. Agent Workflows

### 4.1 Bid on a Noun (Required)

1. Call `auction()` → get `nounId`, `amount`, `endTime`, `settled`
2. Verify: `block.timestamp < endTime` and `settled == false`
3. Calculate minimum bid:
```solidity
uint256 minBid = amount > 0
  ? amount + (amount * minBidIncrementPercentage / 100)
  : reservePrice;
```
4. Call `createBid(nounId, 38)` with `msg.value = desired bid`
5. Monitor `AuctionBid` event — if `extended == true`, update expected `endTime`
6. If outbid: automatic ETH refund from contract; re-bid logic is optional

### 4.2 Settle an Auction (Required)

1. Read `auction()` — verify `block.timestamp >= endTime` and `settled == false`
2. Call `settleCurrentAndCreateNewAuction()` (if not paused) or `settleAuction()` (if paused)
3. Listen for `AuctionSettled` — if `winner == address(0)`, Noun was burned (no bids)
4. `AuctionCreated` fires in the same transaction, starting the next auction

### 4.3 Vote on a Proposal (Optional)

1. Iterate from `proposalCount()` down, call `state(id)` to find Active proposals
2. Call `proposals(id)` to read description, vote counts, end block
3. Call `getReceipt(id, agentAddress)` to confirm no prior vote
4. Call `castRefundableVoteWithReason(proposalId, support, reason, 38)`
   - `support`: `0` = Against, `1` = For, `2` = Abstain
5. Confirm via `VoteCast` event

### 4.4 Daily Briefing (Optional, read-only)

A scheduled digest that drives a daily governance loop. Performs **no signing**
— it only reads, so it needs `ETHEREUM_RPC_URL` but never `AGENT_PRIVATE_KEY`.

1. Read `auction()` (+ `reservePrice`, `minBidIncrementPercentage`, `timeBuffer`):
   - Report Noun ID, high bid, bidder, time remaining, and min next bid
   - Flag `needsSettlement` when `block.timestamp >= endTime && !settled`
   - Flag Nounders' Nouns (`nounId % 10 == 0`) — never auctioned
2. Iterate `proposalCount()` down, collecting `state(id) == 1` (Active) proposals
   with their for/against/abstain tallies and `quorumVotes`
3. Flag `endingSoon` when an Active proposal's `endBlock` is within a configurable
   window (default ~6500 blocks ≈ 1 day)
4. If a voter address is supplied, annotate each Active proposal via
   `getReceipt(id, voter)` with whether it has already voted
5. Report what changed over a recent block window (default ~24h) from event
   logs — `AuctionBid`, `AuctionCreated`, `AuctionSettled` (burns flagged when
   `winner == address(0)`), and `VoteCast` grouped per proposal — plus any
   proposals whose `creationTimestamp` falls inside the window
6. Emit a JSON payload plus human-readable `headlines` suitable for posting

> Scoped deliberately to public, everyone-uses-it data. Client-specific reward
> balances are out of scope here — see §5 for the clientId-38 rewards lifecycle.

---

## 5. Client Attribution

> Reference: https://paragraph.com/@verbsteam/how-to-participate-in-nouns-client-incentives

Eligible Nouns calls include client ID **38** for Gavel attribution.

### ✅ Client ID: `38`
- Nouns Client Token #38 minted to `gramajo.eth`
- Tx: `0x2a4f0e52ae83331de3fe08c776a704be6adf8c14c6aa202bfadae0e1b66dc691`

Reward maintenance, balances, metadata administration, and withdrawals are not
skill actions and no scripts or ABI for those operations are shipped in this
public repository. They are administered separately by the client owner.

### clientId-Aware Function Signatures

| Function | Call with clientId |
|----------|--------------------|
| Place bid | `createBid(nounId, 38)` |
| Cast vote | `castRefundableVoteWithReason(proposalId, support, reason, 38)` |
| Cast vote (no reason) | `castRefundableVote(proposalId, support, 38)` |
| Submit proposal | `propose(targets, values, sigs, calldatas, description, 38)` |

---

## 6. SKILL.md Scaffold

```markdown
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
- list_proposals     — enumerate Active governance proposals  [optional]
- cast_vote          — castRefundableVoteWithReason(..., 38)  [optional]
```

---

## 7. Repository File Structure

```
nouns-dao/
├── SKILL.md
├── config.json                  ← { "clientId": 38 }
├── references/
│   ├── auction-abi.json         ← ABI for 0x830BD73E...
│   ├── governance-abi.json      ← ABI for 0x6f3E6272...
│   └── nouns-token-abi.json     ← ERC-721 ABI
└── scripts/
    ├── _utils.js                ← shared helpers (provider, ABIs, formatting)
    ├── get_auction.js
    ├── place_bid.js             ← createBid(nounId, 38)
    ├── settle_auction.js
    ├── get_noun_metadata.js     ← decodes tokenURI base64
    ├── daily_briefing.js        ← [optional] read-only auction + proposals digest
    ├── list_proposals.js        ← [optional]
    ├── cast_vote.js             ← castRefundableVoteWithReason(..., 38)
    ├── delegate_votes.js        ← [optional] delegate(address)
    └── propose.js               ← [optional] propose(..., 38)
```

---

## 8. Environment & Configuration

| Key | Value |
|-----|-------|
| `ETHEREUM_RPC_URL` | Alchemy / Infura mainnet endpoint |
| `AGENT_PRIVATE_KEY` | Injected signer from Bankr runtime |
| `CLIENT_ID` | `38` |
| Gas Strategy | EIP-1559: set `maxFeePerGas` + `maxPriorityFeePerGas` |
| Bid Slippage Guard | Re-fetch `auction()` immediately before broadcasting |
| Auction Contract | `0x830BD73E4184ceF73443C15111a1DF14e495C706` |
| Governance Contract | `0x6f3E6272A167e8AcCb32072d08E0957F9c79223d` |
| Nouns Token | `0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03` |

---

## 9. Edge Cases & Gotchas

**Auction Extension**
If a bid arrives within `timeBuffer` seconds of `endTime`, the contract extends `endTime` by `timeBuffer` (currently 10 min). Always re-read `auction().endTime` after any `AuctionBid` event — never cache it.

**Nounders' Nouns (Every 10th)**
Noun IDs that are multiples of 10 (0, 10, 20 …) are minted to the Nounders' multisig for the first 5 years. They are never auctioned — skip these IDs.

**Paused Auction House**
When paused, `settleCurrentAndCreateNewAuction()` reverts. Fall back to `settleAuction()` (which is `whenPaused`).

**No-Bid Burns**
If an auction ends with `bidder == address(0)`, the Noun is burned on settlement. Expected behavior — not an error.

**Vote Snapshot Timing**
Governance snapshots at the block of proposal creation. A Noun acquired after that block cannot vote on that proposal.

**Delegate Before Voting**
Call `delegate(selfAddress)` on the Nouns Token at least once to activate voting power. Without it, `getCurrentVotes()` returns 0 even if you hold Nouns.

---

## 10. Submission Checklist

- [ ] `SKILL.md` present at `nouns-dao/SKILL.md` with correct frontmatter
- [ ] Auction, governance, and Nouns token ABIs in `references/`
- [ ] `config.json` present with `{ "clientId": 38 }`
- [ ] `get_auction.js`, `place_bid.js`, `settle_auction.js` functional on mainnet
- [ ] `place_bid.js` uses `createBid(nounId, 38)` — not the clientId-less variant
- [ ] `cast_vote.js` uses `castRefundableVoteWithReason(..., 38)` for reward attribution
- [ ] `daily_briefing.js` is read-only — requires no `AGENT_PRIVATE_KEY` and sends no tx
- [ ] No reward-maintenance or withdrawal tooling is shipped in the public skill
- [ ] Bid validation enforces both `reservePrice` and `minBidIncrementPercentage`
- [ ] Scripts are stateless — all config via env vars and `config.json`
- [ ] PR description explains what the skill does and which contracts it calls
- [ ] README explains how to test on a mainnet fork (e.g. Hardhat forking)

---

*Nouns DAO Bankr Skill Spec v1.0 | clientId: 38 | gramajo.eth*
