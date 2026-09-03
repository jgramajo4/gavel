/**
 * Gavel constants — on-chain identities and contract addresses.
 *
 * CLIENT_ID is Gavel's on-chain identity, hardcoded by definition. It is NOT a
 * config value and never lives in `.env`. Client Token #38 (NFT) was minted to
 * gramajo.eth (tx 0x2a4f0e52ae83331de3fe08c776a704be6adf8c14c6aa202bfadae0e1b66dc691).
 * Every rewards-eligible contract call must pass `38` for attribution.
 */
export const CLIENT_ID = 38 as const;

/** Mainnet contract addresses. */
export const ADDRESSES = {
  // Nouns governance
  NounsDAO: '0x6f3E6272A167e8AcCb32072d08E0957F9c79223d',
  NounsAuctionHouse: '0x830BD73E4184ceF73443C15111a1DF14e495C706',
  NounsToken: '0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03',
  Rewards: '0x883860178f95d0c82413edc1d6de530cb4771d55',

  // EAS (Ethereum Attestation Service)
  EAS: '0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587',
  SchemaRegistry: '0x0a574343DDeC5C0Fb6d05F9Bb0A95eE3Db093423',
  Propdates: '0xa5Bf9A9b8f60CFD98b1cCB592f2F9F37Bb0033a4',

  // Nouns Passport resolvers (from nouns-builder-passport). Placeholders until
  // deployed; override once addresses are known.
  NounsPassportResolver: '0x0000000000000000000000000000000000000000',
  NounHolderResolver: '0x0000000000000000000000000000000000000000',
} as const;

/**
 * EAS schema UIDs for the three Nouns Passport schemas. Placeholders until the
 * schemas are registered on-chain; the write path fails loudly if left zero.
 */
export const SCHEMA_UIDS = {
  builderMilestone: '0x0000000000000000000000000000000000000000000000000000000000000000',
  peerVerification: '0x0000000000000000000000000000000000000000000000000000000000000000',
  builderPassport: '0x0000000000000000000000000000000000000000000000000000000000000000',
} as const;

/** EAS schema field layouts (order matters for ABI encoding). */
export const SCHEMA_DEFINITIONS = {
  builderMilestone:
    'uint256 propId,string milestoneTitle,string evidenceURI,bool isFinal,bytes32 propdateTxHash',
  peerVerification:
    'bytes32 milestoneUID,uint256 propId,bool verified,string comment',
  builderPassport:
    'address builder,uint256 totalProps,uint256 completedProps,uint256 totalMilestones,uint256 peerVerifications,uint256 avgDaysBetweenUpdates,uint256 passportVersion',
} as const;

/** Defaults, overridable via `.env`. No secrets here. */
export const DEFAULTS = {
  RPC_URL: 'https://eth.drpc.org',
  // Nouns governance subgraph (mainnet, decentralized network gateway mirror).
  SUBGRAPH_URL:
    'https://api.goldsky.com/api/public/project_cldf2o9pqagp43svvbk5u3kmo/subgraphs/nouns/prod/gn',
  EAS_GRAPHQL_URL: 'https://easscan.org/graphql',
  // gramajo/nouns_proposal_check Gradio Space (DistilBERT outcome model).
  PREDICTION_URL: 'https://gramajo-nouns-proposal-check.hf.space',
} as const;

/** Polling cadences (ms), tiered by proposal state — see spec Open Q3. */
export const POLL_INTERVALS = {
  activeDetail: 15_000,
  endingSoonDetail: 10_000,
  proposalList: 120_000,
  idleTimeout: 300_000,
} as const;

/** Below this much time remaining (seconds), bump the detail poll rate. */
export const ENDING_SOON_THRESHOLD_S = 3600;

export const MAINNET_CHAIN_ID = 1;

