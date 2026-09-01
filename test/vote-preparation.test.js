"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface } = require("ethers");

const {
  CLIENT_ID,
  GOVERNANCE_ABI,
  GOVERNANCE_ADDRESS,
  canonicalActions,
  NounsVotePreparationAdapter,
} = require("../src/adapters/nouns/vote");

const VOTER = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const DELEGATE = "0x5555555555555555555555555555555555555555";
const HASH = "a".repeat(64);

function proposal(overrides = {}) {
  return {
    id: "42",
    contentHash: HASH,
    title: "Fund a tested public-good builder",
    description: "Untrusted proposal prose",
    proposer: "0x3333333333333333333333333333333333333333",
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
    actions: [{ index: 0, target: TARGET, valueWei: "0", signature: "ping()", calldata: "0x" }],
    ...overrides,
  };
}

function security(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    proposalId: "42",
    proposalContentHash: HASH,
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
    schemaVersion: "1.2.0",
    generatedAt: "2026-01-02T00:00:00.000Z",
    asOf: "2026-01-02T00:00:00.000Z",
    dao: "nouns",
    chainId: 1,
    voter: VOTER,
    proposalId: "42",
    proposalContentHash: HASH,
    recommendation: "FOR",
    confidence: 0.8,
    confidencePercent: 80,
    confidenceCalibrated: false,
    policySource: "OBSERVED_BEHAVIOR",
    policySourceId: null,
    precedents: [],
    reasoning: ["Personal historical evidence favors this proposal."],
    flags: ["Review the draft before signing."],
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

function canonical(overrides = {}) {
  return {
    id: 42n,
    proposer: "0x3333333333333333333333333333333333333333",
    startBlock: 100n,
    endBlock: 200n,
    ...overrides,
  };
}

function canonicalActionResult(overrides = {}) {
  return {
    targets: [TARGET],
    values: [0n],
    signatures: ["ping()"],
    calldatas: ["0x"],
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(overrides.chainId ?? 1) }),
    getBlockNumber: async () => 150,
    getCode: async () => "0x6000",
    call: async (request) => {
      calls.push(["call", request]);
      if (overrides.simulationError) throw new Error("execution reverted: mocked failure");
      return "0x";
    },
    estimateGas: async (request) => {
      calls.push(["estimateGas", request]);
      return 123456n;
    },
  };
  const governance = {
    state: async () => BigInt(overrides.state ?? 1),
    proposals: async () => canonical(overrides.canonical),
    getActions: async () => canonicalActionResult(overrides.canonicalActions),
    getReceipt: async () => ({
      hasVoted: overrides.hasVoted ?? false,
      support: 0n,
      votes: overrides.receiptVotes ?? 0n,
    }),
  };
  const nounsToken = {
    getPriorVotes: async () => overrides.votingPower ?? 3n,
    delegates: async () => overrides.delegatee ?? VOTER,
  };
  const adapter = new NounsVotePreparationAdapter({
    provider,
    governance,
    nounsToken,
    now: () => new Date("2026-01-03T00:00:00.000Z"),
    freshnessVerifier: async () => {
      if (overrides.freshnessError) throw new Error("mocked log outage");
      return {
        version: overrides.version ?? 1,
        description: overrides.canonicalDescription ?? proposal().description,
        latestEvent: overrides.latestEvent ?? "ProposalCreated",
        latestBlock: "90",
        eventDigest: `0x${"1".repeat(64)}`,
      };
    },
  });
  return { adapter, calls };
}

test("uses the deployed compact proposal ABI and a separate action getter", () => {
  const contractInterface = new Interface(GOVERNANCE_ABI);
  assert.equal(contractInterface.getFunction("proposals").outputs.length, 15);
  assert.ok(contractInterface.getFunction("getActions"));

  const encoded = contractInterface.encodeFunctionResult("getActions", [
    [TARGET],
    [0n],
    ["ping()"],
    ["0x"],
  ]);
  const decoded = contractInterface.decodeFunctionResult("getActions", encoded);
  assert.deepEqual(canonicalActions(decoded), [
    { index: 0, target: TARGET, valueWei: "0", signature: "ping()", calldata: "0x" },
  ]);
});

test("prepares unsigned vote calldata only after every canonical gate passes", async () => {
  const { adapter, calls } = harness();
  const result = await adapter.prepare({ prediction: prediction(), proposal: proposal(), selectedSupport: "FOR" });

  assert.equal(result.status, "READY_TO_SIGN");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.transaction.to, GOVERNANCE_ADDRESS);
  assert.equal(result.transaction.from, VOTER);
  assert.equal(result.modelVoter, VOTER);
  assert.equal(result.votingAddress, VOTER);
  assert.equal(result.verification.simulation.estimatedGas, "123456");
  assert.deepEqual(calls.map(([name]) => name), ["call", "estimateGas"]);

  const decoded = new Interface(GOVERNANCE_ABI).decodeFunctionData(
    "castRefundableVoteWithReason",
    result.transaction.data,
  );
  assert.equal(decoded.proposalId, 42n);
  assert.equal(decoded.support, 1n);
  assert.equal(decoded.reason, prediction().draftReason.text);
  assert.equal(decoded.clientId, BigInt(CLIENT_ID));
});

test("blocks inactive and duplicate votes before simulation", async () => {
  const { adapter, calls } = harness({ state: 4, hasVoted: true });
  const result = await adapter.prepare({ prediction: prediction(), proposal: proposal(), selectedSupport: "FOR" });

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.transaction, null);
  assert.deepEqual(result.blockers.map((item) => item.code), ["PROPOSAL_NOT_ACTIVE", "DUPLICATE_VOTE"]);
  assert.equal(calls.length, 0);
});

test("keeps the modeled voter distinct from an explicitly delegated voting address", async () => {
  const result = await harness({ delegatee: DELEGATE }).adapter.prepare({
    prediction: prediction(),
    proposal: proposal(),
    selectedSupport: "FOR",
    votingAddress: DELEGATE,
  });
  assert.equal(result.status, "READY_TO_SIGN");
  assert.equal(result.modelVoter, VOTER);
  assert.equal(result.votingAddress, DELEGATE);
  assert.equal(result.transaction.from, DELEGATE);
  assert.equal(result.verification.delegation.modelVoterDelegatee, DELEGATE);
  assert.equal(result.verification.delegation.matchesVotingAddress, true);
});

test("blocks missing voting power and canonical action drift", async () => {
  const { adapter } = harness({
    votingPower: 0n,
    canonicalActions: { targets: ["0x4444444444444444444444444444444444444444"] },
  });
  const result = await adapter.prepare({ prediction: prediction(), proposal: proposal(), selectedSupport: "FOR" });

  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.some((item) => item.code === "EXECUTABLE_ACTION_MISMATCH"));
  assert.ok(result.blockers.some((item) => item.code === "NO_SNAPSHOT_VOTING_POWER"));
});

test("fails closed on stale proposal prose or unavailable canonical version events", async () => {
  const stale = await harness({ canonicalDescription: "Updated canonical description", version: 2 }).adapter.prepare({
    prediction: prediction(), proposal: proposal(), selectedSupport: "FOR",
  });
  assert.equal(stale.status, "BLOCKED");
  assert.ok(stale.blockers.some((item) => item.code === "PROPOSAL_DESCRIPTION_STALE"));
  assert.equal(stale.verification.freshness.version, 2);
  assert.equal(stale.verification.freshness.descriptionMatches, false);

  const unavailable = await harness({ freshnessError: true }).adapter.prepare({
    prediction: prediction(), proposal: proposal(), selectedSupport: "FOR",
  });
  assert.equal(unavailable.status, "BLOCKED");
  assert.ok(unavailable.blockers.some((item) => item.code === "CANONICAL_VERSION_UNAVAILABLE"));
  assert.equal(unavailable.verification.freshness.verifiedFromCanonicalEvents, false);
});

test("requires exact recommendation confirmation and explicit acknowledgement of review flags", async () => {
  const finding = {
    code: "UNKNOWN_CALLDATA",
    severity: "DANGER",
    actionIndex: 0,
    message: "Unknown executable action requires review.",
  };
  const reviewedPrediction = prediction({
    security: security({
      flags: [finding],
      summary: {
        riskLevel: "HIGH",
        requiresHumanReview: true,
        actionCount: 1,
        decodedActionCount: 0,
        unknownActionCount: 1,
        mismatchCount: 0,
      },
    }),
  });
  const first = await harness().adapter.prepare({
    prediction: reviewedPrediction,
    proposal: proposal(),
    selectedSupport: "AGAINST",
  });
  assert.ok(first.blockers.some((item) => item.code === "RECOMMENDATION_NOT_CONFIRMED"));
  assert.ok(first.blockers.some((item) => item.code === "SECURITY_REVIEW_REQUIRED"));

  const second = await harness().adapter.prepare({
    prediction: reviewedPrediction,
    proposal: proposal(),
    selectedSupport: "FOR",
    acknowledgeSecurityReview: true,
    reason: "I reviewed the flagged call and confirm this vote reason.",
  });
  assert.equal(second.status, "READY_TO_SIGN");
  assert.equal(second.reason.source, "USER_CONFIRMED");
});

test("blocks when canonical simulation reverts", async () => {
  const result = await harness({ simulationError: true }).adapter.prepare({
    prediction: prediction(),
    proposal: proposal(),
    selectedSupport: "FOR",
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.transaction, null);
  assert.equal(result.verification.simulation.attempted, true);
  assert.equal(result.verification.simulation.succeeded, false);
  assert.match(result.blockers[0].message, /mocked failure/);
});
