const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyCalibrationToPrediction,
  bucketFor,
  buildCalibrationModel,
  onlineCalibratedConfidence,
} = require("../src/core/backtest/calibration");
const { runChronologicalBacktest, sanitizeTrainingVote } = require("../src/core/backtest/run");

const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";
const AS_OF = "2026-01-01T00:00:00.000Z";

function proposal(id) {
  return {
    id: String(id),
    contentHash: Number(id).toString(16).padStart(64, "0"),
    title: "Fund maintained public goods infrastructure",
    description: "A measurable open source grant.",
    proposer: "0x0000000000000000000000000000000000000001",
    state: "EXECUTED",
    outcome: "SUCCEEDED",
    createdBlock: String(100 + id),
    createdAt: `2025-${String(Math.min(id, 12)).padStart(2, "0")}-01T00:00:00.000Z`,
    startBlock: String(110 + id),
    endBlock: String(120 + id),
    quorumVotes: "10",
    forVotes: "12",
    againstVotes: "2",
    abstainVotes: "1",
    actions: [
      {
        index: 0,
        target: "0x0000000000000000000000000000000000000002",
        valueWei: "1000000000000000000",
        signature: "transfer(address,uint256)",
        calldata: "0x1234",
      },
    ],
  };
}

function vote(id, blockNumber, support) {
  const normalizedProposal = proposal(id);
  return {
    dao: "nouns",
    chainId: 1,
    proposalId: String(id),
    proposalContentHash: normalizedProposal.contentHash,
    voter: VOTER,
    support,
    reason: "I support measurable work, but delivery should be reviewed.",
    blockNumber: String(blockNumber),
    timestamp: `2025-${String(Math.min(id, 12)).padStart(2, "0")}-15T00:00:00.000Z`,
    voteWeight: "1",
    clientId: 38,
    proposal: normalizedProposal,
    source: {
      kind: "nouns-subgraph",
      endpoint: "https://example.test/subgraph",
      entityId: `${VOTER.toLowerCase()}-${id}`,
      transactionHash: `0x${Number(id).toString(16).padStart(64, "0")}`,
      subgraphBlock: "9999",
      queriedAt: AS_OF,
    },
  };
}

function history() {
  const votes = [
    vote(1, 10, "FOR"),
    vote(2, 20, "FOR"),
    vote(3, 30, "AGAINST"),
    vote(4, 30, "FOR"),
    vote(5, 40, "FOR"),
    vote(6, 50, "ABSTAIN"),
    vote(7, 60, "FOR"),
    vote(8, 70, "AGAINST"),
  ];
  return {
    schemaVersion: "1.0.0",
    dao: "nouns",
    chainId: 1,
    voter: VOTER,
    generatedAt: AS_OF,
    source: { kind: "nouns-subgraph", endpoint: "https://example.test/subgraph", subgraphBlock: "9999" },
    voteCount: votes.length,
    votes,
  };
}

function rawPrediction(confidence = 0.75) {
  return {
    schemaVersion: "1.0.0",
    generatedAt: AS_OF,
    asOf: AS_OF,
    dao: "nouns",
    chainId: 1,
    voter: VOTER,
    proposalId: "999",
    proposalContentHash: "9".repeat(64),
    recommendation: "FOR",
    confidence,
    confidencePercent: Math.round(confidence * 100),
    confidenceCalibrated: false,
    policySource: "OBSERVED_BEHAVIOR",
    policySourceId: null,
    precedents: [],
    reasoning: ["Test prediction."],
    flags: ["Uncalibrated."],
    draftReason: { isDraft: true, available: false, text: null, basis: "INSUFFICIENT_EVIDENCE" },
    evidence: {
      profileVoteCount: 10,
      candidatePrecedentCount: 10,
      relevantPrecedentCount: 0,
      supportScores: { AGAINST: 0.25, FOR: 0.6, ABSTAIN: 0.15 },
      confidenceBreakdown: {
        margin: 0.35,
        similarity: 0,
        sufficiency: 0,
        recency: 0,
        historyDepth: 0.2,
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
  };
}

test("redacts ingestion-time outcome fields from backtest training votes", () => {
  const sanitized = sanitizeTrainingVote(vote(1, 10, "FOR"), "10", "2025-02-01T00:00:00.000Z");
  assert.equal(sanitized.proposal.state, "REDACTED_AT_BACKTEST_CUTOFF");
  assert.equal(sanitized.proposal.outcome, "REDACTED_AT_BACKTEST_CUTOFF");
  assert.equal(sanitized.proposal.forVotes, "0");
  assert.equal(sanitized.source.subgraphBlock, "10");
});

test("runs expanding-window holdouts and excludes same-block votes", () => {
  const report = runChronologicalBacktest(history(), {
    minTrainingVotes: 2,
    generatedAt: AS_OF,
    minCalibrationSamples: 2,
  });
  assert.equal(report.summary.predictionCount, 6);
  assert.deepEqual(report.predictions.map((record) => record.trainingVoteCount), [2, 2, 4, 5, 6, 7]);
  assert.equal(report.predictions[0].onlineCalibrationEvidenceCount, 0);
  assert.equal(report.predictions[1].onlineCalibrationEvidenceCount, 0);
  assert.equal(report.methodology.sameBlockExcluded, true);
  assert.equal(report.methodology.finalOutcomeFieldsRedacted, true);
  assert.equal(report.calibrationModel.bins.length, 6);
  assert.equal(report.perClass.reduce((sum, metric) => sum + metric.actualCount, 0), 6);
  assert.equal(report.summary.majorityClass, "FOR");
  assert.ok(report.summary.majorityClassAccuracy >= 0 && report.summary.majorityClassAccuracy <= 1);
  assert.ok(report.summary.balancedAccuracy >= 0 && report.summary.balancedAccuracy <= 1);
  assert.ok(report.byCategory.some((metric) => metric.category === "PUBLIC_GOODS"));
});

test("online calibration uses only supplied prior outcomes", () => {
  const prior = [
    { rawConfidence: 0.75, correct: true },
    { rawConfidence: 0.76, correct: false },
    { rawConfidence: 0.65, correct: true },
  ];
  const calibrated = onlineCalibratedConfidence(0.74, prior, { priorStrength: 2 });
  assert.equal(calibrated.evidenceCount, 2);
  assert.equal(calibrated.correctCount, 1);
  assert.equal(bucketFor(0.74).index, 3);
  assert.ok(calibrated.confidence >= 0 && calibrated.confidence <= 1);
});

test("builds a future-use model and applies only eligible calibration buckets", () => {
  const results = [
    { rawConfidence: 0.72, correct: true },
    { rawConfidence: 0.75, correct: false },
    { rawConfidence: 0.78, correct: true },
  ];
  const eligibleModel = buildCalibrationModel(results, {
    priorStrength: 2,
    minSamplesPerBucket: 2,
    generatedAt: AS_OF,
  });
  const calibrated = applyCalibrationToPrediction(rawPrediction(0.75), eligibleModel);
  assert.equal(calibrated.confidenceCalibrated, true);
  assert.equal(calibrated.schemaVersion, "1.1.0");
  assert.equal(calibrated.rawConfidence, 0.75);
  assert.equal(calibrated.calibration.applied, true);
  assert.ok(calibrated.flags.some((flag) => /Confidence calibrated from 3 historical predictions/.test(flag)));
  assert.ok(calibrated.flags.every((flag) => !/has not yet been calibrated/.test(flag)));

  const ineligibleModel = buildCalibrationModel(results, {
    priorStrength: 2,
    minSamplesPerBucket: 10,
    generatedAt: AS_OF,
  });
  const unchanged = applyCalibrationToPrediction(rawPrediction(0.75), ineligibleModel);
  assert.equal(unchanged.confidenceCalibrated, false);
  assert.equal(unchanged.confidence, 0.75);
  assert.match(unchanged.calibration.reason, /requires 10 samples/);
});
