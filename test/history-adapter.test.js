const test = require("node:test");
const assert = require("node:assert/strict");

const { NounsSubgraphHistoryAdapter } = require("../src/adapters/nouns/history");

const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";

function vote(id, blockNumber) {
  return {
    id: `${VOTER.toLowerCase()}-${id}`,
    supportDetailed: id % 3,
    votesRaw: "1",
    reason: id === 1 ? "A preserved reason" : null,
    blockNumber: String(blockNumber),
    blockTimestamp: String(1700000000 + blockNumber),
    transactionHash: `0x${String(id).padStart(64, "0")}`,
    clientId: 0,
    voter: { id: VOTER.toLowerCase() },
    proposal: {
      id: String(id),
      title: `Proposal ${id}`,
      description: `Untrusted proposal ${id}`,
      status: "EXECUTED",
      proposer: { id: "0x0000000000000000000000000000000000000001" },
      targets: [],
      values: [],
      signatures: [],
      calldatas: [],
      createdTimestamp: "1700000000",
      createdBlock: "10",
      startBlock: "20",
      endBlock: "30",
      quorumVotes: "1",
      forVotes: "2",
      againstVotes: "0",
      abstainVotes: "0",
    },
  };
}

test("paginates voter history and produces one validated document", async () => {
  const calls = [];
  const pages = [[vote(1, 100), vote(2, 200)], [vote(3, 300)], []];
  const fakeFetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request.variables);
    const current = pages[calls.length - 1];
    return new Response(
      JSON.stringify({ data: { _meta: { block: { number: "999" } }, votes: current } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const adapter = new NounsSubgraphHistoryAdapter({
    endpoint: "https://example.test/subgraph",
    pageSize: 2,
    fetch: fakeFetch,
  });
  const history = await adapter.fetchHistory(VOTER);

  assert.equal(history.voteCount, 3);
  assert.deepEqual(calls.map((call) => call.skip), [0, 2]);
  assert.ok(calls.every((call) => call.voter === VOTER.toLowerCase()));
  assert.equal(history.votes[0].reason, "A preserved reason");
  assert.equal(history.source.subgraphBlock, "999");
});

test("fails closed on GraphQL errors", async () => {
  const adapter = new NounsSubgraphHistoryAdapter({
    endpoint: "https://example.test/subgraph",
    fetch: async () => new Response(JSON.stringify({ errors: [{ message: "bad query" }] })),
  });
  await assert.rejects(() => adapter.fetchHistory(VOTER), /Nouns subgraph error/);
});
