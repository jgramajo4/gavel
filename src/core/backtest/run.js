const { buildVoterProfile } = require("../profile/build");
const { extractProposalFacts } = require("../profile/features");
const { predictVote } = require("../predict/predict");
const { backtestReportSchema } = require("../schema/backtest");
const { historyDocumentSchema } = require("../schema/governance");
const { buildCalibrationModel, onlineCalibratedConfidence } = require("./calibration");
const { compareVotes } = require("./chronology");
const { buildMetrics } = require("./metrics");

function sanitizeTrainingVote(vote, cutoffBlock, queriedAt) {
  return {
    ...vote,
    proposal: {
      ...vote.proposal,
      state: "REDACTED_AT_BACKTEST_CUTOFF",
      outcome: "REDACTED_AT_BACKTEST_CUTOFF",
      forVotes: "0",
      againstVotes: "0",
      abstainVotes: "0",
    },
    source: {
      ...vote.source,
      subgraphBlock: cutoffBlock,
      queriedAt,
    },
  };
}

function trainingHistory(history, votes, target) {
  const cutoffBlock = votes.length === 0 ? "0" : votes[votes.length - 1].blockNumber;
  return {
    ...history,
    generatedAt: target.timestamp,
    source: { ...history.source, subgraphBlock: cutoffBlock },
    voteCount: votes.length,
    votes: votes.map((vote) => sanitizeTrainingVote(vote, cutoffBlock, target.timestamp)),
  };
}

function groupByBlock(votes) {
  const groups = [];
  for (const vote of [...votes].sort(compareVotes)) {
    const current = groups[groups.length - 1];
    if (!current || current[0].blockNumber !== vote.blockNumber) groups.push([vote]);
    else current.push(vote);
  }
  return groups;
}

function runChronologicalBacktest(historyInput, options = {}) {
  const history = historyDocumentSchema.parse(historyInput);
  const minTrainingVotes = options.minTrainingVotes ?? 25;
  const highConfidenceThreshold = options.highConfidenceThreshold ?? 0.9;
  const calibrationPriorStrength = options.calibrationPriorStrength ?? 10;
  const minCalibrationSamples = options.minCalibrationSamples ?? 20;
  const generatedAt = new Date(options.generatedAt || new Date()).toISOString();
  if (!Number.isInteger(minTrainingVotes) || minTrainingVotes < 0) {
    throw new RangeError("minTrainingVotes must be a non-negative integer");
  }
  if (!Number.isFinite(highConfidenceThreshold) || highConfidenceThreshold < 0 || highConfidenceThreshold > 1) {
    throw new RangeError("highConfidenceThreshold must be between 0 and 1");
  }

  const records = [];
  const trainingVotes = [];
  for (const blockGroup of groupByBlock(history.votes)) {
    const groupRecords = [];
    if (trainingVotes.length >= minTrainingVotes) {
      for (const target of blockGroup) {
        const pointInTimeHistory = trainingHistory(history, trainingVotes, target);
        const profile = buildVoterProfile(pointInTimeHistory, {
          asOf: target.timestamp,
          generatedAt: target.timestamp,
          halfLifeDays: options.halfLifeDays,
          statedPreferences: options.statedPreferences,
          hardRules: options.hardRules,
        });
        const prediction = predictVote(profile, target.proposal, {
          asOf: target.timestamp,
          generatedAt: target.timestamp,
          relevantSimilarityThreshold: options.relevantSimilarityThreshold,
          maxPrecedents: options.maxPrecedents,
        });
        const correct = prediction.recommendation === target.support;
        // Only records from strictly earlier blocks are visible to calibration.
        const online = onlineCalibratedConfidence(prediction.confidence, records, {
          priorStrength: calibrationPriorStrength,
        });
        groupRecords.push({
          proposalId: target.proposalId,
          blockNumber: target.blockNumber,
          timestamp: target.timestamp,
          trainingVoteCount: trainingVotes.length,
          actual: target.support,
          predicted: prediction.recommendation,
          correct,
          rawConfidence: prediction.confidence,
          onlineCalibratedConfidence: online.confidence,
          onlineCalibrationEvidenceCount: online.evidenceCount,
          categories: extractProposalFacts(target.proposal).categories,
          relevantPrecedentCount: prediction.evidence.relevantPrecedentCount,
          confidenceMargin: prediction.evidence.confidenceBreakdown.margin,
          precedentSimilarity: prediction.evidence.confidenceBreakdown.similarity,
        });
      }
    }
    records.push(...groupRecords);
    trainingVotes.push(...blockGroup);
  }

  const calibrationModel = buildCalibrationModel(records, {
    priorStrength: calibrationPriorStrength,
    minSamplesPerBucket: minCalibrationSamples,
    generatedAt,
  });
  const metrics = buildMetrics(records, calibrationModel, highConfidenceThreshold);

  return backtestReportSchema.parse({
    schemaVersion: "1.0.0",
    generatedAt,
    dao: history.dao,
    chainId: history.chainId,
    voter: history.voter,
    sourceHistory: {
      schemaVersion: history.schemaVersion,
      generatedAt: history.generatedAt,
      voteCount: history.voteCount,
    },
    methodology: {
      split: "expanding-window-strictly-earlier-blocks",
      minTrainingVotes,
      sameBlockExcluded: true,
      finalOutcomeFieldsRedacted: true,
      onlineCalibrationUsesPriorPredictionsOnly: true,
      confidenceHighThreshold: highConfidenceThreshold,
    },
    summary: metrics.summary,
    perClass: metrics.perClass,
    confusionMatrix: metrics.confusionMatrix,
    byCategory: metrics.byCategory,
    byYear: metrics.byYear,
    confidenceBuckets: calibrationModel.bins,
    failureModes: metrics.failureModes,
    calibrationModel,
    predictions: records,
  });
}

module.exports = {
  groupByBlock,
  runChronologicalBacktest,
  sanitizeTrainingVote,
  trainingHistory,
};
