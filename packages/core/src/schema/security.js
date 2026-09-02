const { z } = require("zod");

const riskLevelSchema = z.enum(["CLEAR", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const severitySchema = z.enum(["INFO", "WARNING", "DANGER", "CRITICAL"]);
const decimalStringSchema = z.string().regex(/^\d+$/);
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const securityFlagSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]+$/),
  severity: severitySchema,
  actionIndex: z.number().int().nonnegative().nullable(),
  message: z.string().min(1),
});

const decodedArgumentSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  value: z.unknown(),
});

const inspectedActionSchema = z.object({
  index: z.number().int().nonnegative(),
  target: addressSchema,
  targetLabel: z.string().nullable(),
  valueWei: decimalStringSchema,
  kind: z.enum(["NO_OP", "NATIVE_TRANSFER", "CONTRACT_CALL", "UNKNOWN_CALL"]),
  decodeStatus: z.enum(["NOT_APPLICABLE", "DECODED", "UNKNOWN_SELECTOR", "DECODE_FAILED"]),
  selector: hexSchema.nullable(),
  functionSignature: z.string().nullable(),
  decodedArguments: z.array(decodedArgumentSchema),
  riskLevel: riskLevelSchema,
  flags: z.array(securityFlagSchema),
});

const mismatchSchema = z.object({
  code: z.enum(["NATIVE_VALUE_MISMATCH", "RECIPIENT_MISMATCH", "ASSET_MISMATCH"]),
  severity: severitySchema,
  message: z.string().min(1),
  proseClaim: z.string().min(1),
  executableFact: z.string().min(1),
});

const proposalSecurityReportSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  proposalId: decimalStringSchema,
  proposalContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  contentPolicy: z.object({
    classification: z.literal("UNTRUSTED_GOVERNANCE_CONTENT"),
    instructionHandling: z.literal("NEVER_FOLLOW"),
    detectedInstructionPatterns: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  }),
  sourceVerification: z.literal("STRUCTURED_INPUT_NOT_CHAIN_VERIFIED"),
  actions: z.array(inspectedActionSchema),
  mismatches: z.array(mismatchSchema),
  flags: z.array(securityFlagSchema),
  summary: z.object({
    riskLevel: riskLevelSchema,
    requiresHumanReview: z.boolean(),
    actionCount: z.number().int().nonnegative(),
    decodedActionCount: z.number().int().nonnegative(),
    unknownActionCount: z.number().int().nonnegative(),
    mismatchCount: z.number().int().nonnegative(),
  }),
});

module.exports = {
  proposalSecurityReportSchema,
  riskLevelSchema,
  securityFlagSchema,
};
