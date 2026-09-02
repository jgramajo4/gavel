const test = require("node:test");
const assert = require("node:assert/strict");

const {
  Support,
  historyDocumentSchema,
} = require("../packages/core/src/schema/governance");
const {
  normalizeVote,
  proposalContentHash,
  proposalOutcome,
  supportFromNouns,
} = require("../packages/nouns-adapter/src/history");

const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";

function rawVote(overrides = {}) {
  return {
    id: `${VOTER.toLowerCase()}-42`,
    supportDetailed: 1,
    votesRaw: "3",
    reason: "Small, measurable public-goods spend.",
    blockNumber: "200",
    blockTimestamp: "1700000100",
    transactionHash: `0x${"ab".repeat(32)}`,
    clientId: 38,
    voter: { id: VOTER.toLowerCase() },
    proposal: {
      id: "42",
      title: "Fund a public good",
      description: "Untrusted proposal prose",
      status: "ACTIVE",
      proposer: { id: "0x0000000000000000000000000000000000000001" },
      targets: ["0x0000000000000000000000000000000000000002"],
      values: ["1000000000000000000"],
      signatures: ["transfer(address,uint256)"],
      calldatas: ["0x1234"],
      createdTimestamp: "1700000000",
      createdBlock: "100",
      startBlock: "150",
      endBlock: "190",
      quorumVotes: "10",
      forVotes: "12",
      againstVotes: "2",
      abstainVotes: "1",
    },
    ...overrides,
  };
}

test("maps the Nouns support enum and rejects unknown values", () => {
  assert.equal(supportFromNouns(0), Support.AGAINST);
  assert.equal(supportFromNouns("1"), Support.FOR);
  assert.equal(supportFromNouns(2), Support.ABSTAIN);
  assert.throws(() => supportFromNouns(3), /Unknown Nouns support/);
});

test("normalizes a vote with preserved reason, actions, and provenance", () => {
  const normalized = normalizeVote(rawVote(), {
    endpoint: "https://example.test/subgraph",
    queriedAt: "2026-08-26T12:00:00.000Z",
    subgraphBlock: "250",
  });

  assert.equal(normalized.support, Support.FOR);
  assert.equal(normalized.reason, "Small, measurable public-goods spend.");
  assert.equal(normalized.voteWeight, "3");
  assert.equal(normalized.clientId, 38);
  assert.equal(normalized.proposal.outcome, "SUCCEEDED");
  assert.deepEqual(normalized.proposal.actions[0], {
    index: 0,
    target: "0x0000000000000000000000000000000000000002",
    valueWei: "1000000000000000000",
    signature: "transfer(address,uint256)",
    calldata: "0x1234",
  });
  assert.equal(normalized.source.entityId, `${VOTER.toLowerCase()}-42`);
});

test("content hashes change when executable actions change", () => {
  const proposal = rawVote().proposal;
  const original = proposalContentHash(proposal);
  const modified = proposalContentHash({ ...proposal, values: ["2"] });
  assert.notEqual(original, modified);
});

test("derives a completed proposal outcome from tallies without trusting ACTIVE", () => {
  const proposal = rawVote().proposal;
  assert.equal(proposalOutcome(proposal, "250"), "SUCCEEDED");
  assert.equal(
    proposalOutcome({ ...proposal, forVotes: "2", againstVotes: "12" }, "250"),
    "DEFEATED",
  );
  assert.equal(proposalOutcome(proposal, "180"), "ACTIVE");
});

test("history schema rejects inconsistent vote counts", () => {
  const vote = normalizeVote(rawVote(), {
    endpoint: "https://example.test/subgraph",
    queriedAt: "2026-08-26T12:00:00.000Z",
    subgraphBlock: "250",
  });
  const document = {
      schemaVersion: "1.0.0",
      dao: "nouns",
      chainId: 1,
      voter: VOTER,
      generatedAt: "2026-08-26T12:00:00.000Z",
      source: {
        kind: "nouns-subgraph",
        endpoint: "https://example.test/subgraph",
        subgraphBlock: "250",
      },
      voteCount: 2,
      votes: [vote],
  };
  assert.throws(() => historyDocumentSchema.parse(document), /voteCount must equal/);
});
