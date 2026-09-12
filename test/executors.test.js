"use strict";

/**
 * The deprecated single-phase execution path.
 *
 * These classes accept a caller-supplied target and calldata and stamp them
 * `validated: true` -- the hole the canonical boundary exists to close. They
 * survive only so an in-flight migration does not break, and this file asserts
 * the two properties that contain them:
 *
 *   1. They are unreachable by default: not exported from `@gavel/core`, and
 *      inert unless GAVEL_ALLOW_DEPRECATED_EXECUTORS=1 is set.
 *   2. When explicitly enabled, they still behave as they did, so a migrating
 *      caller does not silently get different behaviour.
 *
 * Coverage of the supported path is in `execution-adapters.test.js`,
 * `execution-engine.test.js` and `execution-attacks.test.js`.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const SAFE = "0x0000000000000000000000000000000000000003";
const WAAP = "0x0000000000000000000000000000000000000004";
const GOVERNOR = "0x0000000000000000000000000000000000000010";

const binding = require("../packages/core/src/execution/transaction-binding");
const { SafeSupervisedExecutor } = require("../packages/core/src/execution/executors/safe");
const { WaapAutonomousExecutor } = require("../packages/core/src/execution/executors/waap");
const { UnsignedExecutor } = require("../packages/core/src/execution/executors/unsigned");

/**
 * Run a function with the deprecated path explicitly enabled.
 *
 * `await`s the body before restoring: returning the promise from a synchronous
 * try/finally would restore the variable while the body was still running, and
 * the gate reads `process.env` at call time.
 */
async function enabled(run) {
  const previous = process.env.GAVEL_ALLOW_DEPRECATED_EXECUTORS;
  process.env.GAVEL_ALLOW_DEPRECATED_EXECUTORS = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.GAVEL_ALLOW_DEPRECATED_EXECUTORS;
    else process.env.GAVEL_ALLOW_DEPRECATED_EXECUTORS = previous;
  }
}

function prepared(executionAddress = SAFE, overrides = {}) {
  return binding.createPreparedGovernanceTransaction({
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
    autonomyAllowed: true,
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

test("the deprecated executors are unreachable without an explicit opt-in", () => {
  // Not exported from the package entry point, so `require("@gavel/core")`
  // cannot reach the path that stamps arbitrary calldata as validated.
  const core = require("../packages/core");
  for (const removed of [
    "SafeSupervisedExecutor",
    "WaapAutonomousExecutor",
    "UnsignedExecutor",
    "createPreparedGovernanceTransaction",
    "fromVotePreparation",
  ]) {
    assert.equal(core[removed], undefined, `${removed} is still exported`);
  }

  // And requiring them by path yields classes that refuse to construct.
  assert.throws(
    () => new SafeSupervisedExecutor({ safeAddress: SAFE, client: { propose: async () => ({}) } }),
    /GAVEL_ALLOW_DEPRECATED_EXECUTORS/,
  );
  assert.throws(
    () => new WaapAutonomousExecutor({ adapter: dao(), executionAddress: WAAP, policy: async () => true, client: { submit: async () => ({}) } }),
    /GAVEL_ALLOW_DEPRECATED_EXECUTORS/,
  );
  assert.throws(() => new UnsignedExecutor(SAFE), /GAVEL_ALLOW_DEPRECATED_EXECUTORS/);

  // `fromVotePreparation()` was the bridge from a preparation into executor
  // input, so it is gated too.
  assert.throws(
    () => binding.fromVotePreparation({ status: "READY_TO_SIGN", transaction: {} }),
    /GAVEL_ALLOW_DEPRECATED_EXECUTORS/,
  );
});

test("the document builder stays open, because unsigned delegation output uses it", () => {
  // `gavel prepare-delegation` emits unsigned calldata for a human to sign out
  // of band. That never reaches an executor, and every executor that would
  // consume such a document is gated -- so the builder itself need not be.
  const document = prepared();
  assert.equal(document.validated, true);
  assert.equal(document.target, GOVERNOR);
  assert.match(document.intentHash, /^[0-9a-f]{64}$/);
  assert.equal(binding.assertPreparedGovernanceTransaction(document).intentHash, document.intentHash);
});

test("when enabled, the deprecated Safe executor behaves as it did", async () => {
  await enabled(async () => {
    let proposal;
    const executor = new SafeSupervisedExecutor({
      safeAddress: SAFE,
      chainId: 1,
      client: {
        async propose(input) {
          proposal = input;
          return { safeTxHash: "safe-42", transaction: input.transaction };
        },
        async getStatus() {
          return { status: "AWAITING_APPROVAL" };
        },
      },
    });
    const result = await executor.submit(prepared(SAFE, { autonomyAllowed: false }));
    assert.equal(result.status, "PROPOSED");
    assert.equal(result.executionId, "safe-42");
    assert.equal(proposal.transaction.to, GOVERNOR);
    assert.equal((await executor.getStatus("safe-42")).status, "AWAITING_APPROVAL");
    // It never held a key, which is the one property it always had.
    assert.equal(Object.prototype.hasOwnProperty.call(executor, "privateKey"), false);

    // And its mutation guard still fails closed.
    const mutating = new SafeSupervisedExecutor({
      safeAddress: SAFE,
      client: { propose: async ({ transaction }) => ({ safeTxHash: "x", transaction: { ...transaction, data: "0xabcd" } }) },
    });
    await assert.rejects(mutating.submit(prepared()), /mutated/);
    await assert.rejects(
      new SafeSupervisedExecutor({ safeAddress: SAFE, client: { propose: async () => ({ safeTxHash: "x" }) } }).submit(prepared(WAAP)),
      /does not match the configured Safe/,
    );
  });
});

test("when enabled, the deprecated WaaP executor still gates on adapter and policy", async () => {
  await enabled(async () => {
    const accepted = new WaapAutonomousExecutor({
      adapter: dao(),
      executionAddress: WAAP,
      policy: async () => ({ allowed: true }),
      client: { submit: async ({ transaction }) => ({ executionId: "waap-42", status: "EXECUTED", transaction }) },
    });
    assert.equal((await accepted.submit(prepared(WAAP))).status, "EXECUTED");
    await assert.rejects(accepted.submit(prepared(WAAP, { autonomyAllowed: false })), /blocks autonomous execution/);
    await assert.rejects(accepted.submit(prepared(SAFE)), /does not match WaaP/);

    const disabled = new WaapAutonomousExecutor({
      adapter: dao({ capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: false } }),
      executionAddress: WAAP,
      policy: async () => true,
      client: { submit: async () => ({ executionId: "never" }) },
    });
    await assert.rejects(disabled.submit(prepared(WAAP)), /does not support waap-autonomous/);

    const policyBlocked = new WaapAutonomousExecutor({
      adapter: dao(),
      executionAddress: WAAP,
      policy: async () => ({ allowed: false, reason: "daily limit" }),
      client: { submit: async () => ({ executionId: "never" }) },
    });
    await assert.rejects(policyBlocked.submit(prepared(WAAP)), /policy blocked.*daily limit/i);
  });
});
