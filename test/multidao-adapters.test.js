const assert = require("node:assert/strict");
const test = require("node:test");
const { id } = require("ethers");

const { assertDaoAdapter } = require("../packages/core/src/dao/registry");
const {
  ENS_GOVERNOR_ADDRESS,
  ENS_TOKEN_ADDRESS,
  EnsDaoAdapter,
  proposalIdentityInput,
} = require("../packages/ens-adapter");
const {
  QUORUM,
  RAILGUN_STAKING_ADDRESS,
  RAILGUN_VOTING_ADDRESS,
  RailgunDaoAdapter,
  findAccountSnapshotHint,
  stateAt,
} = require("../packages/railgun-adapter");

const ADDRESS = "0x0000000000000000000000000000000000000001";
const DELEGATE = "0x0000000000000000000000000000000000000002";

test("ENS facade exposes canonical contracts and Governor capabilities", async () => {
  const adapter = new EnsDaoAdapter({
    provider: {},
    governor: {
      async hasVoted() { return true; },
    },
    token: {
      async getVotes() { return 8n; },
      async getPastVotes() { return 5n; },
      async delegates() { return DELEGATE; },
    },
  });
  assert.equal(assertDaoAdapter(adapter), adapter);
  assert.equal(adapter.id, "ens");
  assert.equal(adapter.governanceContracts.governor, ENS_GOVERNOR_ADDRESS);
  assert.equal(adapter.governanceContracts.token, ENS_TOKEN_ADDRESS);
  assert.equal(adapter.capabilities.safeSupervised, true);
  assert.equal(adapter.capabilities.waapAutonomous, false);
  assert.equal(await adapter.getVotingPower(ADDRESS), 8n);
  assert.equal(await adapter.getVotingPower(ADDRESS, 100), 5n);
  assert.equal(await adapter.getCurrentDelegate(ADDRESS), DELEGATE);
  assert.equal(await adapter.hasVoted("1", ADDRESS), true);
});

test("ENS proposal hashing restores legacy signatures before Governor hashProposal", () => {
  const input = proposalIdentityInput({
    description: "Upgrade resolver",
    actions: [{
      index: 0,
      target: ADDRESS,
      valueWei: "0",
      signature: "setResolver(bytes32,address)",
      calldata: "0x1234",
    }],
  });
  assert.equal(input.calldatas[0], `${id("setResolver(bytes32,address)").slice(0, 10)}1234`);
  assert.equal(input.targets[0], ADDRESS);
});

test("Railgun facade is Ethereum-only and refuses autonomous executor modes", async () => {
  const adapter = new RailgunDaoAdapter({
    provider: {},
    voting: { async getVotes() { return 3n; } },
    staking: { async votingPower() { return 9n; } },
  });
  assert.equal(assertDaoAdapter(adapter), adapter);
  assert.equal(adapter.id, "railgun-eth");
  assert.equal(adapter.governanceContracts.governor, RAILGUN_VOTING_ADDRESS);
  assert.equal(adapter.governanceContracts.staking, RAILGUN_STAKING_ADDRESS);
  assert.equal(adapter.capabilities.safeSupervised, false);
  assert.equal(adapter.capabilities.waapAutonomous, false);
  assert.equal(await adapter.getVotingPower(ADDRESS), 9n);
  assert.equal(await adapter.hasVoted("2", ADDRESS), true);
  await assert.rejects(adapter.prepareVote({ selectedSupport: "ABSTAIN" }), /does not support ABSTAIN/);
});

test("Railgun state uses asymmetric Yay and Nay windows and Yay-only quorum", () => {
  const proposal = [false, ADDRESS, "cid", 100, 1_000, 0, QUORUM, QUORUM + 1n, 1, 2];
  assert.equal(stateAt(proposal, 1_000 + 2 * 86400, "FOR").label, "REVIEW");
  assert.equal(stateAt(proposal, 1_000 + 3 * 86400, "FOR").label, "ACTIVE");
  assert.equal(stateAt(proposal, 1_000 + 5 * 86400 + 1, "FOR").label, "DEFEATED");
  assert.equal(stateAt(proposal, 1_000 + 5 * 86400 + 1, "AGAINST").label, "ACTIVE_NAY_ONLY");
});

test("Railgun hint solver returns the first snapshot at or after the voting interval", async () => {
  const intervals = [2n, 5n, 9n, 15n];
  const staking = {
    async accountSnapshotLength() { return intervals.length; },
    async accountSnapshot(_account, index) { return { interval: intervals[index], votingPower: 1n }; },
  };
  assert.equal(await findAccountSnapshotHint(staking, ADDRESS, 1), 0);
  assert.equal(await findAccountSnapshotHint(staking, ADDRESS, 9), 2);
  assert.equal(await findAccountSnapshotHint(staking, ADDRESS, 12), 3);
  assert.equal(await findAccountSnapshotHint(staking, ADDRESS, 20), 4);
});
