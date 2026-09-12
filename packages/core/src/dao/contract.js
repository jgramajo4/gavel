/**
 * The GovernanceAdapter contract, and defaults that satisfy it.
 *
 * Every DAO adapter must answer the same questions:
 *
 *   fetchProposal / fetchVoterState   what does the DAO say right now?
 *   buildVoteIntent                   what does Gavel intend, in DAO terms?
 *   buildExecutionIntent              which exact call represents that?
 *   validateExecutionIntent           does canonical chain state permit it?
 *   getExecutionSemantics             what are this DAO's rules about
 *                                     repeating or replacing a vote?
 *
 * `prepareValidatedIntent()` below implements the last three on top of an
 * adapter's existing `prepareVote()`, so Nouns, ENS and Railgun satisfy the
 * contract without three separate reimplementations -- and so a new adapter
 * gets the whole canonical path by writing `prepareVote()` and declaring its
 * semantics.
 *
 * The execution layer never calls any of this. It receives only the
 * ValidatedExecutionIntent that comes out the end.
 */

const { CONSERVATIVE_EXECUTION_SEMANTICS, executionSemanticsSchema } = require("../schema/intent");
const {
  executionIntentFromPreparation,
  validatedIntentFromPreparation,
  voteIntentFromPreparation,
} = require("../intent/from-preparation");

const { REQUIRED_ADAPTER_METHODS } = require("./registry");

/**
 * The canonical surface. Separate from the required set so an older adapter
 * still registers and still works through the legacy path, while anything
 * driving the canonical pipeline can demand the full contract.
 */
const CANONICAL_ADAPTER_METHODS = Object.freeze([
  "getExecutionSemantics",
  "buildVoteIntent",
  "buildExecutionIntent",
  "validateExecutionIntent",
  "prepareValidatedIntent",
]);

function assertCanonicalGovernanceAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("A governance adapter is required");
  const missing = CANONICAL_ADAPTER_METHODS.filter((method) => typeof adapter[method] !== "function");
  if (missing.length > 0) {
    throw new TypeError(
      `${adapter.id || "adapter"} does not satisfy the canonical GovernanceAdapter contract: missing ${missing.join(", ")}()`,
    );
  }
  if (!adapter.adapterVersion) {
    throw new TypeError(`${adapter.id} must declare an adapterVersion for the audit chain`);
  }
  executionSemanticsSchema.parse(adapter.getExecutionSemantics());
  return adapter;
}

/**
 * The proposal's voting deadline, in whichever unit the DAO measures time.
 *
 * This is what lets the execution layer reject a stale validated intent
 * without knowing anything about the DAO. A DAO whose deadline cannot be
 * determined reports `none`, and replay protection then rests on execution
 * records and the adapter's own state check at validation time.
 */
function governanceDeadline(proposal) {
  if (!proposal) return { kind: "none", value: null };
  if (proposal.timing === "timestamp") {
    const endTime = proposal.endTime ? Math.floor(new Date(proposal.endTime).getTime() / 1000) : null;
    if (endTime != null && Number.isFinite(endTime)) return { kind: "timestamp", value: String(endTime) };
    // Some timestamp-timed DAOs carry the deadline in `endBlock` as seconds.
    if (/^\d+$/.test(String(proposal.endBlock ?? ""))) {
      return { kind: "timestamp", value: String(proposal.endBlock) };
    }
    return { kind: "none", value: null };
  }
  if (/^\d+$/.test(String(proposal.endBlock ?? "")) && String(proposal.endBlock) !== "0") {
    return { kind: "block", value: String(proposal.endBlock) };
  }
  return { kind: "none", value: null };
}

/**
 * Run an adapter's own `prepareVote()` and lift the result across the
 * governance/execution boundary.
 *
 * Returns `{ preparation, validated }` on success. When the preparation is
 * BLOCKED, `validated` is null and the blockers are returned as they are:
 * refusing to mint a validated intent for a blocked vote is the governance
 * invariant, and turning it into a thrown error would lose the reasons.
 */
async function prepareValidatedIntent(adapter, input) {
  const preparation = await adapter.prepareVote(input);
  if (preparation.status !== "READY_TO_SIGN") {
    return { preparation, validated: null, blockers: preparation.blockers || [] };
  }
  const validated = validatedIntentFromPreparation(adapter, preparation, {
    adapterVersion: adapter.adapterVersion,
    semantics: adapter.getExecutionSemantics(),
    deadline: governanceDeadline(input.proposal),
    action: input.action || "CAST_VOTE",
  });
  return { preparation, validated, blockers: [] };
}

/**
 * Install the canonical contract on an adapter class.
 *
 * Each adapter calls this once in its constructor. `semantics` is the only
 * genuinely per-DAO argument, because it is the only part that cannot be
 * derived: a DAO's rules about repeating a vote are a fact about the DAO.
 */
function installGovernanceContract(adapter, options = {}) {
  const semantics = Object.freeze(
    executionSemanticsSchema.parse(options.semantics || CONSERVATIVE_EXECUTION_SEMANTICS),
  );
  adapter.adapterVersion = options.adapterVersion || `${adapter.id}@unversioned`;
  if (options.governanceSelectors) adapter.governanceSelectors = Object.freeze(options.governanceSelectors);
  if (options.governanceTargets) adapter.governanceTargets = Object.freeze(options.governanceTargets);

  adapter.getExecutionSemantics = () => semantics;
  adapter.prepareValidatedIntent = (input) => prepareValidatedIntent(adapter, input);
  adapter.buildVoteIntent = async (input) => {
    const { preparation } = await prepareValidatedIntent(adapter, input);
    return voteIntentFromPreparation(preparation);
  };
  adapter.buildExecutionIntent = async (input) => {
    const { preparation } = await prepareValidatedIntent(adapter, input);
    return executionIntentFromPreparation(preparation);
  };
  adapter.validateExecutionIntent = async (input) => {
    const { validated, blockers } = await prepareValidatedIntent(adapter, input);
    if (!validated) {
      throw new Error(
        `${adapter.id} cannot validate this vote: ${blockers.map((blocker) => blocker.code).join(", ")}`,
      );
    }
    return validated;
  };
  return adapter;
}

module.exports = {
  CANONICAL_ADAPTER_METHODS,
  REQUIRED_ADAPTER_METHODS,
  assertCanonicalGovernanceAdapter,
  governanceDeadline,
  installGovernanceContract,
  prepareValidatedIntent,
};
