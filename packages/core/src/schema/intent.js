/**
 * Canonical intent schemas: the governance/execution boundary as data.
 *
 * Three documents, in pipeline order:
 *
 *   VoteIntent        WHAT Gavel intends to do, in DAO terms. No execution
 *                     provider assumptions. No calldata.
 *   ExecutionIntent   WHAT exact onchain action represents that intent.
 *                     Provider-neutral: usable by Safe, WaaP, an EOA, or a
 *                     4337 bundler without changing DAO logic.
 *   ValidationEvidence  WHAT the DAO adapter verified onchain. Consumed by
 *                     `intent/validated.js` to mint a ValidatedExecutionIntent;
 *                     never authoritative on its own -- core re-derives the
 *                     selector and cross-checks the target against the
 *                     adapter's own declared governance contracts.
 *
 * Runtime mapping note. The architecture brief writes `chainId: bigint` and
 * `value: bigint`. These documents are persisted and hashed as JSON, so they
 * follow the convention already used across `schema/governance.js` and
 * `schema/execution.js`: `chainId` is a positive integer Number and every
 * 256-bit quantity is an unsigned decimal string. `intent/execution-intent.js`
 * accepts bigint input and normalizes it.
 */

const { z } = require("zod");

const { Support } = require("./governance");

/** Alias for the brief's `VoteSupport`. Same three values as `Support`. */
const VoteSupport = Support;

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an EVM address");
const hexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/, "expected 0x-prefixed even-length hex");
const selectorSchema = z.string().regex(/^0x[0-9a-f]{8}$/, "expected a 4-byte function selector");
const decimalStringSchema = z.string().regex(/^\d+$/, "expected an unsigned integer string");
const daoIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "expected a DAO adapter id");
const actionSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "expected a governance action name");
const chainIdSchema = z.number().int().positive();
const intentHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/, "expected a 0x-prefixed 32-byte hash");
const supportSchema = z.enum(Object.values(VoteSupport));

/**
 * A governance decision. Deliberately absent: safeTxHash, Safe nonce, Safe
 * delegate, WaaP session id, API Kit configuration, or anything else naming an
 * execution provider. Those belong below the boundary.
 */
const voteIntentSchema = z.object({
  version: z.literal(1),
  dao: daoIdSchema,
  chainId: chainIdSchema,
  voterAddress: addressSchema,
  proposalId: z.string().min(1),
  support: supportSchema,
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * The exact onchain action representing a VoteIntent.
 *
 * `source.action` and `source.voteIntentHash` extend the brief's `source`.
 * `action` is what the DAO adapter's `supportedActions` gate reads, and
 * `voteIntentHash` is the audit link back to the governance decision. Both are
 * governance facts, not provider facts, so both stay provider-neutral.
 */
const executionIntentSchema = z.object({
  version: z.literal(1),
  chainId: chainIdSchema,
  actor: addressSchema,
  target: addressSchema,
  value: decimalStringSchema,
  data: hexSchema,
  operation: z.literal("CALL"),
  source: z.object({
    type: z.literal("governance-vote"),
    dao: daoIdSchema,
    action: actionSchema,
    proposalId: z.string().min(1),
    support: supportSchema,
    reason: z.string().nullable(),
    voteIntentHash: intentHashSchema,
  }),
});

/**
 * The DAO's own rules about repeating or replacing a vote.
 *
 * Replay protection cannot be a constant in the execution layer, because the
 * DAOs disagree. Nouns and ENS record one receipt per voter per proposal, so a
 * second execution is a duplicate. Railgun votes by staked amount and permits
 * successive partial votes until stake is exhausted, so the same rule would be
 * wrong. The adapter declares which it is; the execution layer enforces what it
 * was told.
 */
const executionSemanticsSchema = z.object({
  /** Successive votes on one proposal are legitimate (Railgun's partial votes). */
  canVoteMultipleTimes: z.boolean(),
  /** A later vote supersedes an earlier one rather than adding to it. */
  canReplaceVote: z.boolean(),
});

/** Fails closed: one execution per voter per proposal, no replacement. */
const CONSERVATIVE_EXECUTION_SEMANTICS = Object.freeze({
  canVoteMultipleTimes: false,
  canReplaceVote: false,
});

/**
 * What a DAO adapter verified against canonical chain state.
 *
 * `checks` carries the adapter's own blocker list so the audit chain records
 * what was verified, not merely that something was. A `checks` entry with
 * `passed: false` fails validation.
 *
 * `autonomyAllowed` is a governance-layer determination, not a provider one: it
 * says whether the voter model's confidence in this recommendation is high
 * enough to act without a human. It lives here because it constrains execution
 * while being decided above the boundary, and it defaults closed -- an advisory
 * observed-behavior recommendation sets it false and the autonomous executor
 * refuses.
 *
 * `deadline` and `semantics` are what make replay protection possible below the
 * boundary without the execution layer knowing any DAO's rules.
 */
const validationEvidenceSchema = z.object({
  adapterVersion: z.string().min(1),
  validatedAt: z.string().datetime(),
  proposalState: z.string().min(1),
  proposalStateVotable: z.boolean(),
  governanceTarget: addressSchema,
  selector: selectorSchema,
  actorEligible: z.boolean(),
  autonomyAllowed: z.boolean(),
  deadline: z.object({
    kind: z.enum(["block", "timestamp", "none"]),
    value: decimalStringSchema.nullable(),
  }),
  semantics: executionSemanticsSchema,
  checks: z.array(
    z.object({
      code: z.string().regex(/^[A-Z0-9_]+$/),
      passed: z.boolean(),
      detail: z.string().nullable().optional(),
    }),
  ),
});

/**
 * The serialized form of a ValidatedExecutionIntent. Parsing this schema is
 * *not* validation: a document matching it proves only that it is well shaped.
 * Only `intent/validated.js` mints the in-memory validated type.
 */
const validatedExecutionIntentDocumentSchema = z.object({
  version: z.literal(1),
  kind: z.literal("VALIDATED_EXECUTION_INTENT"),
  intent: executionIntentSchema,
  intentHash: intentHashSchema,
  validation: validationEvidenceSchema,
});

module.exports = {
  CONSERVATIVE_EXECUTION_SEMANTICS,
  VoteSupport,
  actionSchema,
  addressSchema,
  chainIdSchema,
  daoIdSchema,
  decimalStringSchema,
  executionIntentSchema,
  executionSemanticsSchema,
  hexSchema,
  intentHashSchema,
  selectorSchema,
  supportSchema,
  validatedExecutionIntentDocumentSchema,
  validationEvidenceSchema,
  voteIntentSchema,
};
