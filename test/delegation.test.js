const assert = require("node:assert/strict");
const test = require("node:test");

const { NounsDelegationPreparationAdapter } = require("../packages/nouns-adapter/src/delegation");
const { NOUNS_TOKEN_ADDRESS } = require("../packages/nouns-adapter/src/vote");

const COLD = "0x0000000000000000000000000000000000000002";
const SAFE = "0x0000000000000000000000000000000000000003";
const WAAP = "0x0000000000000000000000000000000000000004";

function fixture(currentDelegate) {
  const calls = [];
  return {
    calls,
    adapter: new NounsDelegationPreparationAdapter({
      provider: {
        async getNetwork() { calls.push("network"); return { chainId: 1n }; },
        async getCode(address) { calls.push(["code", address]); return "0x1234"; },
      },
      token: {
        async delegates(address) { calls.push(["delegates", address]); return currentDelegate; },
      },
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    }),
  };
}

test("prepares explicit unsigned delegation calldata and discloses the address transition", async () => {
  const { adapter, calls } = fixture(SAFE);
  const result = await adapter.prepare({ assetOwnerAddress: COLD, requiredDelegateAddress: WAAP });
  assert.equal(result.currentDelegateAddress, SAFE);
  assert.equal(result.requiredDelegateAddress, WAAP);
  assert.equal(result.delegationChangeRequired, true);
  assert.match(result.disclosure, new RegExp(`${SAFE}.*${WAAP}`, "i"));
  assert.equal(result.transaction.target, NOUNS_TOKEN_ADDRESS);
  assert.equal(result.transaction.executionAddress, COLD);
  assert.equal(result.transaction.action, "DELEGATE_VOTES");
  assert.equal(result.transaction.value, "0");
  assert.equal(calls.some((entry) => Array.isArray(entry) && entry[0] === "delegates"), true);
});

test("does not prepare redundant delegation and fails closed on the wrong chain", async () => {
  const configured = fixture(WAAP);
  const result = await configured.adapter.prepare({ assetOwnerAddress: COLD, requiredDelegateAddress: WAAP });
  assert.equal(result.status, "ALREADY_CONFIGURED");
  assert.equal(result.transaction, null);

  const broken = fixture(SAFE);
  broken.adapter.provider.getNetwork = async () => ({ chainId: 10n });
  await assert.rejects(
    broken.adapter.prepare({ assetOwnerAddress: COLD, requiredDelegateAddress: WAAP }),
    /not Ethereum mainnet/,
  );
});
