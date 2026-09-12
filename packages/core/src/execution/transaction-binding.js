const { createHash } = require("node:crypto");
const { getAddress } = require("ethers");

const { preparedGovernanceTransactionSchema } = require("../schema/execution");

/**
 * The deprecated *execution* path is inert unless explicitly opted into.
 *
 * What was dangerous here was never the document builder on its own -- it
 * produces an unsigned artifact -- but that an executor accepted that document
 * as proof of validation, so arbitrary target and calldata could be submitted.
 * So the gate is on the things that can submit: the three single-phase executor
 * classes and `fromVotePreparation()`, the bridge that turned a vote
 * preparation into executor input.
 *
 * `createPreparedGovernanceTransaction()` stays ungated because
 * `gavel prepare-delegation` uses it to emit unsigned delegation calldata for a
 * human to sign out of band -- a live feature that never reaches an executor.
 * It is not exported from the package entry point, and no gated executor will
 * accept its output without GAVEL_ALLOW_DEPRECATED_EXECUTORS=1.
 */
function assertDeprecatedPathAllowed(what) {
  if (process.env.GAVEL_ALLOW_DEPRECATED_EXECUTORS === "1") return;
  throw new Error(
    `${what} is part of the deprecated single-phase execution path, which accepts ` +
      "caller-supplied target and calldata and stamps them validated. Use the canonical " +
      "boundary (validateExecutionIntent + ExecutionEngine), or set " +
      "GAVEL_ALLOW_DEPRECATED_EXECUTORS=1 to run the legacy path during migration.",
  );
}


function intentMaterial(input) {
  const material = [
    input.adapter,
    input.action,
    Number(input.chainId),
    getAddress(input.target),
    String(input.calldata).toLowerCase(),
    BigInt(input.value).toString(),
    input.proposalId === null ? null : String(input.proposalId),
    input.support,
    input.reason,
    getAddress(input.executionAddress),
  ];
  if (input.schemaVersion === "1.1.0") material.push(input.autonomyAllowed === true);
  return material;
}

function governanceIntentHash(input) {
  return createHash("sha256").update(JSON.stringify(intentMaterial(input))).digest("hex");
}

function createPreparedGovernanceTransaction(input) {
  const document = {
    schemaVersion: "1.1.0",
    kind: "PREPARED_GOVERNANCE_TRANSACTION",
    adapter: input.adapter,
    action: input.action,
    chainId: Number(input.chainId),
    target: getAddress(input.target),
    calldata: String(input.calldata).toLowerCase(),
    value: BigInt(input.value).toString(),
    proposalId: input.proposalId == null ? null : String(input.proposalId),
    support: input.support || null,
    reason: input.reason == null ? null : String(input.reason),
    executionAddress: getAddress(input.executionAddress),
    autonomyAllowed: input.autonomyAllowed === true,
    validated: true,
    validatedAt: new Date(input.validatedAt || new Date()).toISOString(),
  };
  return preparedGovernanceTransactionSchema.parse({
    ...document,
    intentHash: governanceIntentHash(document),
  });
}

function fromVotePreparation(preparation) {
  assertDeprecatedPathAllowed("fromVotePreparation()");
  if (preparation?.status !== "READY_TO_SIGN" || !preparation.transaction) {
    throw new Error("Only a canonically validated READY_TO_SIGN preparation may reach an executor");
  }
  return createPreparedGovernanceTransaction({
    adapter: preparation.dao,
    action: "CAST_VOTE",
    chainId: preparation.transaction.chainId,
    target: preparation.transaction.to,
    calldata: preparation.transaction.data,
    value: preparation.transaction.value,
    proposalId: preparation.proposalId,
    support: preparation.selectedSupport,
    reason: preparation.reason?.text || null,
    executionAddress: preparation.addressRoles?.executionAddress || preparation.votingAddress,
    autonomyAllowed: preparation.predictionReview?.autonomyAllowed === true,
    validatedAt: preparation.generatedAt,
  });
}

function assertPreparedGovernanceTransaction(input) {
  const parsed = preparedGovernanceTransactionSchema.parse(input);
  if (governanceIntentHash(parsed) !== parsed.intentHash) {
    throw new Error("Prepared governance intent hash mismatch");
  }
  return parsed;
}

function assertExecutorDidNotMutate(prepared, observed) {
  const expected = assertPreparedGovernanceTransaction(prepared);
  const supplied = (name, fallback) => Object.prototype.hasOwnProperty.call(observed, name) ? observed[name] : fallback;
  const actual = {
    ...expected,
    adapter: supplied("adapter", expected.adapter),
    action: supplied("action", expected.action),
    target: supplied("target", supplied("to", expected.target)),
    calldata: supplied("calldata", supplied("data", expected.calldata)),
    value: supplied("value", expected.value),
    chainId: supplied("chainId", expected.chainId),
    proposalId: supplied("proposalId", expected.proposalId),
    support: supplied("support", expected.support),
    reason: supplied("reason", expected.reason),
    executionAddress: supplied("executionAddress", supplied("from", expected.executionAddress)),
    autonomyAllowed: supplied("autonomyAllowed", expected.autonomyAllowed),
  };
  if (governanceIntentHash(actual) !== expected.intentHash) {
    throw new Error("Executor mutated the validated governance transaction");
  }
  return expected;
}

module.exports = {
  assertDeprecatedPathAllowed,
  governanceIntentHash,
  createPreparedGovernanceTransaction,
  fromVotePreparation,
  assertPreparedGovernanceTransaction,
  assertExecutorDidNotMutate,
};
