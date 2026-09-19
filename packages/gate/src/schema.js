const { z } = require('zod');
const {
  AVAILABILITY,
  NORMALIZED_LIFECYCLES,
  NOUNS_QUOTE_ISSUANCE_STAGES,
  MIN_ATTENTION_AMOUNT,
  MAX_PITCH_CODE_POINTS,
  MAX_DISCLOSURE_CODE_POINTS,
  MAX_EVIDENCE_URLS,
} = require('./constants');

const losslessUnsignedIntegerSchema = z.union([
  z.bigint().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/).transform((value) => BigInt(value)),
]);

const codePointLimitedString = (maximum, label) => z.string().superRefine((value, context) => {
  if (Array.from(value).length > maximum) {
    context.addIssue({
      code: z.ZodIssueCode.too_big,
      maximum,
      inclusive: true,
      type: 'array',
      message: `${label} must contain at most ${maximum} Unicode code points`,
    });
  }
});

const httpsUrlSchema = z.string().superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence URL must be an absolute HTTPS URL' });
  }
});

const targetIdSchema = z.string().regex(/^(proposal:(0|[1-9][0-9]*)|candidate:0x[0-9a-f]{40}:0x[0-9a-f]{64})$/);

const submissionSchema = z.object({
  payer: z.string(),
  signedSender: z.string(),
  voter: z.string(),
  dao: z.string().min(1),
  proposalId: losslessUnsignedIntegerSchema.optional(),
  targetId: targetIdSchema.optional(),
  stage: z.enum(NORMALIZED_LIFECYCLES),
  position: z.string().min(1),
  pitch: codePointLimitedString(MAX_PITCH_CODE_POINTS, 'pitch'),
  disclosures: codePointLimitedString(MAX_DISCLOSURE_CODE_POINTS, 'disclosures'),
  evidenceUrls: z.array(httpsUrlSchema).max(MAX_EVIDENCE_URLS),
}).strict().superRefine((value, context) => {
  if ((value.proposalId === undefined) === (value.targetId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'exactly one target identity is required' });
  }
  if (value.targetId?.startsWith('candidate:') && (value.stage !== 'PRE_VOTE' || value.position !== 'SPONSOR')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'candidate submissions must request PRE_VOTE sponsorship' });
  }
});

const daoPolicySchema = z.object({
  dao: z.literal('nouns'),
  daoChainId: z.literal(1),
  enabled: z.boolean(),
  availability: z.enum(AVAILABILITY),
  attentionAmount: losslessUnsignedIntegerSchema.refine(
    (amount) => amount >= MIN_ATTENTION_AMOUNT,
    `attentionAmount must be at least ${MIN_ATTENTION_AMOUNT}`,
  ),
  acceptedStages: z.array(z.enum(NOUNS_QUOTE_ISSUANCE_STAGES)).nonempty(),
}).strict();

function createDaoPolicySchema() {
  return daoPolicySchema;
}

function validateDaoPolicy(input) {
  return daoPolicySchema.parse(input);
}

function serializeDaoPolicy(input) {
  const policy = validateDaoPolicy(input);
  return {
    dao: policy.dao,
    daoChainId: policy.daoChainId,
    enabled: policy.enabled,
    availability: policy.availability,
    attentionAmount: policy.attentionAmount.toString(10),
    acceptedStages: policy.acceptedStages,
  };
}

module.exports = {
  losslessUnsignedIntegerSchema,
  httpsUrlSchema,
  targetIdSchema,
  submissionSchema,
  createDaoPolicySchema,
  validateDaoPolicy,
  serializeDaoPolicy,
};
