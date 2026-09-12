/**
 * ValidatedExecutionIntent: the architectural artifact at the boundary.
 *
 * Everything above this type is governance. Everything below it is execution.
 * An execution adapter accepts nothing else, so the interesting call is hard to
 * write:
 *
 *     executor.prepare({ to: attacker, data: arbitraryData })   // TypeError
 *     executor.prepare(validatedIntent)                         // the only way
 *
 * The enforcement is a private constructor. `SEAL` is module-scoped and never
 * exported, so the only code in the process that can construct the class is
 * `validateExecutionIntent()` below. A hand-built object literal, a parsed JSON
 * document and a structural look-alike all fail `instanceof`, and there is no
 * exported conversion that upgrades one. Re-entering the boundary from a
 * serialized document means re-validating against a live DAO adapter, by
 * design.
 *
 * This replaces the previous `validated: true` field on prepared transactions,
 * which any caller could write for arbitrary calldata (see
 * `docs/architecture/EXECUTION_CURRENT_STATE.md` section 3).
 *
 * What the seal does and does not prove
 * -------------------------------------
 *
 * It proves that `validateExecutionIntent()` ran with a DAO adapter and that
 * the checks below passed. Core recomputes the selector from the calldata,
 * requires the target to be an address the adapter explicitly declared, makes
 * the adapter decode its own calldata so the encoded proposal, support and
 * reason are bound to the bytes, and re-derives the governance intent link.
 * A buggy adapter cannot bless a call to an address it never declared, and no
 * caller can swap a vote's arguments behind a valid selector.
 *
 * It does NOT prove that chain state was read: this function performs no I/O
 * and the `evidence` it consumes is supplied by its caller. Live verification
 * is `GovernanceAdapter.prepareValidatedIntent()`, which calls `prepareVote()`
 * against a provider and only then mints. Anything that mints from a stored
 * document instead is trusting that document -- which is why the CLI re-runs
 * live preparation rather than lifting preparation JSON.
 */

const { getAddress } = require("ethers");

const { assertDaoAdapter } = require("../dao/registry");
const {
  executionIntentSchema,
  validatedExecutionIntentDocumentSchema,
  validationEvidenceSchema,
} = require("../schema/intent");
const { executionIntentHash, executionIntentSelector } = require("./execution-intent");
const { voteIntentHash } = require("./vote-intent");
const { deepFreeze } = require("./canonical");

const SEAL = Symbol("gavel.validated-execution-intent.seal");

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

class ValidatedExecutionIntent {
  #intent;
  #intentHash;
  #validation;

  constructor(seal, intent, intentHash, validation) {
    if (seal !== SEAL) {
      throw new TypeError(
        "ValidatedExecutionIntent is minted only by canonical Gavel validation; " +
          "call validateExecutionIntent() with a DAO adapter",
      );
    }
    this.#intent = deepFreeze(structuredClone(intent));
    this.#intentHash = intentHash;
    this.#validation = deepFreeze(structuredClone(validation));
    Object.freeze(this);
  }

  /** The provider-neutral call. Frozen: an executor cannot edit it in place. */
  get intent() {
    return this.#intent;
  }

  /** The stable cross-system identity of this action. */
  get intentHash() {
    return this.#intentHash;
  }

  /** What the DAO adapter verified, for the audit chain. */
  get validation() {
    return this.#validation;
  }

  get dao() {
    return this.#intent.source.dao;
  }

  get action() {
    return this.#intent.source.action;
  }

  get actor() {
    return this.#intent.actor;
  }

  get chainId() {
    return this.#intent.chainId;
  }

  /**
   * Brand check on a private field rather than `instanceof`.
   *
   * `instanceof` only walks the prototype chain, so
   * `Object.create(ValidatedExecutionIntent.prototype)` would pass it while
   * carrying no validated state at all. A private field is installed by the
   * constructor and by nothing else, so `#intentHash in value` is true only for
   * an object this class actually built -- which, given the seal, means only
   * for one `validateExecutionIntent()` minted.
   */
  static isValidated(value) {
    return (typeof value === "object" || typeof value === "function") && value !== null
      ? #intentHash in value
      : false;
  }

  /**
   * The serialized form. Note that parsing it back does NOT produce a
   * ValidatedExecutionIntent -- persistence and transport are lossy on purpose,
   * because a document that crossed a process boundary carries no evidence that
   * a DAO adapter ever checked it.
   */
  toJSON() {
    return validatedExecutionIntentDocumentSchema.parse({
      version: 1,
      kind: "VALIDATED_EXECUTION_INTENT",
      intent: this.#intent,
      intentHash: this.#intentHash,
      validation: this.#validation,
    });
  }
}

function isValidatedExecutionIntent(value) {
  return ValidatedExecutionIntent.isValidated(value);
}

/**
 * The single gate an execution adapter calls on its input.
 *
 * Throws rather than returning false: an executor handed something unvalidated
 * must not proceed, and a boolean invites a caller to ignore it.
 */
function assertValidatedExecutionIntent(value) {
  if (!isValidatedExecutionIntent(value)) {
    throw new TypeError(
      "Execution adapters accept only a ValidatedExecutionIntent minted by canonical Gavel validation",
    );
  }
  return value;
}

/**
 * Every address the adapter has explicitly declared as a governance target.
 *
 * There is deliberately no fallback to `governanceContracts`. That map holds
 * every contract an adapter knows about -- ENS's includes the token and the
 * timelock -- so falling back to it widened the allowed target set well beyond
 * the governor. An adapter must say which addresses a vote may be sent to.
 */
function declaredGovernanceTargets(adapter) {
  const targets = new Set();
  for (const value of Array.isArray(adapter.governanceTargets) ? adapter.governanceTargets : []) {
    if (typeof value !== "string") continue;
    try {
      targets.add(getAddress(value));
    } catch {
      // A malformed declared address simply does not authorize anything.
    }
  }
  if (targets.size === 0) {
    throw new ValidationError(
      "ADAPTER_DECLARES_NO_GOVERNANCE_TARGETS",
      `${adapter.id} must declare governanceTargets; the governanceContracts map is not an allowlist`,
    );
  }
  return targets;
}

/**
 * Bind the governance decision to the actual bytes.
 *
 * A 4-byte selector says which function is called, not with what. The same
 * valid `castRefundableVoteWithReason` selector encodes a vote FOR proposal 42
 * and a vote AGAINST proposal 999, so checking the selector alone left
 * `source.proposalId`, `source.support` and `source.reason` unbound to `data`
 * -- a doctored preparation could keep every declared value and swap the
 * arguments.
 *
 * Core cannot decode DAO calldata without becoming DAO-aware, so the adapter
 * decodes its own and core cross-checks the result. A decoder is mandatory:
 * without one there is no way to establish the binding, and skipping the check
 * silently is exactly the hole this closes.
 */
function assertCalldataMatchesIntent(adapter, intent) {
  if (typeof adapter.decodeGovernanceCall !== "function") {
    throw new ValidationError(
      "ADAPTER_CANNOT_DECODE_GOVERNANCE_CALL",
      `${adapter.id} must implement decodeGovernanceCall(action, data) so the calldata can be bound ` +
        "to the governance decision it claims to represent",
    );
  }

  let decoded;
  try {
    decoded = adapter.decodeGovernanceCall(intent.source.action, intent.data);
  } catch (error) {
    throw new ValidationError(
      "CALLDATA_NOT_DECODABLE",
      `${adapter.id} could not decode this ${intent.source.action} calldata: ${error.message}`,
    );
  }
  if (!decoded || typeof decoded !== "object") {
    throw new ValidationError(
      "CALLDATA_NOT_DECODABLE",
      `${adapter.id} returned no decoded governance call for this calldata`,
    );
  }

  const mismatches = [];
  if (String(decoded.proposalId) !== intent.source.proposalId) {
    mismatches.push(`proposalId ${decoded.proposalId} != ${intent.source.proposalId}`);
  }
  if (String(decoded.support).toUpperCase() !== intent.source.support) {
    mismatches.push(`support ${decoded.support} != ${intent.source.support}`);
  }
  // A DAO whose vote call carries no reason field reports null, and the intent
  // must agree rather than claiming a reason the chain will never see.
  const decodedReason = decoded.reason == null ? null : String(decoded.reason).trim() || null;
  if (decodedReason !== intent.source.reason) {
    mismatches.push("reason differs from the encoded reason");
  }
  if (mismatches.length > 0) {
    throw new ValidationError(
      "CALLDATA_DOES_NOT_MATCH_INTENT",
      `The calldata does not encode the governance decision it claims: ${mismatches.join("; ")}`,
    );
  }
  return decoded;
}

function fail(code, message) {
  throw new ValidationError(code, message);
}

/**
 * Validate a provider-neutral ExecutionIntent against a DAO adapter and the
 * adapter's onchain evidence, and mint the boundary type on success.
 *
 * @param {object} options
 * @param {object} options.adapter    a registered GovernanceAdapter
 * @param {object} options.intent     an ExecutionIntent document
 * @param {object} options.evidence   ValidationEvidence from the adapter
 * @param {object} options.voteIntent  the originating VoteIntent, cross-checked
 *                                    against `intent.source.voteIntentHash`. Required.
 */
function validateExecutionIntent(options) {
  const adapter = assertDaoAdapter(options?.adapter);
  const intent = executionIntentSchema.parse(options?.intent);
  const evidence = validationEvidenceSchema.parse(options?.evidence);

  if (intent.source.dao !== adapter.id) {
    fail("DAO_MISMATCH", `ExecutionIntent names DAO ${intent.source.dao}, validated against ${adapter.id}`);
  }
  if (intent.chainId !== adapter.chainId) {
    fail("CHAIN_MISMATCH", `ExecutionIntent chain ${intent.chainId} is not ${adapter.id} chain ${adapter.chainId}`);
  }
  if (!adapter.supportedActions.includes(intent.source.action)) {
    fail("ACTION_UNSUPPORTED", `${adapter.id} does not support governance action ${intent.source.action}`);
  }

  // Generic security verification of the target. The execution layer never
  // parses a governor ABI, but core does insist the call goes to an address
  // this adapter declared as part of its governance system.
  const target = getAddress(intent.target);
  if (!declaredGovernanceTargets(adapter).has(target)) {
    fail(
      "TARGET_NOT_GOVERNANCE_CONTRACT",
      `${target} is not a declared ${adapter.id} governance contract`,
    );
  }
  if (getAddress(evidence.governanceTarget) !== target) {
    fail("EVIDENCE_TARGET_MISMATCH", "Validation evidence describes a different target than the intent");
  }

  // The selector is re-derived from the calldata rather than trusted.
  const selector = executionIntentSelector(intent);
  if (!selector) fail("CALLDATA_HAS_NO_SELECTOR", "A governance call must carry a 4-byte selector");
  if (evidence.selector !== selector) {
    fail("EVIDENCE_SELECTOR_MISMATCH", "Validation evidence describes a different selector than the calldata");
  }
  // The selector allowlist is mandatory. Left optional, an adapter that simply
  // never declared one accepted any 4-byte selector against a declared target
  // -- including a governor's own execute, queue or cancel.
  const allowedSelectors = adapter.governanceSelectors?.[intent.source.action];
  if (!Array.isArray(allowedSelectors) || allowedSelectors.length === 0) {
    fail(
      "ADAPTER_DECLARES_NO_SELECTORS_FOR_ACTION",
      `${adapter.id} must declare governanceSelectors for ${intent.source.action}`,
    );
  }
  if (!allowedSelectors.map((entry) => String(entry).toLowerCase()).includes(selector)) {
    fail(
      "SELECTOR_NOT_ALLOWED_FOR_ACTION",
      `${selector} is not a declared ${adapter.id} selector for ${intent.source.action}`,
    );
  }

  // The calldata's arguments must encode the decision the intent claims.
  assertCalldataMatchesIntent(adapter, intent);

  // The originating VoteIntent is required, not optional. Made optional, the
  // link back to the governance decision could simply be omitted by a caller.
  if (!options?.voteIntent) {
    fail(
      "VOTE_INTENT_REQUIRED",
      "validateExecutionIntent requires the originating VoteIntent so the execution intent's " +
        "governance provenance can be verified rather than asserted",
    );
  }
  if (voteIntentHash(options.voteIntent) !== intent.source.voteIntentHash) {
    fail("VOTE_INTENT_MISMATCH", "ExecutionIntent does not descend from the supplied VoteIntent");
  }

  if (!evidence.proposalStateVotable) {
    fail(
      "PROPOSAL_NOT_VOTABLE",
      `Canonical proposal state ${evidence.proposalState} does not accept this vote`,
    );
  }
  if (!evidence.actorEligible) {
    fail("ACTOR_NOT_ELIGIBLE", `${intent.actor} is not eligible to cast this ${adapter.id} vote`);
  }
  const failedChecks = evidence.checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) {
    fail(
      "ADAPTER_CHECKS_FAILED",
      `Adapter validation failed: ${failedChecks.map((check) => check.code).join(", ")}`,
    );
  }

  return new ValidatedExecutionIntent(SEAL, intent, executionIntentHash(intent), evidence);
}

module.exports = {
  ValidatedExecutionIntent,
  ValidationError,
  assertValidatedExecutionIntent,
  isValidatedExecutionIntent,
  validateExecutionIntent,
};
