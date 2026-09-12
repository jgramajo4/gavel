/**
 * Execution records: attempts, kept separately from governance intents.
 *
 * One governance decision may be attempted several times through different
 * providers -- a Safe proposal expires, the user switches to autonomous
 * execution -- and none of that history belongs in the canonical intent. The
 * intent stays the stable identity; records accumulate around it.
 *
 * This is also where every provider-specific value lives: safeTxHash, Safe
 * nonce, transaction hash, provider request id. None of them are hashed into
 * the intent, which is exactly what makes retry safe and the same intent
 * portable across modes.
 */

const { z } = require("zod");
const { getAddress } = require("ethers");

const { ExecutionState, assertTransition, isActiveExecutionState, isSuccessfulExecutionState } = require("./lifecycle");
const { getExecutionMode } = require("./modes");
const {
  addressSchema,
  daoIdSchema,
  decimalStringSchema,
  hexSchema,
  intentHashSchema,
} = require("../schema/intent");

const providerDataSchema = z
  .object({
    safeTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    safeNonce: decimalStringSchema.optional(),
    safeAddress: addressSchema.optional(),
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    providerRequestId: z.string().min(1).optional(),
    providerStatus: z.string().min(1).optional(),
  })
  .partial()
  .strict();

const executionRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  /** The idempotency key: intentHash + mode + actor. */
  key: z.string().min(1),
  intentHash: intentHashSchema,
  voteIntentHash: intentHashSchema,
  mode: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  actor: addressSchema,
  dao: daoIdSchema,
  proposalId: z.string().min(1),
  support: z.enum(["FOR", "AGAINST", "ABSTAIN"]),
  chainId: z.number().int().positive(),
  target: addressSchema,
  selector: z.string().regex(/^0x[0-9a-f]{8}$/),
  state: z.enum(Object.values(ExecutionState)),
  attempt: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  providerData: providerDataSchema.default({}),
  /** Every state the attempt passed through, for the audit chain. */
  history: z
    .array(
      z.object({
        state: z.enum(Object.values(ExecutionState)),
        at: z.string().datetime(),
        detail: z.string().nullable().optional(),
      }),
    )
    .min(1),
  /** Why Gavel believed this action was correct, carried from validation. */
  audit: z.object({
    adapterVersion: z.string().min(1),
    validatedAt: z.string().datetime(),
    proposalState: z.string().min(1),
    governanceTarget: addressSchema,
    autonomyAllowed: z.boolean(),
    deadline: z.object({
      kind: z.enum(["block", "timestamp", "none"]),
      value: decimalStringSchema.nullable(),
    }),
    reason: z.string().nullable(),
    calldata: hexSchema,
  }),
});

/**
 * The idempotency key.
 *
 * intentHash + mode + actor, exactly as the architecture requires. The intent
 * hash already covers the DAO, proposal, support and calldata, so this is
 * "this governance action, through this provider, from this address". The same
 * action through a different mode is a genuinely different attempt and gets its
 * own key.
 */
function executionKey({ intentHash, mode, actor }) {
  return `${getExecutionMode(mode).mode}:${getAddress(actor).toLowerCase()}:${intentHash}`;
}

function createExecutionRecord(validated, options) {
  const mode = getExecutionMode(options.mode).mode;
  const intent = validated.intent;
  const at = new Date(options.now || Date.now()).toISOString();
  const key = executionKey({ intentHash: validated.intentHash, mode, actor: intent.actor });
  const attempt = Number(options.attempt || 1);
  return executionRecordSchema.parse({
    version: 1,
    id: `${key}#${attempt}`,
    key,
    intentHash: validated.intentHash,
    voteIntentHash: intent.source.voteIntentHash,
    mode,
    actor: intent.actor,
    dao: intent.source.dao,
    proposalId: intent.source.proposalId,
    support: intent.source.support,
    chainId: intent.chainId,
    target: intent.target,
    selector: validated.validation.selector,
    state: ExecutionState.VALIDATED,
    attempt,
    createdAt: at,
    updatedAt: at,
    providerData: {},
    history: [{ state: ExecutionState.VALIDATED, at, detail: validated.validation.proposalState }],
    audit: {
      adapterVersion: validated.validation.adapterVersion,
      validatedAt: validated.validation.validatedAt,
      proposalState: validated.validation.proposalState,
      governanceTarget: validated.validation.governanceTarget,
      autonomyAllowed: validated.validation.autonomyAllowed,
      deadline: validated.validation.deadline,
      reason: intent.source.reason,
      calldata: intent.data,
    },
  });
}

/**
 * Advance a record. The transition is checked, so a provider cannot walk a
 * record backwards and the history stays a true account of what happened.
 */
function advanceExecutionRecord(record, next, options = {}) {
  const state = assertTransition(record.state, next.state ?? next);
  const at = new Date(options.now || Date.now()).toISOString();
  const detail = next.detail ?? null;
  const providerData = { ...record.providerData, ...(next.providerData || {}) };
  const history =
    record.state === state && (record.history.at(-1)?.detail ?? null) === detail
      ? record.history
      : [...record.history, { state, at, detail }];
  return executionRecordSchema.parse({ ...record, state, updatedAt: at, providerData, history });
}

function isActiveRecord(record) {
  return isActiveExecutionState(record.state);
}

function isSuccessfulRecord(record) {
  return isSuccessfulExecutionState(record.state);
}

/**
 * An in-memory record store.
 *
 * The interface is the contract that matters: `get` by idempotency key,
 * `listByIntentHash` for retry and mode-switch decisions, and
 * `listByProposal` for the replay rule, which has to see attempts under *other*
 * intent hashes (a different reason or support on the same proposal is a
 * different intent but the same governance act).
 */
class InMemoryExecutionRecordStore {
  #byId = new Map();

  async get(key) {
    const records = [...this.#byId.values()].filter((record) => record.key === key);
    if (records.length === 0) return null;
    return records.sort((left, right) => right.attempt - left.attempt)[0];
  }

  async getById(id) {
    return this.#byId.get(id) || null;
  }

  async put(record) {
    const parsed = executionRecordSchema.parse(record);
    this.#byId.set(parsed.id, parsed);
    return parsed;
  }

  async listByKey(key) {
    return [...this.#byId.values()].filter((record) => record.key === key);
  }

  async listByIntentHash(intentHash) {
    return [...this.#byId.values()].filter((record) => record.intentHash === intentHash);
  }

  async listByProposal({ dao, proposalId, actor }) {
    const normalizedActor = actor ? getAddress(actor) : null;
    return [...this.#byId.values()].filter(
      (record) =>
        record.dao === dao &&
        record.proposalId === String(proposalId) &&
        (!normalizedActor || getAddress(record.actor) === normalizedActor),
    );
  }

  async list() {
    return [...this.#byId.values()];
  }
}

module.exports = {
  InMemoryExecutionRecordStore,
  advanceExecutionRecord,
  createExecutionRecord,
  executionKey,
  executionRecordSchema,
  isActiveRecord,
  isSuccessfulRecord,
  providerDataSchema,
};
