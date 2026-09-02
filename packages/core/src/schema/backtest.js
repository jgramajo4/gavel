const { z } = require("zod");

const { Support } = require("./governance");
const { ProfileCategory } = require("./profile");

const supportSchema = z.enum(Object.values(Support));
const categorySchema = z.enum(Object.values(ProfileCategory));
const boundedScore = z.number().finite().min(0).max(1);
const nullableScore = boundedScore.nullable();

const calibrationBinSchema = z.object({
  index: z.number().int().nonnegative(),
  lowerInclusive: boundedScore,
  upperExclusive: boundedScore,
  sampleCount: z.number().int().nonnegative(),
  correctCount: z.number().int().nonnegative(),
  meanRawConfidence: boundedScore,
  empiricalAccuracy: nullableScore,
  recommendedConfidence: boundedScore,
  eligible: z.boolean(),
});

const calibrationModelSchema = z.object({
  method: z.literal("fixed-bucket-beta-shrinkage"),
  version: z.literal("1.0.0"),
  generatedAt: z.string().datetime(),
  modelId: z.string().regex(/^[0-9a-f]{64}$/),
  priorStrength: z.number().finite().nonnegative(),
  minSamplesPerBucket: z.number().int().positive(),
  bins: z.array(calibrationBinSchema).min(1),
});

const metricSliceSchema = z.object({
  count: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  accuracy: nullableScore,
});

const backtestRecordSchema = z.object({
  proposalId: z.string().regex(/^\d+$/),
  blockNumber: z.string().regex(/^\d+$/),
  timestamp: z.string().datetime(),
  trainingVoteCount: z.number().int().nonnegative(),
  actual: supportSchema,
  predicted: supportSchema,
  correct: z.boolean(),
  rawConfidence: boundedScore,
  onlineCalibratedConfidence: boundedScore,
  onlineCalibrationEvidenceCount: z.number().int().nonnegative(),
  categories: z.array(categorySchema).min(1),
  relevantPrecedentCount: z.number().int().nonnegative(),
  confidenceMargin: boundedScore,
  precedentSimilarity: boundedScore,
});

const backtestReportSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    generatedAt: z.string().datetime(),
    dao: z.string().min(1),
    chainId: z.number().int().positive(),
    voter: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    sourceHistory: z.object({
      schemaVersion: z.string().min(1),
      generatedAt: z.string().datetime(),
      voteCount: z.number().int().nonnegative(),
    }),
    methodology: z.object({
      split: z.literal("expanding-window-strictly-earlier-blocks"),
      minTrainingVotes: z.number().int().nonnegative(),
      sameBlockExcluded: z.literal(true),
      finalOutcomeFieldsRedacted: z.literal(true),
      onlineCalibrationUsesPriorPredictionsOnly: z.literal(true),
      confidenceHighThreshold: boundedScore,
    }),
    summary: z.object({
      predictionCount: z.number().int().nonnegative(),
      correctCount: z.number().int().nonnegative(),
      accuracy: nullableScore,
      majorityClass: supportSchema.nullable(),
      majorityClassCount: z.number().int().nonnegative(),
      majorityClassAccuracy: nullableScore,
      accuracyLiftOverMajority: z.number().finite().min(-1).max(1).nullable(),
      balancedAccuracy: nullableScore,
      rawBrierScore: nullableScore,
      onlineCalibratedBrierScore: nullableScore,
      rawExpectedCalibrationError: nullableScore,
      highConfidence: metricSliceSchema,
    }),
    perClass: z.array(
      z.object({
        support: supportSchema,
        actualCount: z.number().int().nonnegative(),
        correctCount: z.number().int().nonnegative(),
        recall: nullableScore,
        predictedCount: z.number().int().nonnegative(),
        precision: nullableScore,
      }),
    ),
    confusionMatrix: z.record(z.record(z.number().int().nonnegative())),
    byCategory: z.array(z.object({ category: categorySchema }).merge(metricSliceSchema)),
    byYear: z.array(z.object({ year: z.number().int() }).merge(metricSliceSchema)),
    confidenceBuckets: z.array(calibrationBinSchema),
    failureModes: z.array(
      z.object({
        code: z.string().min(1),
        count: z.number().int().nonnegative(),
        rate: boundedScore,
        exampleProposalIds: z.array(z.string().regex(/^\d+$/)).max(5),
      }),
    ),
    calibrationModel: calibrationModelSchema,
    predictions: z.array(backtestRecordSchema),
  })
  .superRefine((report, context) => {
    if (report.summary.predictionCount !== report.predictions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "predictionCount"],
        message: "predictionCount must equal predictions.length",
      });
    }
    if (report.summary.correctCount !== report.predictions.filter((record) => record.correct).length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["summary", "correctCount"],
        message: "correctCount must equal correct prediction records",
      });
    }
  });

module.exports = {
  backtestRecordSchema,
  backtestReportSchema,
  calibrationBinSchema,
  calibrationModelSchema,
};
