const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPreparedGovernanceTransaction,
  fromVotePreparation,
} = require("../packages/core/src/execution/transaction-binding");
const { SafeSupervisedExecutor } = require("../packages/core/src/execution/executors/safe");
const { WaapAutonomousExecutor } = require("../packages/core/src/execution/executors/waap");

const SAFE = "0x0000000000000000000000000000000000000003";
const WAAP = "0x0000000000000000000000000000000000000004";
const GOVERNOR = "0x0000000000000000000000000000000000000010";

function prepared(executionAddress = SAFE, overrides = {}) {
  return createPreparedGovernanceTransaction({
    adapter: "nouns",
    action: "CAST_VOTE",
    chainId: 1,
    target: GOVERNOR,
    calldata: "0x1234",
    value: "0",
    proposalId: "42",
    support: "FOR",
    reason: "Consistent with prior votes.",
    executionAddress,
    validatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  });
}

function dao(overrides = {}) {
  return {
    id: "nouns",
    chainId: 1,
    governanceContracts: { governor: GOVERNOR },
    capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    validateProposal() {}, getVotingPower() {}, getCurrentDelegate() {}, hasVoted() {}, prepareVote() {},
    ...overrides,
  };
}

test("Safe proposes an immutable validated vote without an owner key", async () => {
  let proposal;
  const executor = new SafeSupervisedExecutor({
    safeAddress: SAFE,
    chainId: 1,
    client: {
      async propose(input) {
        proposal = input;
        return { safeTxHash: "safe-42", transaction: input.transaction };
      },
      async getStatus() { return { status: "AWAITING_APPROVAL" }; },
    },
  });
  const result = await executor.submit(prepared());
  assert.equal(result.status, "PROPOSED");
  assert.equal(result.executionId, "safe-42");
  assert.equal(proposal.safeAddress, SAFE);
  assert.equal(proposal.transaction.to, GOVERNOR);
  assert.equal((await executor.getStatus("safe-42")).status, "AWAITING_APPROVAL");
  assert.equal(Object.prototype.hasOwnProperty.call(executor, "privateKey"), false);
});

test("Safe rejects blocked, wrong-address, wrong-chain, and mutated transactions", async () => {
  await assert.rejects(async () => fromVotePreparation({ status: "BLOCKED", transaction: null }), /READY_TO_SIGN/);
  const wrongAddress = new SafeSupervisedExecutor({ safeAddress: SAFE, client: { propose: async () => ({ safeTxHash: "x" }) } });
  await assert.rejects(wrongAddress.submit(prepared(WAAP)), /does not match the configured Safe/);
  const wrongChain = new SafeSupervisedExecutor({ safeAddress: SAFE, chainId: 5, client: { propose: async () => ({ safeTxHash: "x" }) } });
  await assert.rejects(wrongChain.submit(prepared()), /chain does not match/);
  const mutating = new SafeSupervisedExecutor({
    safeAddress: SAFE,
    client: { propose: async ({ transaction }) => ({ safeTxHash: "x", transaction: { ...transaction, data: "0xabcd" } }) },
  });
  await assert.rejects(mutating.submit(prepared()), /mutated/);
  const intent = prepared();
  assert.throws(
    () => require("../packages/core/src/execution/transaction-binding").assertExecutorDidNotMutate(intent, { support: "AGAINST" }),
    /mutated/,
  );
});

test("WaaP accepts only adapter-approved governance actions after policy approval", async () => {
  const accepted = new WaapAutonomousExecutor({
    adapter: dao(),
    executionAddress: WAAP,
    policy: async () => ({ allowed: true }),
    client: { submit: async ({ transaction }) => ({ executionId: "waap-42", status: "EXECUTED", transaction }) },
  });
  assert.equal((await accepted.submit(prepared(WAAP))).status, "EXECUTED");

  const disabled = new WaapAutonomousExecutor({
    adapter: dao({ capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: false } }),
    executionAddress: WAAP,
    policy: async () => true,
    client: { submit: async () => ({ executionId: "never" }) },
  });
  await assert.rejects(disabled.submit(prepared(WAAP)), /does not support waap-autonomous/);

  const unsupported = new WaapAutonomousExecutor({
    adapter: dao({ supportedActions: [] }),
    executionAddress: WAAP,
    policy: async () => true,
    client: { submit: async () => ({ executionId: "never" }) },
  });
  await assert.rejects(unsupported.submit(prepared(WAAP)), /does not support governance action/);

  const policyBlocked = new WaapAutonomousExecutor({
    adapter: dao(),
    executionAddress: WAAP,
    policy: async () => ({ allowed: false, reason: "daily limit" }),
    client: { submit: async () => ({ executionId: "never" }) },
  });
  await assert.rejects(policyBlocked.submit(prepared(WAAP)), /policy blocked.*daily limit/i);

  await assert.rejects(accepted.submit(prepared(SAFE)), /does not match WaaP/);

  const wrongDao = new WaapAutonomousExecutor({
    adapter: dao({ id: "other-dao" }),
    executionAddress: WAAP,
    policy: async () => true,
    client: { submit: async () => ({ executionId: "never" }) },
  });
  await assert.rejects(wrongDao.submit(prepared(WAAP)), /does not match the WaaP DAO adapter/);

  const mutating = new WaapAutonomousExecutor({
    adapter: dao(),
    executionAddress: WAAP,
    policy: async () => true,
    client: { submit: async ({ transaction }) => ({ executionId: "never", transaction: { ...transaction, to: SAFE } }) },
  });
  await assert.rejects(mutating.submit(prepared(WAAP)), /mutated/);
});
