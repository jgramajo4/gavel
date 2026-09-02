const { createHash } = require("node:crypto");
const { getAddress } = require("ethers");

const { preparedGovernanceTransactionSchema } = require("../schema/execution");

function intentMaterial(input) {
  return [
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
}

function governanceIntentHash(input) {
  return createHash("sha256").update(JSON.stringify(intentMaterial(input))).digest("hex");
}

function createPreparedGovernanceTransaction(input) {
  const document = {
    schemaVersion: "1.0.0",
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
    validated: true,
    validatedAt: new Date(input.validatedAt || new Date()).toISOString(),
  };
  return preparedGovernanceTransactionSchema.parse({
    ...document,
    intentHash: governanceIntentHash(document),
  });
}

function fromVotePreparation(preparation) {
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
  };
  if (governanceIntentHash(actual) !== expected.intentHash) {
    throw new Error("Executor mutated the validated governance transaction");
  }
  return expected;
}

module.exports = {
  governanceIntentHash,
  createPreparedGovernanceTransaction,
  fromVotePreparation,
  assertPreparedGovernanceTransaction,
  assertExecutorDidNotMutate,
};
