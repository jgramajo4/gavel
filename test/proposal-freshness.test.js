const test = require("node:test");
const assert = require("node:assert/strict");

const { canonicalProposalVersion, proposalEvents } = require("../packages/nouns-adapter/src/freshness");

const GOVERNANCE = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";
const PROPOSER = "0x3333333333333333333333333333333333333333";
const TARGET = "0x2222222222222222222222222222222222222222";

function eventLog(name, args, blockNumber, index) {
  const fragment = proposalEvents.getEvent(name);
  const encoded = proposalEvents.encodeEventLog(fragment, args);
  return { address: GOVERNANCE, blockNumber, index, transactionHash: `0x${String(blockNumber).padStart(64, "0")}`, ...encoded };
}

test("reconstructs description-only and action proposal versions from canonical events", async () => {
  const created = eventLog("ProposalCreated", [42n, PROPOSER, [TARGET], [0n], ["ping()"], ["0x"], 100n, 200n, "Original"], 90, 0);
  const description = eventLog("ProposalDescriptionUpdated", [42n, PROPOSER, "Revised", "clarify"], 92, 1);
  const transactions = eventLog("ProposalTransactionsUpdated", [42n, PROPOSER, [TARGET], [1n], ["ping()"], ["0x12"], "fix"], 93, 0);
  const provider = { getLogs: async (filter) => filter.fromBlock === filter.toBlock ? [created] : [description, transactions] };

  const result = await canonicalProposalVersion(provider, GOVERNANCE, "42", "90", 150);
  assert.equal(result.version, 3);
  assert.equal(result.description, "Revised");
  assert.deepEqual(result.actions.values, ["1"]);
  assert.equal(result.actions.calldatas[0], "0x12");
  assert.equal(result.latestEvent, "ProposalTransactionsUpdated");
});

test("rejects a missing canonical creation event", async () => {
  const provider = { getLogs: async () => [] };
  await assert.rejects(() => canonicalProposalVersion(provider, GOVERNANCE, "42", "90", 150), /ProposalCreated event not found/);
});
