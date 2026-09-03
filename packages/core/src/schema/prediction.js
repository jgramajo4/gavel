const { z } = require("zod");

const { Support } = require("./governance");
const { proposalSecurityReportSchema } = require("./security");

const supportSchema = z.enum(Object.values(Support));
const boundedScore = z.number().finite().min(0).max(1);
const decimalStringSchema = z.string().regex(/^\d+$/, "expected an unsigned integer string");
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an EVM address");
const predictionReviewReasonSchema = z.enum([
  "OBSERVED_HEURISTIC_ADVISORY_ONLY",
  "BACKTEST_NOT_ATTACHED",
  "BACKTEST_DOES_NOT_BEAT_MAJORITY",
  "POLICY_BLOCKS_AUTONOMY",
]);

const predictionReviewSchema = z.object({
  requiresHumanReview: z.boolean(),
  autonomyAllowed: z.boolean(),
  reasonCodes: z.array(predictionReviewReasonSchema),
  backtest: z
    .object({
      reportGeneratedAt: z.string().datetime(),
      calibrationModelId: z.string().regex(/^[0-9a-f]{64}$/),
      predictionCount: z.number().int().nonnegative(),
      accuracy: boundedScore.nullable(),
      majorityClassAccuracy: boundedScore.nullable(),
      accuracyLiftOverMajority: z.number().finite().min(-1).max(1).nullable(),
      balancedAccuracy: boundedScore.nullable(),
    })
    .nullable(),
});

const precedentSchema = z.object({
  proposalId: decimalStringSchema,
  title: z.string(),
  vote: supportSchema,
  timestamp: z.string().datetime(),
  similarity: boundedScore,
  evidenceWeight: boundedScore,
  signals: z.object({
    category: boundedScore,
    amount: boundedScore,
    recipient: boundedScore.nullable(),
    title: boundedScore,
    recency: boundedScore,
  }),
});

const predictionDocumentSchema = z
  .object({
    schemaVersion: z.enum(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]),
    generatedAt: z.string().datetime(),
    asOf: z.string().datetime(),
    dao: z.string().min(1),
    chainId: z.number().int().positive(),
    voter: addressSchema,
    proposalId: decimalStringSchema,
    proposalContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    recommendation: supportSchema,
    confidence: boundedScore,
    rawConfidence: boundedScore.optional(),
    confidencePercent: z.number().int().min(0).max(100),
    confidenceCalibrated: z.boolean(),
    confidenceKind: z
      .enum(["HEURISTIC_SCORE", "CALIBRATED_CORRECTNESS_ESTIMATE", "POLICY_OVERRIDE_SCORE"])
      .optional(),
    calibration: z
      .object({
        applied: z.boolean(),
        modelId: z.string().regex(/^[0-9a-f]{64}$/),
        bucketIndex: z.number().int().nonnegative(),
        sampleCount: z.number().int().nonnegative(),
        reason: z.string().min(1).nullable(),
      })
      .optional(),
    policySource: z.enum(["OBSERVED_BEHAVIOR", "STATED_PREFERENCE", "HARD_RULE"]),
    policySourceId: z.string().nullable(),
    precedents: z.array(precedentSchema).max(5),
    reasoning: z.array(z.string().min(1)),
    flags: z.array(z.string().min(1)),
    predictionReview: predictionReviewSchema.optional(),
    security: proposalSecurityReportSchema.optional(),
    draftReason: z.object({
      isDraft: z.literal(true),
      available: z.boolean(),
      text: z.string().min(1).nullable(),
      basis: z.enum(["PROFILE_STYLE_TEMPLATE", "INSUFFICIENT_EVIDENCE"]),
    }),
    evidence: z.object({
      profileVoteCount: z.number().int().nonnegative(),
      candidatePrecedentCount: z.number().int().nonnegative(),
      relevantPrecedentCount: z.number().int().nonnegative(),
      supportScores: z.object({
        AGAINST: boundedScore,
        FOR: boundedScore,
        ABSTAIN: boundedScore,
      }),
      confidenceBreakdown: z.object({
        margin: boundedScore,
        similarity: boundedScore,
        sufficiency: boundedScore,
        recency: boundedScore,
        historyDepth: boundedScore,
        policyOverride: boundedScore,
      }),
    }),
    method: z.object({
      name: z.literal("gavel-evidence-heuristic"),
      version: z.literal("1.0.0"),
      calibrated: z.boolean(),
      relevantSimilarityThreshold: boundedScore,
      maxScoredPrecedents: z.number().int().positive(),
    }),
  })
  .superRefine((prediction, context) => {
    if (prediction.schemaVersion === "1.3.0" && (!prediction.confidenceKind || !prediction.predictionReview)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["predictionReview"],
        message: "v1.3 predictions require confidenceKind and predictionReview",
      });
    }
    if (prediction.confidencePercent !== Math.round(prediction.confidence * 100)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidencePercent"],
        message: "confidencePercent must be the rounded confidence",
      });
    }
    if (prediction.draftReason.available !== Boolean(prediction.draftReason.text)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["draftReason"],
        message: "draft availability must match the presence of text",
      });
    }
    const total = Object.values(prediction.evidence.supportScores).reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > 0.000001) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "supportScores"],
        message: "support scores must sum to 1",
      });
    }
    if (prediction.confidenceCalibrated) {
      if (
        prediction.schemaVersion === "1.0.0" ||
        prediction.rawConfidence === undefined ||
        !prediction.calibration?.applied ||
        !prediction.method.calibrated
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["confidenceCalibrated"],
          message: "calibrated predictions require v1.1 metadata and rawConfidence",
        });
      }
    } else if (prediction.method.calibrated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method", "calibrated"],
        message: "method cannot be calibrated when confidenceCalibrated is false",
      });
    }
    if (prediction.confidenceKind === "CALIBRATED_CORRECTNESS_ESTIMATE" && !prediction.confidenceCalibrated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confidenceKind"],
        message: "calibrated correctness estimates require confidenceCalibrated",
      });
    }
    if (prediction.predictionReview?.autonomyAllowed && prediction.predictionReview.requiresHumanReview) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["predictionReview"],
        message: "autonomy cannot be allowed while human review is required",
      });
    }
  });

module.exports = {
  predictionDocumentSchema,
  predictionReviewReasonSchema,
  predictionReviewSchema,
  precedentSchema,
};
