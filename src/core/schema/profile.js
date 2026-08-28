const { z } = require("zod");

const { Support } = require("./governance");

const ProfileCategory = Object.freeze({
  TREASURY: "TREASURY",
  PUBLIC_GOODS: "PUBLIC_GOODS",
  RECURRING_FUNDING: "RECURRING_FUNDING",
  RETROACTIVE_FUNDING: "RETROACTIVE_FUNDING",
  GOVERNANCE_UPGRADE: "GOVERNANCE_UPGRADE",
  PROTOCOL_DEVELOPMENT: "PROTOCOL_DEVELOPMENT",
  MARKETING: "MARKETING",
  EVENTS: "EVENTS",
  EXPERIMENTAL: "EXPERIMENTAL",
  AUCTION: "AUCTION",
  OTHER: "OTHER",
});

const supportSchema = z.enum(Object.values(Support));
const categorySchema = z.enum(Object.values(ProfileCategory));
const decimalStringSchema = z.string().regex(/^\d+$/, "expected an unsigned integer string");
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an EVM address");
const identifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const supportCountsSchema = z.object({
  AGAINST: z.number().int().nonnegative(),
  FOR: z.number().int().nonnegative(),
  ABSTAIN: z.number().int().nonnegative(),
});
const weightedSupportSchema = z.object({
  AGAINST: z.number().finite().nonnegative(),
  FOR: z.number().finite().nonnegative(),
  ABSTAIN: z.number().finite().nonnegative(),
});

const statedPreferenceSchema = z.object({
  id: identifierSchema,
  statement: z.string().min(1).max(2000),
  createdAt: z.string().datetime(),
  active: z.boolean().default(true),
  categories: z.array(categorySchema).default([]),
  recommendation: supportSchema.optional(),
});

const hardRuleConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("category"), categories: z.array(categorySchema).min(1) }),
  z.object({ type: z.literal("treasury-transfer-above"), thresholdWei: decimalStringSchema }),
  z.object({ type: z.literal("recipient"), addresses: z.array(addressSchema).min(1) }),
]);

const hardRuleEffectSchema = z
  .object({
    recommendation: supportSchema.optional(),
    flag: z.string().min(1).max(500).optional(),
    blockAutonomy: z.boolean().default(false),
  })
  .refine(
    (effect) => effect.recommendation || effect.flag || effect.blockAutonomy,
    "a hard rule must define at least one effect",
  );

const hardRuleSchema = z.object({
  id: identifierSchema,
  description: z.string().min(1).max(2000),
  createdAt: z.string().datetime(),
  enabled: z.boolean().default(true),
  condition: hardRuleConditionSchema,
  effect: hardRuleEffectSchema,
});

const categoryBehaviorSchema = z.object({
  category: categorySchema,
  voteCount: z.number().int().nonnegative(),
  weightedVoteCount: z.number().finite().nonnegative(),
  supportCounts: supportCountsSchema,
  weightedSupport: weightedSupportSchema,
  dominantSupport: supportSchema.nullable(),
  dominance: z.number().finite().min(0).max(1),
});

const tendencySchema = z.object({
  kind: z.literal("CATEGORY_SUPPORT"),
  category: categorySchema,
  support: supportSchema,
  evidenceCount: z.number().int().positive(),
  weightedEvidence: z.number().finite().positive(),
  strength: z.number().finite().min(0).max(1),
});

const precedentEvidenceSchema = z.object({
  proposalId: decimalStringSchema,
  proposalContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string(),
  support: supportSchema,
  timestamp: z.string().datetime(),
  recencyWeight: z.number().finite().min(0).max(1),
  categories: z.array(categorySchema).min(1),
  totalActionValueWei: decimalStringSchema,
  recipients: z.array(addressSchema),
  hasReason: z.boolean(),
});

const profileDocumentSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    dao: z.string().min(1),
    chainId: z.number().int().positive(),
    voter: addressSchema,
    generatedAt: z.string().datetime(),
    asOf: z.string().datetime(),
    sourceHistory: z.object({
      schemaVersion: z.string().min(1),
      generatedAt: z.string().datetime(),
      voteCount: z.number().int().nonnegative(),
      includedVoteCount: z.number().int().nonnegative(),
      excludedFutureVoteCount: z.number().int().nonnegative(),
      evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    }),
    recency: z.object({
      method: z.literal("exponential-half-life"),
      halfLifeDays: z.number().finite().positive(),
      formula: z.literal("weight = 0.5 ^ (ageDays / halfLifeDays)"),
    }),
    observedBehavior: z.object({
      voteCount: z.number().int().nonnegative(),
      weightedVoteCount: z.number().finite().nonnegative(),
      supportCounts: supportCountsSchema,
      weightedSupport: weightedSupportSchema,
      categories: z.array(categoryBehaviorSchema),
      tendencies: z.array(tendencySchema),
      precedentIndex: z.array(precedentEvidenceSchema),
      voice: z.object({
        reasonCount: z.number().int().nonnegative(),
        reasonCoverage: z.number().finite().min(0).max(1),
        medianWords: z.number().finite().nonnegative(),
        averageWords: z.number().finite().nonnegative(),
        typicalLength: z.enum(["NONE", "TERSE", "BRIEF", "DETAILED", "LONG"]),
        firstPersonRate: z.number().finite().min(0).max(1),
        caveatRate: z.number().finite().min(0).max(1),
        questionRate: z.number().finite().min(0).max(1),
        commonTerms: z.array(z.string().min(1)).max(20),
      }),
    }),
    statedPreferences: z.array(statedPreferenceSchema),
    hardRules: z.array(hardRuleSchema),
  })
  .superRefine((profile, context) => {
    const source = profile.sourceHistory;
    if (source.includedVoteCount + source.excludedFutureVoteCount !== source.voteCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceHistory"],
        message: "included and excluded source votes must equal voteCount",
      });
    }
    if (profile.observedBehavior.voteCount !== source.includedVoteCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedBehavior", "voteCount"],
        message: "observed voteCount must equal includedVoteCount",
      });
    }
    if (profile.observedBehavior.precedentIndex.length !== profile.observedBehavior.voteCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedBehavior", "precedentIndex"],
        message: "precedentIndex must contain one entry per observed vote",
      });
    }
  });

module.exports = {
  ProfileCategory,
  categorySchema,
  statedPreferenceSchema,
  hardRuleSchema,
  profileDocumentSchema,
};
