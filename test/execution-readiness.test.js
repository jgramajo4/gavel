const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveExecutionReadiness } = require("../packages/core/src/execution/readiness");
const { ExecutionMode } = require("../packages/core/src/schema/execution");

const MODEL = "0x0000000000000000000000000000000000000001";
const COLD = "0x0000000000000000000000000000000000000002";
const SAFE = "0x0000000000000000000000000000000000000003";
const WAAP = "0x0000000000000000000000000000000000000004";

function adapter(delegateRef) {
  return {
    id: "nouns",
    chainId: 1,
    governanceContracts: { governor: "0x0000000000000000000000000000000000000010" },
    capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    validateProposal() {},
    async getVotingPower() { return 2n; },
    async getCurrentDelegate(address) {
      assert.equal(address, COLD);
      return delegateRef.value;
    },
    async hasVoted() { return false; },
    async prepareVote() {},
  };
}

async function status(mode, executionAddress, delegateRef) {
  return resolveExecutionReadiness({
    adapter: adapter(delegateRef),
    mode,
    modelAddress: MODEL,
    assetOwnerAddress: COLD,
    executionAddress,
  });
}

test("keeps model, asset owner, and execution address as independent roles", async () => {
  const result = await status(ExecutionMode.SAFE_SUPERVISED, SAFE, { value: SAFE });
  assert.equal(result.modelAddress, MODEL);
  assert.equal(result.assetOwnerAddress, COLD);
  assert.equal(result.executionAddress, SAFE);
  assert.equal(result.requiredDelegateAddress, SAFE);
  assert.equal(result.delegationReady, true);
  assert.equal(result.canVote, true);
});

test("mode switching requires explicit Safe to WaaP redelegation and supports the reverse", async () => {
  const delegate = { value: SAFE };
  assert.equal((await status(ExecutionMode.SAFE_SUPERVISED, SAFE, delegate)).canVote, true);
  const waapBlocked = await status(ExecutionMode.WAAP_AUTONOMOUS, WAAP, delegate);
  assert.equal(waapBlocked.redelegationRequired, true);
  assert.equal(waapBlocked.canVote, false);
  delegate.value = WAAP;
  assert.equal((await status(ExecutionMode.WAAP_AUTONOMOUS, WAAP, delegate)).canVote, true);
  const safeBlocked = await status(ExecutionMode.SAFE_SUPERVISED, SAFE, delegate);
  assert.equal(safeBlocked.redelegationRequired, true);
  assert.equal(safeBlocked.canVote, false);
});

test("RPC uncertainty fails readiness closed", async () => {
  const broken = adapter({ value: SAFE });
  broken.getVotingPower = async () => { throw new Error("RPC timeout"); };
  await assert.rejects(
    resolveExecutionReadiness({ adapter: broken, mode: ExecutionMode.SAFE_SUPERVISED, modelAddress: MODEL, assetOwnerAddress: COLD, executionAddress: SAFE }),
    /failed closed: RPC timeout/,
  );
});
