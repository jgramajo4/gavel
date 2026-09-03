const { z } = require("zod");

const ExecutionMode = Object.freeze({
  UNSIGNED: "unsigned",
  SAFE_SUPERVISED: "safe-supervised",
  WAAP_AUTONOMOUS: "waap-autonomous",
});

const ExecutionStatus = Object.freeze({
  PREPARED: "PREPARED",
  PROPOSED: "PROPOSED",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  READY_TO_EXECUTE: "READY_TO_EXECUTE",
  EXECUTED: "EXECUTED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED",
  BLOCKED: "BLOCKED",
});

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const decimalStringSchema = z.string().regex(/^\d+$/);
const hexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);

const addressRolesSchema = z.object({
  modelAddress: addressSchema,
  assetOwnerAddress: addressSchema.nullable(),
  currentDelegateAddress: addressSchema.nullable(),
  executionAddress: addressSchema,
  requiredDelegateAddress: addressSchema,
});

const preparedGovernanceTransactionSchema = z
  .object({
    schemaVersion: z.enum(["1.0.0", "1.1.0"]),
    kind: z.literal("PREPARED_GOVERNANCE_TRANSACTION"),
    adapter: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    action: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    chainId: z.number().int().positive(),
    target: addressSchema,
    calldata: hexSchema,
    value: decimalStringSchema,
    proposalId: decimalStringSchema.nullable(),
    support: z.enum(["FOR", "AGAINST", "ABSTAIN"]).nullable(),
    reason: z.string().nullable(),
    executionAddress: addressSchema,
    autonomyAllowed: z.boolean().optional(),
    validated: z.literal(true),
    validatedAt: z.string().datetime(),
    intentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .superRefine((document, context) => {
    if (document.schemaVersion === "1.1.0" && document.autonomyAllowed === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autonomyAllowed"],
        message: "v1.1 prepared transactions require an explicit autonomy decision",
      });
    }
  });

const executionResultSchema = z.object({
  executor: z.enum(Object.values(ExecutionMode)),
  status: z.enum(Object.values(ExecutionStatus)),
  executionId: z.string().min(1).nullable(),
  intentHash: z.string().regex(/^[0-9a-f]{64}$/),
  transactionHash: hexSchema.nullable().optional(),
});

module.exports = {
  ExecutionMode,
  ExecutionStatus,
  addressSchema,
  addressRolesSchema,
  preparedGovernanceTransactionSchema,
  executionResultSchema,
};
