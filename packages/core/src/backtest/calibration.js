const crypto = require("node:crypto");

const { predictionDocumentSchema } = require("../schema/prediction");
const { calibrationModelSchema } = require("../schema/backtest");

const DEFAULT_BUCKETS = Object.freeze([
  [0, 0.5],
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, 0.9],
  [0.9, 1],
]);

function rounded(value) {
  return Number(value.toFixed(12));
}

function bucketFor(confidence, buckets = DEFAULT_BUCKETS) {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError("confidence must be between 0 and 1");
  }
  const index = buckets.findIndex(
    ([lower, upper], candidateIndex) =>
      confidence >= lower && (confidence < upper || (candidateIndex === buckets.length - 1 && confidence <= upper)),
  );
  if (index < 0) throw new Error(`No calibration bucket covers confidence ${confidence}`);
  return { index, lowerInclusive: buckets[index][0], upperExclusive: buckets[index][1] };
}

function onlineCalibratedConfidence(rawConfidence, priorResults, options = {}) {
  const priorStrength = options.priorStrength ?? 10;
  if (!Number.isFinite(priorStrength) || priorStrength < 0) {
    throw new RangeError("priorStrength must be a non-negative finite number");
  }
  const bucket = bucketFor(rawConfidence, options.buckets);
  const matching = priorResults.filter(
    (result) => bucketFor(result.rawConfidence, options.buckets).index === bucket.index,
  );
  const correct = matching.filter((result) => result.correct).length;
  const calibrated = (correct + priorStrength * rawConfidence) / (matching.length + priorStrength || 1);
  return {
    confidence: rounded(calibrated),
    evidenceCount: matching.length,
    correctCount: correct,
    bucket,
  };
}

function buildCalibrationModel(results, options = {}) {
  const priorStrength = options.priorStrength ?? 10;
  const minSamplesPerBucket = options.minSamplesPerBucket ?? 20;
  const generatedAt = new Date(options.generatedAt || new Date()).toISOString();
  if (!Number.isInteger(minSamplesPerBucket) || minSamplesPerBucket < 1) {
    throw new RangeError("minSamplesPerBucket must be a positive integer");
  }

  const bins = DEFAULT_BUCKETS.map(([lowerInclusive, upperExclusive], index) => {
    const matching = results.filter((result) => bucketFor(result.rawConfidence).index === index);
    const correctCount = matching.filter((result) => result.correct).length;
    const meanRawConfidence =
      matching.length === 0
        ? (lowerInclusive + upperExclusive) / 2
        : matching.reduce((sum, result) => sum + result.rawConfidence, 0) / matching.length;
    const empiricalAccuracy = matching.length === 0 ? null : correctCount / matching.length;
    const recommendedConfidence =
      (correctCount + priorStrength * meanRawConfidence) / (matching.length + priorStrength);
    return {
      index,
      lowerInclusive,
      upperExclusive,
      sampleCount: matching.length,
      correctCount,
      meanRawConfidence: rounded(meanRawConfidence),
      empiricalAccuracy: empiricalAccuracy === null ? null : rounded(empiricalAccuracy),
      recommendedConfidence: rounded(recommendedConfidence),
      eligible: matching.length >= minSamplesPerBucket,
    };
  });

  const modelPayload = {
    method: "fixed-bucket-beta-shrinkage",
    version: "1.0.0",
    generatedAt,
    priorStrength,
    minSamplesPerBucket,
    bins,
  };
  const modelId = crypto.createHash("sha256").update(JSON.stringify(modelPayload)).digest("hex");
  return { ...modelPayload, modelId };
}

function applyCalibrationToPrediction(prediction, model) {
  const calibrationModel = calibrationModelSchema.parse(model);
  const rawConfidence = prediction.rawConfidence ?? prediction.confidence;
  const bucket = bucketFor(
    rawConfidence,
    calibrationModel.bins.map((bin) => [bin.lowerInclusive, bin.upperExclusive]),
  );
  const bin = calibrationModel.bins[bucket.index];
  if (!bin.eligible) {
    return predictionDocumentSchema.parse({
      ...prediction,
      rawConfidence,
      confidenceCalibrated: false,
      calibration: {
        applied: false,
        modelId: calibrationModel.modelId,
        bucketIndex: bin.index,
        sampleCount: bin.sampleCount,
        reason: `Calibration bucket requires ${calibrationModel.minSamplesPerBucket} samples`,
      },
    });
  }

  const confidence = bin.recommendedConfidence;
  return predictionDocumentSchema.parse({
    ...prediction,
    schemaVersion: prediction.schemaVersion === "1.2.0" ? "1.2.0" : "1.1.0",
    rawConfidence,
    confidence,
    confidencePercent: Math.round(confidence * 100),
    confidenceCalibrated: true,
    calibration: {
      applied: true,
      modelId: calibrationModel.modelId,
      bucketIndex: bin.index,
      sampleCount: bin.sampleCount,
      reason: null,
    },
    flags: [
      ...prediction.flags.filter((flag) => !/has not yet been calibrated/i.test(flag)),
      `Confidence calibrated from ${bin.sampleCount} historical predictions in this confidence bucket.`,
    ],
    method: { ...prediction.method, calibrated: true },
  });
}

module.exports = {
  DEFAULT_BUCKETS,
  applyCalibrationToPrediction,
  bucketFor,
  buildCalibrationModel,
  onlineCalibratedConfidence,
};
