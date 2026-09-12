"use strict";

/**
 * A mocked Nouns vote preparation, for tests that need a real
 * `votePreparation` document rather than a hand-written one.
 *
 * Producing it through the actual `NounsVotePreparationAdapter` is the point:
 * tests of the execution boundary then consume exactly what the governance
 * layer emits today, so a drift in the preparation shape fails them.
 */

const {
  GOVERNANCE_ADDRESS,
  NOUNS_TOKEN_ADDRESS,
  NounsVotePreparationAdapter,
  decodeNounsVoteCall,
} = require("../../packages/nouns-adapter/src/vote");

const VOTER = "0x1111111111111111111111111111111111111111";
const ACTION_TARGET = "0x2222222222222222222222222222222222222222";
const PROPOSER = "0x3333333333333333333333333333333333333333";
const CONTENT_HASH = "a".repeat(64);

function proposal(overrides = {}) {
  return {
    id: "42",
    contentHash: CONTENT_HASH,
    title: "Fund a tested public-good builder",
    description: "Untrusted proposal prose",
    proposer: PROPOSER,
    state: "ACTIVE",
    outcome: "ACTIVE",
    createdBlock: "90",
    createdAt: "2026-01-01T00:00:00.000Z",
    startBlock: "100",
    endBlock: "200",
    quorumVotes: "10",
    forVotes: "2",
    againstVotes: "1",
    abstainVotes: "0",
    actions: [{ index: 0, target: ACTION_TARGET, valueWei: "0", signature: "ping()", calldata: "0x" }],
    ...overrides,
  };
}

function security(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    proposalId: "42",
    proposalContentHash: CONTENT_HASH,
    contentPolicy: {
      classification: "UNTRUSTED_GOVERNANCE_CONTENT",
      instructionHandling: "NEVER_FOLLOW",
      detectedInstructionPatterns: [],
    },
    sourceVerification: "STRUCTURED_INPUT_NOT_CHAIN_VERIFIED",
    actions: [],
    mismatches: [],
    flags: [],
    summary: {
      riskLevel: "CLEAR",
      requiresHumanReview: false,
      actionCount: 1,
      decodedActionCount: 1,
      unknownActionCount: 0,
      mismatchCount: 0,
    },
    ...overrides,
  };
}

function prediction(overrides = {}) {
  return {
    schemaVersion: "1.3.0",
    generatedAt: "2026-01-02T00:00:00.000Z",
    asOf: "2026-01-02T00:00:00.000Z",
    dao: "nouns",
    chainId: 1,
    voter: VOTER,
    proposalId: "42",
    proposalContentHash: CONTENT_HASH,
    recommendation: "FOR",
    confidence: 0.8,
    confidencePercent: 80,
    confidenceCalibrated: false,
    confidenceKind: "HEURISTIC_SCORE",
    policySource: "OBSERVED_BEHAVIOR",
    policySourceId: null,
    precedents: [],
    reasoning: ["Personal historical evidence favors this proposal."],
    flags: ["Review the draft before signing."],
    predictionReview: {
      requiresHumanReview: false,
      autonomyAllowed: false,
      reasonCodes: ["POLICY_BLOCKS_AUTONOMY"],
      backtest: null,
    },
    security: security(),
    draftReason: {
      isDraft: true,
      available: true,
      text: "Support based on the builder's demonstrated delivery.",
      basis: "PROFILE_STYLE_TEMPLATE",
    },
    evidence: {
      profileVoteCount: 20,
      candidatePrecedentCount: 20,
      relevantPrecedentCount: 3,
      supportScores: { AGAINST: 0.15, FOR: 0.8, ABSTAIN: 0.05 },
      confidenceBreakdown: {
        margin: 0.8,
        similarity: 0.8,
        sufficiency: 0.8,
        recency: 0.8,
        historyDepth: 0.8,
        policyOverride: 0,
      },
    },
    method: {
      name: "gavel-evidence-heuristic",
      version: "1.0.0",
      calibrated: false,
      relevantSimilarityThreshold: 0.15,
      maxScoredPrecedents: 8,
    },
    ...overrides,
  };
}

/**
 * Run the real preparation adapter against mocked chain state.
 *
 * `overrides.executionAddress` is the interesting knob for execution tests: it
 * is the address the vote is cast from (a Safe, a WaaP wallet), and
 * `overrides.delegatee` must match it or the adapter blocks on delegation.
 */
async function prepareNounsVote(overrides = {}) {
  const executionAddress = overrides.executionAddress || VOTER;
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(overrides.chainId ?? 1) }),
    getBlockNumber: async () => 150,
    getCode: async () => "0x6000",
    call: async () => {
      if (overrides.simulationError) throw new Error("execution reverted: mocked failure");
      return "0x";
    },
    estimateGas: async () => 123456n,
  };
  const governance = {
    state: async () => BigInt(overrides.state ?? 1),
    proposals: async () => ({ id: 42n, proposer: PROPOSER, startBlock: 100n, endBlock: 200n }),
    getActions: async () => ({
      targets: [ACTION_TARGET],
      values: [0n],
      signatures: ["ping()"],
      calldatas: ["0x"],
    }),
    getReceipt: async () => ({ hasVoted: overrides.hasVoted ?? false, support: 0n, votes: 0n }),
  };
  const nounsToken = {
    getPriorVotes: async () => overrides.votingPower ?? 3n,
    delegates: async () => overrides.delegatee ?? executionAddress,
  };
  const adapter = new NounsVotePreparationAdapter({
    provider,
    governance,
    nounsToken,
    now: () => new Date("2026-01-03T00:00:00.000Z"),
    freshnessVerifier: async () => ({
      version: 1,
      latestEvent: "ProposalCreated",
      latestBlock: "90",
      eventDigest: "0xfeed",
      description: (overrides.proposal || proposal()).description,
    }),
  });
  return adapter.prepare({
    prediction: prediction(overrides.prediction),
    proposal: overrides.proposal || proposal(),
    selectedSupport: overrides.selectedSupport || "FOR",
    votingAddress: executionAddress,
    executionAddress,
    assetOwnerAddress: overrides.assetOwnerAddress || VOTER,
    reason: overrides.reason,
    acknowledgeSecurityReview: overrides.acknowledgeSecurityReview ?? true,
    acknowledgePredictionReview: overrides.acknowledgePredictionReview ?? true,
  });
}

/** A minimal registered-adapter descriptor matching the real Nouns addresses. */
function nounsAdapterDescriptor(overrides = {}) {
  return {
    id: "nouns",
    chainId: 1,
    adapterVersion: "nouns@test",
    governanceContracts: { governor: GOVERNANCE_ADDRESS, token: NOUNS_TOKEN_ADDRESS },
    // Only the governor is a vote target: the contract map is not an allowlist.
    governanceTargets: [GOVERNANCE_ADDRESS],
    // castRefundableVoteWithReason(uint256,uint8,string,uint32)
    governanceSelectors: { CAST_VOTE: ["0x8136730f"] },
    // The boundary binds the encoded decision to the bytes, so a descriptor
    // has to decode its own calldata just as the real adapter does.
    decodeGovernanceCall: (action, data) => decodeNounsVoteCall(data),
    capabilities: { analyze: true, predict: true, prepareVote: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    validateProposal() {},
    getVotingPower() {},
    getCurrentDelegate() {},
    hasVoted() {},
    prepareVote() {},
    ...overrides,
  };
}

module.exports = {
  ACTION_TARGET,
  CONTENT_HASH,
  GOVERNANCE_ADDRESS,
  NOUNS_TOKEN_ADDRESS,
  VOTER,
  nounsAdapterDescriptor,
  prepareNounsVote,
  prediction,
  proposal,
  security,
};
