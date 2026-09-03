# Gavel Bankr Skill — Developer and Legacy Tool Reference

The voter-facing entry point is [`SKILL.md`](SKILL.md). It presents Gavel as a
personalized governance copilot and routes natural intents to private history,
profile, proposal-analysis, correction, backtest, daily briefing, review-first
voting, and delegation workflows.

The commands below are lower-level Nouns utilities retained for development and
explicit auction or transaction requests. They are not the primary Gavel user
experience:

- Bid in daily Noun auctions
- Settle auctions
- Read Noun metadata (on-chain SVG + traits)
- (Optional) list active proposals and cast votes

Eligible Nouns transactions automatically include Gavel client ID **38** for
builder-side attribution. Voters do not configure or withdraw these rewards.

Client ID is **38** and is fixed via `config.json` (no overrides). It must be included in eligible calls.

---

## Directory Layout

```
nouns-dao/
├── SKILL.md
├── config.json
├── references/
│   ├── auction-abi.json
│   ├── governance-abi.json
│   └── nouns-token-abi.json
└── scripts/
    ├── _utils.js
    ├── get_auction.js
    ├── place_bid.js
    ├── settle_auction.js
    ├── get_noun_metadata.js
    ├── daily_briefing.js
    ├── list_proposals.js
    ├── cast_vote.js
    ├── delegate_votes.js
    └── propose.js
```

---

## Environment

Required for legacy transactions only:
- `AGENT_PRIVATE_KEY` — signer private key

Optional:
- `ETHEREUM_RPC_URL` — advanced mainnet RPC override; read and transaction
  scripts default to the public `https://eth.drpc.org` endpoint
- `CLIENT_ID` — not used; clientId is fixed in `config.json` (38)
- `MAX_FEE_GWEI`, `MAX_PRIORITY_FEE_GWEI` — bid gas controls
- `MAX_FEE_PER_GAS_GWEI`, `MAX_PRIORITY_FEE_PER_GAS_GWEI` — vote gas controls
- `BID_AMOUNT_WEI`, `BID_AMOUNT_ETH` — bid amount defaults
- `NOUN_ID` — noun id for metadata lookup

---

## Scripts

### Get Current Auction (Required)
```
node scripts/get_auction.js
```

### Place Bid (Required)
```
node scripts/place_bid.js --amount-eth 50
```

or:

```
BID_AMOUNT_ETH=50 node scripts/place_bid.js
```

### Settle Auction (Required)
```
node scripts/settle_auction.js
```

### Get Noun Metadata (Required)
```
NOUN_ID=123 node scripts/get_noun_metadata.js
```

### Daily Briefing (Optional)
Read-only digest of the live auction, Active proposals, and what changed since
the last briefing (bids, settlements, new auctions, new proposals, and votes
cast over a recent block window, read from event logs). Signs nothing and uses
the public RPC default, so it is safe to run unattended on a schedule. Set
`ETHEREUM_RPC_URL` only to override that endpoint.
```
node scripts/daily_briefing.js
```
Optionally annotate whether an address has voted on each Active proposal, and
widen or narrow the change window (default ~24h):
```
node scripts/daily_briefing.js --voter=0xYourAddress --limit=10 --since-hours=24
```

### List Active Proposals (Optional)
```
node scripts/list_proposals.js --limit=10
```

### Cast Vote (Optional)
```
node scripts/cast_vote.js 456 1 "Voting FOR because…"
```

The primary Gavel path prepares canonical-verified unsigned calldata from the
repository root before any wallet approval:

```
node bin/gavel.js prepare-vote prediction.json proposal.json --support FOR --reason "Confirmed reason" --acknowledge-prediction-review
```

See `../docs/PREPARE_VOTE.md`. The direct script above broadcasts immediately
and is retained only for explicit legacy use.

### Delegate Votes (Optional)
```
node scripts/delegate_votes.js --to 0xYourAddress
```

### Propose (Optional)
```
node scripts/propose.js --targets 0xTarget1,0xTarget2 --values 0,0 --signatures "", "" --calldatas 0x,0x --description "Proposal description"
```

### Builder rewards

Eligible transactions retain Gavel's fixed client attribution, but this
repository intentionally ships no reward-maintenance or withdrawal scripts.
Those are owner operations and are administered outside the public skill.

---

## Mainnet Fork Testing (Hardhat)

Example workflow for a local mainnet fork:

1. Create a `hardhat.config.js` with forking enabled:
```
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  networks: {
    hardhat: {
      forking: {
        url: process.env.ETHEREUM_RPC_URL
      }
    }
  }
};
```

2. Run a forked node:
```
npx hardhat node
```

3. Point scripts to the local node:
```
ETHEREUM_RPC_URL=http://127.0.0.1:8545 node scripts/get_auction.js
```

---

## Notes & Gotchas

- Bids must satisfy **reserve price** and **min increment**.
- Auctions extend when bids arrive within `timeBuffer`.
- Nounders’ nouns (multiples of 10) are not auctioned.
- Governance voting requires delegation via `delegate()`.
- Rewards attribution requires passing `clientId=38` in eligible calls.

---

## Contracts

- Auction House: `0x830BD73E4184ceF73443C15111a1DF14e495C706`
- Governance: `0x6f3E6272A167e8AcCb32072d08E0957F9c79223d`
- Nouns Token: `0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03`
