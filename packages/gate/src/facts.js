const { getAddress } = require('ethers');
const { z } = require('zod');
const { losslessUnsignedIntegerSchema } = require('./schema');
const { CANONICAL_BASE_USDC_ADDRESS } = require('./constants');

const SUPPORTED_DECODER_VERSIONS = Object.freeze(['gate-facts/1']);
const decoderVersionSchema = z.enum(SUPPORTED_DECODER_VERSIONS);
const safeActionIndexSchema = z.number().int().nonnegative().safe();

const canonicalActionSchema = z.object({
  target: z.string(),
  valueWei: losslessUnsignedIntegerSchema,
  calldata: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  signature: z.string().optional().transform((signature) => signature ?? ''),
  actionIndex: safeActionIndexSchema,
}).strict();

const canonicalAddressSchema = z.string().superRefine((value, context) => {
  try {
    if (getAddress(value) !== value) throw new Error('noncanonical');
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'canonical evidence target must be an EIP-55 address',
    });
  }
});

const canonicalEvidenceSchema = z.object({
  actionIndex: safeActionIndexSchema,
  target: canonicalAddressSchema,
  valueWei: z.string().regex(/^(0|[1-9][0-9]*)$/),
  calldata: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  signature: z.string(),
}).strict();

const canonicalFactSchema = z.object({
  source: z.literal('canonical'),
  kind: z.literal('raw_action'),
  displayLabel: z.literal('Raw canonical action'),
  actionIndex: safeActionIndexSchema,
  target: canonicalAddressSchema,
  valueWei: z.string().regex(/^(0|[1-9][0-9]*)$/),
  calldata: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/),
  signature: z.string(),
  canonicalEvidence: canonicalEvidenceSchema,
}).strict();

const decodedFactSchema = z.discriminatedUnion('kind', [
  z.object({
    source: z.literal('decoded'),
    kind: z.literal('native_eth_transfer'),
    displayLabel: z.literal('Native ETH transfer'),
    decoderVersion: decoderVersionSchema,
    actionIndex: safeActionIndexSchema,
    canonicalEvidence: canonicalEvidenceSchema,
    amountWei: z.string().regex(/^[1-9][0-9]*$/),
    recipient: canonicalAddressSchema,
  }).strict(),
  z.object({
    source: z.literal('decoded'),
    kind: z.literal('usdc_transfer'),
    displayLabel: z.literal('USDC transfer'),
    decoderVersion: decoderVersionSchema,
    actionIndex: safeActionIndexSchema,
    canonicalEvidence: canonicalEvidenceSchema,
    token: z.literal(CANONICAL_BASE_USDC_ADDRESS),
    amountAtomic: z.string().regex(/^(0|[1-9][0-9]*)$/),
    recipient: canonicalAddressSchema,
  }).strict(),
]);

const factSchema = z.union([
  canonicalFactSchema,
  decodedFactSchema,
  z.object({
    source: z.literal('enriched'),
    displayLabel: z.string().min(1),
    verifiable: z.literal(false).optional(),
  }).passthrough(),
]).superRefine((fact, context) => {
  if (fact.source === 'canonical' && fact.kind === 'raw_action') {
    const actionIndexResult = safeActionIndexSchema.safeParse(fact.actionIndex);
    if (!actionIndexResult.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actionIndex'],
        message: 'raw action requires an actionIndex',
      });
    }

    const evidenceResult = canonicalEvidenceSchema.safeParse(fact.canonicalEvidence);
    if (!evidenceResult.success) {
      for (const issue of evidenceResult.error.issues) {
        context.addIssue({
          ...issue,
          path: ['canonicalEvidence', ...issue.path],
        });
      }
    } else {
      const evidence = evidenceResult.data;
      if (actionIndexResult.success && actionIndexResult.data !== evidence.actionIndex) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['canonicalEvidence', 'actionIndex'],
          message: 'raw action actionIndex must match canonical evidence actionIndex',
        });
      }

      for (const field of ['target', 'valueWei', 'calldata', 'signature']) {
        if (fact[field] !== evidence[field]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['canonicalEvidence', field],
            message: `raw action ${field} must match canonical evidence ${field}`,
          });
        }
      }
    }
  }

  if (fact.source === 'decoded' && fact.actionIndex !== fact.canonicalEvidence.actionIndex) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['canonicalEvidence', 'actionIndex'],
      message: 'decoded fact actionIndex must match canonical evidence actionIndex',
    });
  }

  if (fact.source === 'decoded' && fact.canonicalEvidence.signature !== '') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['canonicalEvidence', 'signature'],
      message: 'decoded fact canonical evidence signature must be empty',
    });
  }

  if (fact.source === 'decoded' && fact.kind === 'native_eth_transfer') {
    if (fact.recipient !== fact.canonicalEvidence.target) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalEvidence', 'target'],
        message: 'decoded fact recipient must match canonical evidence target',
      });
    }
    if (fact.amountWei !== fact.canonicalEvidence.valueWei) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalEvidence', 'valueWei'],
        message: 'decoded fact amountWei must match canonical evidence valueWei',
      });
    }
    if (fact.canonicalEvidence.calldata !== '0x') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalEvidence', 'calldata'],
        message: 'native ETH transfer canonical evidence calldata must be empty',
      });
    }
  }

  if (fact.source === 'decoded' && fact.kind === 'usdc_transfer') {
    const calldata = fact.canonicalEvidence.calldata.toLowerCase();
    const hasExactTransferShape = calldata.length === 138 && calldata.startsWith('0xa9059cbb');
    const recipientWord = hasExactTransferShape ? calldata.slice(10, 74) : '';
    const recipient = recipientWord.startsWith('0'.repeat(24))
      ? getAddress(`0x${recipientWord.slice(24)}`)
      : undefined;
    const amountAtomic = hasExactTransferShape
      ? BigInt(`0x${calldata.slice(74)}`).toString(10)
      : undefined;

    if (fact.canonicalEvidence.target !== CANONICAL_BASE_USDC_ADDRESS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalEvidence', 'target'],
        message: 'USDC transfer target must be canonical Base USDC',
      });
    }
    if (fact.canonicalEvidence.valueWei !== '0') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalEvidence', 'valueWei'],
        message: 'USDC transfer canonical evidence valueWei must be zero',
      });
    }
    if (recipient !== fact.recipient || amountAtomic !== fact.amountAtomic) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['canonicalEvidence', 'calldata'],
        message: 'decoded USDC fields must match canonical evidence calldata',
      });
    }
  }
});

function validateFact(input) {
  const result = factSchema.safeParse(input);
  if (!result.success && input?.source === 'enriched' && input?.verifiable === true) {
    throw new TypeError('enriched facts are display-only and cannot be marked verifiable');
  }
  return result.success ? result.data : factSchema.parse(input);
}

function requireVerificationFact(input) {
  const fact = validateFact(input);
  if (fact.source === 'enriched') {
    throw new TypeError('enriched facts are display-only and cannot be verification material');
  }
  return fact;
}

function serializeVerificationFact(input) {
  return JSON.stringify(requireVerificationFact(input));
}

function canonicalizeAction(input) {
  const parsed = canonicalActionSchema.parse(input);
  return {
    ...parsed,
    target: getAddress(parsed.target),
    valueWei: parsed.valueWei.toString(10),
  };
}

function evidenceFor(action) {
  return {
    actionIndex: action.actionIndex,
    target: action.target,
    valueWei: action.valueWei,
    calldata: action.calldata,
    signature: action.signature,
  };
}

function rawAction(action) {
  return {
    kind: 'raw_action',
    source: 'canonical',
    actionIndex: action.actionIndex,
    target: action.target,
    valueWei: action.valueWei,
    calldata: action.calldata,
    signature: action.signature,
    canonicalEvidence: evidenceFor(action),
    displayLabel: 'Raw canonical action',
  };
}

function decodeAction(input, options = {}) {
  const action = canonicalizeAction(input);
  const decoderVersionResult = decoderVersionSchema.safeParse(options.decoderVersion);
  if (!decoderVersionResult.success) {
    throw new TypeError(`unsupported decoderVersion: ${String(options.decoderVersion)}`);
  }
  const decoderVersion = decoderVersionResult.data;
  const hasEmptySignature = action.signature === undefined || action.signature === '';
  const canonicalUsdcAddress = options.canonicalUsdcAddress === undefined
    ? CANONICAL_BASE_USDC_ADDRESS
    : getAddress(options.canonicalUsdcAddress);
  if (canonicalUsdcAddress !== CANONICAL_BASE_USDC_ADDRESS) {
    throw new TypeError('canonicalUsdcAddress must equal the canonical Base USDC address');
  }

  if (BigInt(action.valueWei) > 0n && action.calldata === '0x' && hasEmptySignature) {
    if (action.actionIndex === undefined) {
      throw new TypeError('decoded facts require a canonical action index');
    }
    return {
      kind: 'native_eth_transfer',
      source: 'decoded',
      decoderVersion,
      actionIndex: action.actionIndex,
      canonicalEvidence: evidenceFor(action),
      displayLabel: 'Native ETH transfer',
      amountWei: action.valueWei,
      recipient: action.target,
    };
  }

  const calldata = action.calldata.toLowerCase();
  const hasExactTransferShape = calldata.length === 138 && calldata.startsWith('0xa9059cbb');
  const recipientWord = hasExactTransferShape ? calldata.slice(10, 74) : '';
  const hasCanonicalRecipientPadding = recipientWord.startsWith('0'.repeat(24));

  if (
    action.target === canonicalUsdcAddress
    && action.valueWei === '0'
    && hasEmptySignature
    && hasExactTransferShape
    && hasCanonicalRecipientPadding
  ) {
    if (action.actionIndex === undefined) {
      throw new TypeError('decoded facts require a canonical action index');
    }
    const recipient = getAddress(`0x${recipientWord.slice(24)}`);
    const amountAtomic = BigInt(`0x${calldata.slice(74)}`).toString(10);
    return {
      kind: 'usdc_transfer',
      source: 'decoded',
      decoderVersion,
      actionIndex: action.actionIndex,
      canonicalEvidence: evidenceFor(action),
      displayLabel: 'USDC transfer',
      token: canonicalUsdcAddress,
      amountAtomic,
      recipient,
    };
  }

  return rawAction(action);
}

module.exports = {
  SUPPORTED_DECODER_VERSIONS,
  decodeAction,
  validateFact,
  requireVerificationFact,
  serializeVerificationFact,
};