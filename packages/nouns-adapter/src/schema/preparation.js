const { z } = require("zod");

const { Support } = require("../../../core/src/schema/governance");
const { securityFlagSchema } = require("../../../core/src/schema/security");
const { addressRolesSchema } = require("../../../core/src/schema/execution");

const decimalStringSchema = z.string().regex(/^\d+$/);
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const supportSchema = z.enum(Object.values(Support));

const blockerSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]+$/),
  message: z.string().min(1),
});

const votePreparationSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    generatedAt: z.string().datetime(),
    dao: z.literal("nouns"),
    chainId: z.literal(1),
    proposalId: decimalStringSchema,
    proposalContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    modelVoter: addressSchema,
    votingAddress: addressSchema,
    addressRoles: addressRolesSchema,
    recommendation: supportSchema,
    selectedSupport: supportSchema,
    confidencePercent: z.number().int().min(0).max(100),
    policySource: z.enum(["OBSERVED_BEHAVIOR", "STATED_PREFERENCE", "HARD_RULE"]),
    policySourceId: z.string().nullable(),
    reason: z.object({
      text: z.string().min(1),
      source: z.enum(["PREDICTION_DRAFT", "USER_CONFIRMED"]),
    }),
    flags: z.array(z.string().min(1)),
    security: z.object({
      riskLevel: z.enum(["CLEAR", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      requiresHumanReview: z.boolean(),
      reviewAcknowledged: z.boolean(),
      flags: z.array(securityFlagSchema),
    }),
    verification: z.object({
      checkedAtBlock: decimalStringSchema,
      governanceAddress: addressSchema,
      nounsTokenAddress: addressSchema,
      governanceCodePresent: z.boolean(),
      nounsTokenCodePresent: z.boolean(),
      proposalState: z.object({
        code: z.number().int().min(0).max(255),
        label: z.string().min(1),
        active: z.boolean(),
      }),
      proposalIdentityMatches: z.boolean(),
      votingWindowMatches: z.boolean(),
      executableActionsMatch: z.boolean(),
      freshness: z.object({
        verifiedFromCanonicalEvents: z.boolean(),
        descriptionMatches: z.boolean(),
        version: z.number().int().positive().nullable(),
        latestEvent: z.string().min(1).nullable(),
        latestBlock: decimalStringSchema.nullable(),
        eventDigest: hexSchema.nullable(),
      }),
      receipt: z.object({
        hasVoted: z.boolean(),
        support: z.number().int().min(0).max(255),
        votes: decimalStringSchema,
      }),
      votingPower: z.object({
        snapshotBlock: decimalStringSchema,
        votes: decimalStringSchema,
        eligible: z.boolean(),
      }),
      delegation: z.object({
        modelVoterDelegatee: addressSchema,
        assetOwnerAddress: addressSchema,
        currentDelegateAddress: addressSchema,
        requiredDelegateAddress: addressSchema,
        matchesVotingAddress: z.boolean(),
      }),
      simulation: z.object({
        attempted: z.boolean(),
        succeeded: z.boolean(),
        estimatedGas: decimalStringSchema.nullable(),
      }),
    }),
    status: z.enum(["READY_TO_SIGN", "BLOCKED"]),
    blockers: z.array(blockerSchema),
    transaction: z
      .object({
        kind: z.literal("UNSIGNED_EVM_TRANSACTION"),
        from: addressSchema,
        to: addressSchema,
        chainId: z.literal(1),
        value: z.literal("0"),
        data: hexSchema,
        function: z.literal("castRefundableVoteWithReason(uint256,uint8,string,uint32)"),
      })
      .nullable(),
    attribution: z.object({
      appliedInternally: z.literal(true),
      clientId: z.number().int().min(0).max(0xffffffff),
    }),
  })
  .superRefine((document, context) => {
    const ready = document.status === "READY_TO_SIGN";
    if (ready !== (document.transaction !== null) || ready !== (document.blockers.length === 0)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "only an unblocked preparation may contain an unsigned transaction",
      });
    }
    if (document.security.requiresHumanReview && !document.security.reviewAcknowledged && ready) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["security", "reviewAcknowledged"],
        message: "human-review security findings must be acknowledged before preparation",
      });
    }
  });

module.exports = { votePreparationSchema, blockerSchema };
