const assert = require("node:assert/strict");
const test = require("node:test");

const { NounsDaoAdapter, NounsSubgraphHistoryAdapter } = require("../packages/nouns-adapter");

const ADDRESS = "0x0000000000000000000000000000000000000001";
const DELEGATE = "0x0000000000000000000000000000000000000002";

test("canonical Nouns facade exposes deliberate capabilities and stable governance methods", async () => {
  const adapter = new NounsDaoAdapter({
    provider: {},
    governance: { async getReceipt() { return { hasVoted: true }; } },
    nounsToken: {
      async getCurrentVotes() { return 3n; },
      async getPriorVotes() { return 2n; },
      async delegates() { return DELEGATE; },
    },
  });
  assert.equal(adapter.id, "nouns");
  assert.equal(adapter.chainId, 1);
  assert.deepEqual(adapter.supportedActions, ["CAST_VOTE"]);
  assert.equal(adapter.capabilities.safeSupervised, true);
  assert.equal(adapter.capabilities.waapAutonomous, true);
  assert.equal(await adapter.getVotingPower(ADDRESS), 3n);
  assert.equal(await adapter.getVotingPower(ADDRESS, 100), 2n);
  assert.equal(await adapter.getCurrentDelegate(ADDRESS), DELEGATE);
  assert.equal(await adapter.hasVoted("42", ADDRESS), true);
  assert.ok(adapter.history({ fetch: async () => {} }) instanceof NounsSubgraphHistoryAdapter);
});
