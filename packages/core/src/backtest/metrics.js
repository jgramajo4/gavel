const { Support } = require("../schema/governance");

const SUPPORT_VALUES = Object.values(Support);

function rounded(value) {
  return Number(value.toFixed(12));
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : rounded(numerator / denominator);
}

function metricSlice(records) {
  const correct = records.filter((record) => record.correct).length;
  return { count: records.length, correct, accuracy: ratio(correct, records.length) };
}

function perClassMetrics(records) {
  return SUPPORT_VALUES.map((support) => {
    const actual = records.filter((record) => record.actual === support);
    const predicted = records.filter((record) => record.predicted === support);
    const correctCount = actual.filter((record) => record.predicted === support).length;
    return {
      support,
      actualCount: actual.length,
      correctCount,
      recall: ratio(correctCount, actual.length),
      predictedCount: predicted.length,
      precision: ratio(correctCount, predicted.length),
    };
  });
}

function confusionMatrix(records) {
  return Object.fromEntries(
    SUPPORT_VALUES.map((actual) => [
      actual,
      Object.fromEntries(
        SUPPORT_VALUES.map((predicted) => [
          predicted,
          records.filter((record) => record.actual === actual && record.predicted === predicted).length,
        ]),
      ),
    ]),
  );
}

function categoryMetrics(records) {
  const categories = [...new Set(records.flatMap((record) => record.categories))].sort();
  return categories
    .map((category) => ({ category, ...metricSlice(records.filter((record) => record.categories.includes(category))) }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function yearlyMetrics(records) {
  const years = [...new Set(records.map((record) => new Date(record.timestamp).getUTCFullYear()))].sort();
  return years.map((year) => ({
    year,
    ...metricSlice(records.filter((record) => new Date(record.timestamp).getUTCFullYear() === year)),
  }));
}

function brierScore(records, selector) {
  if (records.length === 0) return null;
  return rounded(
    records.reduce((sum, record) => sum + (selector(record) - (record.correct ? 1 : 0)) ** 2, 0) /
      records.length,
  );
}

function expectedCalibrationError(calibrationBins, predictionCount) {
  if (predictionCount === 0) return null;
  return rounded(
    calibrationBins.reduce((sum, bin) => {
      if (bin.sampleCount === 0 || bin.empiricalAccuracy === null) return sum;
      return sum +
        (bin.sampleCount / predictionCount) * Math.abs(bin.empiricalAccuracy - bin.meanRawConfidence);
    }, 0),
  );
}

function failureModes(records) {
  const failures = records.filter((record) => !record.correct);
  const definitions = [
    ["NO_RELEVANT_PRECEDENT", (record) => record.relevantPrecedentCount === 0],
    ["LOW_SCORE_MARGIN", (record) => record.confidenceMargin < 0.1],
    ["WEAK_PRECEDENT_SIMILARITY", (record) => record.precedentSimilarity < 0.3],
    ["ABSTAIN_CONFUSION", (record) => record.actual === Support.ABSTAIN || record.predicted === Support.ABSTAIN],
    ["HIGH_CONFIDENCE_ERROR", (record) => record.rawConfidence >= 0.9],
  ];
  return definitions
    .map(([code, predicate]) => {
      const matching = failures.filter(predicate);
      return {
        code,
        count: matching.length,
        rate: failures.length === 0 ? 0 : rounded(matching.length / failures.length),
        exampleProposalIds: matching.slice(0, 5).map((record) => record.proposalId),
      };
    })
    .filter((failure) => failure.count > 0)
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function buildMetrics(records, calibrationModel, highConfidenceThreshold = 0.9) {
  const summary = metricSlice(records);
  const perClass = perClassMetrics(records);
  const majority = [...perClass].sort(
    (a, b) => b.actualCount - a.actualCount || a.support.localeCompare(b.support),
  )[0];
  const majorityClassAccuracy = ratio(majority.actualCount, records.length);
  const recalls = perClass.filter((metric) => metric.recall !== null).map((metric) => metric.recall);
  const balancedAccuracy =
    recalls.length === 0 ? null : rounded(recalls.reduce((sum, recall) => sum + recall, 0) / recalls.length);
  const highConfidence = metricSlice(
    records.filter((record) => record.rawConfidence >= highConfidenceThreshold),
  );
  return {
    summary: {
      predictionCount: summary.count,
      correctCount: summary.correct,
      accuracy: summary.accuracy,
      majorityClass: records.length === 0 ? null : majority.support,
      majorityClassCount: records.length === 0 ? 0 : majority.actualCount,
      majorityClassAccuracy,
      accuracyLiftOverMajority:
        summary.accuracy === null || majorityClassAccuracy === null
          ? null
          : rounded(summary.accuracy - majorityClassAccuracy),
      balancedAccuracy,
      rawBrierScore: brierScore(records, (record) => record.rawConfidence),
      onlineCalibratedBrierScore: brierScore(records, (record) => record.onlineCalibratedConfidence),
      rawExpectedCalibrationError: expectedCalibrationError(calibrationModel.bins, records.length),
      highConfidence,
    },
    perClass,
    confusionMatrix: confusionMatrix(records),
    byCategory: categoryMetrics(records),
    byYear: yearlyMetrics(records),
    failureModes: failureModes(records),
  };
}

module.exports = {
  brierScore,
  buildMetrics,
  categoryMetrics,
  confusionMatrix,
  expectedCalibrationError,
  failureModes,
  metricSlice,
  perClassMetrics,
  ratio,
  yearlyMetrics,
};
