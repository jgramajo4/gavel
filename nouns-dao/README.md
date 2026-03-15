# Nouns DAO Bankr Skill (`nouns-dao`)

This skill lets agents participate in Nouns DAO on Ethereum mainnet:
- Bid in daily Noun auctions
- Settle auctions
- Read Noun metadata (on-chain SVG + traits)
- (Optional) list active proposals and cast votes
- (Optional) withdraw client incentives

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
│   ├── nouns-token-abi.json
│   └── rewards-abi.json
└── scripts/
    ├── _utils.js
    ├── get_auction.js
    ├── place_bid.js
    ├── settle_auction.js
    ├── get_noun_metadata.js
    ├── list_proposals.js
    ├── cast_vote.js
    ├── propose.js
    ├── update_rewards.js
    └── withdraw_rewards.js
```

---

## Environment

Required:
- `ETHEREUM_RPC_URL` — Mainnet RPC endpoint
- `AGENT_PRIVATE_KEY` — signer private key (required for txs)

Optional:
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

### List Active Proposals (Optional)
```
node scripts/list_proposals.js --limit=10
```

### Cast Vote (Optional)
```
node scripts/cast_vote.js 456 1 "Voting FOR because…"
```

### Propose (Optional)
```
node scripts/propose.js --targets 0xTarget1,0xTarget2 --values 0,0 --signatures "", "" --calldatas 0x,0x --description "Proposal description"
```

### Update Rewards (Optional)
```
node scripts/update_rewards.js --last-proposal-id 456 --voting-client-ids 38
```

### Withdraw Rewards (Optional)
```
node scripts/withdraw_rewards.js --to 0xYourAddress --amount-eth 0.5
```

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
- Rewards: `0x883860178f95d0c82413edc1d6de530cb4771d55`
