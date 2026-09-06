const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { Interface, getAddress, keccak256, toUtf8Bytes } = require("ethers");

const {
  DAO_CONFIGS,
  MemoryGovernanceStore,
  GovernanceSyncWorker,
  EnsGovernorSource,
  RailgunVotingSource,
  createReadOnlyApi,
  proposalContentHash,
} = require("../packages/governance-index");

const ADDRESS = getAddress("0x0000000000000000000000000000000000000001");
const OTHER = getAddress("0x0000000000000000000000000000000000000002");
const TX = `0x${"ab".repeat(32)}`;
const TX2 = `0x${"cd".repeat(32)}`;
const TX3 = `0x${"ef".repeat(32)}`;

function ensFixture() {
  const iface = new Interface([
    "event ProposalCreated(uint256 proposalId,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)",
    "event VoteCast(address indexed voter,uint256 proposalId,uint8 support,uint256 weight,string reason)",
  ]);
  const targets = [OTHER]; const values = [0n]; const signatures = [""]; const calldatas = ["0x1234"];
  const description = "# Test proposal\nBody";
  const proposalId = BigInt(keccak256(new (require("ethers").AbiCoder)().encode(
    ["address[]", "uint256[]", "bytes[]", "bytes32"], [targets, values, calldatas, keccak256(toUtf8Bytes(description))],
  ))).toString();
  const created = iface.encodeEventLog(iface.getEvent("ProposalCreated"), [proposalId, ADDRESS, targets, values, signatures, calldatas, 101n, 201n, description]);
  const vote = iface.encodeEventLog(iface.getEvent("VoteCast"), [ADDRESS, proposalId, 2, 99n, "because"]);
  return { proposalId, logs: [
    { address: DAO_CONFIGS.ens.contractAddress, blockNumber: 100, transactionHash: TX, index: 0, topics: created.topics, data: created.data },
    { address: DAO_CONFIGS.ens.contractAddress, blockNumber: 150, transactionHash: TX2, index: 4, topics: vote.topics, data: vote.data },
  ] };
}

async function request(server, path, options = {}) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { return await fetch(`http://127.0.0.1:${port}${path}`, options); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("sync is idempotent, canonical events are unique, and checkpoints resume with trailing replay", async () => {
  const store = new MemoryGovernanceStore();
  const fixture = ensFixture();
  const calls = [];
  const governor = {
    async state(){ return 1; },
    async proposalSnapshot(){ return 101n; },
    async proposalDeadline(){ return 201n; },
    async proposalVotes(){ return [0n, 0n, 1n]; },
    async quorum(){ return 1n; },
  };
  const source = new EnsGovernorSource({
    rpcUrl: "https://rpc.example", fromBlock: 100, finalityDepth: 5, replayBlocks: 10,
    governor,
    provider: {
      async getBlockNumber() { return 205; },
      async getLogs(filter) { calls.push(filter); return fixture.logs.filter((x) => x.blockNumber >= filter.fromBlock && x.blockNumber <= filter.toBlock); },
      async getBlock(block) { return { timestamp: 1_700_000_000 + block }; },
    },
  });
  const worker = new GovernanceSyncWorker({ store, sources: { ens: source }, batchSize: 1000 });
  await worker.syncDao("ens");
  await worker.syncDao("ens");
  assert.equal(store.rawRecords.length, 2);
  assert.equal(store.proposals.length, 1);
  assert.equal(store.voteEvents.length, 1);
  assert.equal(store.voteEvents[0].support, "ABSTAIN");
  assert.equal(store.voteEvents[0].reason, "because");
  assert.equal(store.checkpoints.get("ens:governor-logs").nextBlock, 201);
  const rangeCalls = calls.filter((filter) => Array.isArray(filter.topics?.[0]));
  assert.equal(rangeCalls[1].fromBlock, 190);
});

test("failed batches do not advance checkpoints and DAO records stay isolated", async () => {
  const store = new MemoryGovernanceStore();
  const ok = new EnsGovernorSource({ rpcUrl: "https://rpc.example", fromBlock: 100, finalityDepth: 0, provider: { async getBlockNumber(){ return 110; }, async getLogs(){ throw new Error("boom"); } } });
  await assert.rejects(new GovernanceSyncWorker({ store, sources: { ens: ok } }).syncDao("ens"), /boom/);
  assert.equal(store.checkpoints.size, 1);
  assert.match(store.checkpoints.get("ens:governor-logs").lastError, /boom/);
  await store.transaction(async (tx) => {
    tx.upsertDao({ id: "nouns", chainId: 1 }); tx.upsertDao({ id: "ens", chainId: 1 });
    tx.upsertProposal({ daoId: "nouns", proposalId: "1", contentHash: "a".repeat(64), normalized: { id: "1" } });
    tx.upsertProposal({ daoId: "ens", proposalId: "1", contentHash: "b".repeat(64), normalized: { id: "1" } });
  });
  assert.equal((await store.listProposals({ daoId: "ens", limit: 10 })).items[0].id, "1");
});

test("ENS proposal hash mismatch fails closed", async () => {
  const fixture = ensFixture();
  const bad = structuredClone(fixture.logs[0]);
  const iface = new Interface(["event ProposalCreated(uint256 proposalId,address proposer,address[] targets,uint256[] values,string[] signatures,bytes[] calldatas,uint256 startBlock,uint256 endBlock,string description)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("ProposalCreated"), [1n, ADDRESS, [OTHER], [0n], [""], ["0x1234"], 101n, 201n, "# bad"]);
  bad.topics = encoded.topics; bad.data = encoded.data;
  const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider: { async getBlock(){ return { timestamp: 1_700_000_000 }; } } });
  await assert.rejects(source.normalizeLog(bad, "200"), /hash mismatch/i);
});

test("ENS proposal enumeration refreshes canonical state and tallies at the finalized head", async () => {
  const fixture = ensFixture();
  const calls = [];
  const governor = {
    async state(id, overrides){ calls.push(["state", id, overrides]); return 4; },
    async proposalSnapshot(id, overrides){ calls.push(["snapshot", id, overrides]); return 101n; },
    async proposalDeadline(id, overrides){ calls.push(["deadline", id, overrides]); return 201n; },
    async proposalVotes(id, overrides){ calls.push(["votes", id, overrides]); return [2n, 3n, 4n]; },
    async quorum(block, overrides){ calls.push(["quorum", block, overrides]); return 5n; },
  };
  const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example", fromBlock: 100, governor, provider: {
    async getLogs(filter){ return fixture.logs.filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock && log.transactionHash === TX); },
    async getBlock(block){ return { timestamp: 1_700_000_000 + block }; },
  } });
  const [record] = await source.fetchProposals(100, 200, 200);
  assert.equal(record.raw.recordType, "proposal");
  assert.equal(record.raw.transactionHash, TX);
  assert.equal(record.proposal.normalized.state, "SUCCEEDED");
  assert.equal(record.proposal.normalized.outcome, "SUCCEEDED");
  assert.equal(record.proposal.normalized.forVotes, "3");
  assert.equal(record.proposal.normalized.againstVotes, "2");
  assert.equal(record.proposal.normalized.abstainVotes, "4");
  assert.equal(record.proposal.normalized.quorumVotes, "5");
  assert.ok(calls.every((call) => call.at(-1).blockTag === 200));
});

test("ENS proposal enumeration batches historical log requests", async () => {
  const ranges = [];
  const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example/private", sourcePublicEndpoint: "https://docs.example/ethereum", fromBlock: 100, proposalBatchSize: 50, governor: {}, provider: {
    async getLogs(filter){ ranges.push([filter.fromBlock, filter.toBlock]); return []; },
    async getBlock(){ return { timestamp: 1_700_000_000 }; },
  } });
  await source.fetchProposals(100, 220, 220);
  assert.deepEqual(ranges, [[100,149],[150,199],[200,220]]);
});

test("ENS adapter loads indexed metadata, live-verifies views, and fails closed on hash drift", async () => {
  const { EnsDaoAdapter } = require("../packages/ens-adapter");
  const fixture = ensFixture();
  const source = new EnsGovernorSource({ rpcUrl: "https://rpc.example", provider: { async getBlock(){ return { timestamp: 1_700_000_000 }; } } });
  const indexed = (await source.normalizeLog(fixture.logs[0], "200")).proposal.normalized;
  const governor = { async state(){ return 7; }, async proposalSnapshot(){ return 101n; }, async proposalDeadline(){ return 201n; }, async proposalVotes(){ return [2n, 3n, 4n]; }, async quorum(){ return 1n; }, async hashProposal(){ return BigInt(fixture.proposalId); } };
  const adapter = new EnsDaoAdapter({ provider: {}, governor, token: {}, proposalLoader: async () => indexed });
  const proposal = await adapter.fetchProposal(fixture.proposalId);
  assert.equal(proposal.state, "EXECUTED"); assert.equal(proposal.forVotes, "3");
  const bad = new EnsDaoAdapter({ provider: {}, governor: { ...governor, async hashProposal(){ return 1n; } }, token: {}, proposalLoader: async () => indexed });
  await assert.rejects(bad.fetchProposal(fixture.proposalId), /hash differs/i);
});

test("Railgun maps bool support, preserves multiple votes, and never invents reasons", async () => {
  const iface = new Interface(["event VoteCast(uint256 indexed id,address indexed voter,bool affirmative,uint256 votes)"]);
  const logs = [true, false].map((support, index) => {
    const encoded = iface.encodeEventLog(iface.getEvent("VoteCast"), [3n, ADDRESS, support, BigInt(index + 1)]);
    return { address: DAO_CONFIGS["railgun-eth"].contractAddress, blockNumber: 10 + index, transactionHash: index ? TX2 : TX, index, topics: encoded.topics, data: encoded.data };
  });
  const source = new RailgunVotingSource({ rpcUrl: "https://rpc.example", fromBlock: 1, provider: { async getBlock(block){ return { timestamp: 1_700_000_000 + block }; } } });
  const rows = await Promise.all(logs.map((x) => source.normalizeLog(x, "20")));
  assert.deepEqual(rows.map((x) => x.vote.support), ["FOR", "AGAINST"]);
  assert.deepEqual(rows.map((x) => x.vote.reason), [null, null]);
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => rows.forEach((x) => tx.ingest(x)));
  assert.equal(store.voteEvents.length, 2);
});

test("read-only API validates pagination, paginates history, and exposes no mutation route", async () => {
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => {
    tx.upsertDao({ id: "ens", chainId: 1 });
    tx.upsertProposal({ daoId: "ens", proposalId: "9", contentHash: "a".repeat(64), normalized: { id: "9", title: "x" } });
    tx.insertVote({ daoId: "ens", chainId: 1, proposalId: "9", voter: ADDRESS, support: "FOR", reason: null, voteWeight: "1", blockNumber: "3", transactionHash: TX, logIndex: 0, normalized: { proposalId: "9" } });
  });
  let response = await request(createReadOnlyApi({ store }), "/v1/daos/ens/voters/0x0000000000000000000000000000000000000001/history?limit=1");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, 1);
  response = await request(createReadOnlyApi({ store }), "/v1/daos/ens/proposals?limit=0");
  assert.equal(response.status, 400);
  response = await request(createReadOnlyApi({ store }), "/v1/daos/ens/proposals", { method: "POST" });
  assert.equal(response.status, 405);
});

test("indexed history materializes the existing history schema without collapsing Railgun votes", async () => {
  const { IndexApiClient } = require("../packages/governance-index");
  const proposal = { id: "3", contentHash: "f".repeat(64), title: "Railgun proposal 3", description: "ipfs://cid", proposer: ADDRESS, state: "ACTIVE", outcome: "ACTIVE", createdBlock: "0", createdAt: "2023-11-14T22:13:20.000Z", startBlock: "0", endBlock: "0", quorumVotes: "1", forVotes: "3", againstVotes: "0", abstainVotes: "0", actions: [], dao: "railgun-eth", chainId: 1, venue: "railgun-voting", timing: "timestamp", startTime: null, endTime: null, choices: ["AGAINST", "FOR"] };
  const events = [0, 1].map((logIndex) => ({ daoId: "railgun-eth", chainId: 1, contractAddress: DAO_CONFIGS["railgun-eth"].contractAddress, proposalId: "3", voter: ADDRESS, support: logIndex ? "AGAINST" : "FOR", reason: null, voteWeight: "1", blockNumber: String(10 + logIndex), timestamp: "2023-11-14T22:13:20.000Z", transactionHash: logIndex ? TX2 : TX, logIndex, sourceKind: "railgun-voting-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" }));
  const client = new IndexApiClient({ baseUrl: "http://index.example", fetch: async (url) => ({ ok: true, status: 200, async json() { return url.includes("/proposals/3") ? proposal : { items: events, nextCursor: null }; } }) });
  const history = await client.fetchHistory("railgun-eth", ADDRESS);
  assert.equal(history.voteCount, 2);
  assert.equal(history.votes[0].proposal.id, "3");
  assert.equal(history.votes[1].reason, null);
});

test("provenance is exact and proposal hashing follows the shared canonical material", () => {
  assert.equal(DAO_CONFIGS.ens.source.endpoint, "ethereum-json-rpc");
  assert.equal(DAO_CONFIGS.ens.fromBlock > 0, true);
  assert.equal(DAO_CONFIGS["railgun-eth"].fromBlock, 15505853);
  assert.equal(proposalContentHash({ description: "d", targets: [], values: [], signatures: [], calldatas: [] }).length, 64);
});

test("API exposes the documented read-only endpoint set", async () => {
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => tx.upsertDao({ id: "ens", chainId: 1 }));
  for (const endpoint of ["/health", "/v1/daos", "/v1/daos/ens", "/v1/daos/ens/votes", "/v1/daos/ens/sync-status"]) {
    const response = await request(createReadOnlyApi({ store }), endpoint);
    assert.notEqual(response.status, 404, endpoint);
  }
});

test("deployment artifacts keep Postgres private and run the app as non-root", () => {
  const root = path.resolve(__dirname, "..");
  const compose = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(compose, /internal:\s*true/);
  const postgresService = compose.slice(compose.indexOf("  postgres:"), compose.indexOf("  migrate:"));
  assert.doesNotMatch(postgresService, /ports:/);
  assert.match(compose, /healthcheck:/);
  assert.match(dockerfile, /USER node/);
});

test("migration includes canonical and raw provenance columns and critical indexes", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../packages/governance-index/migrations/001_initial.sql"), "utf8");
  for (const token of ["governance_type", "current_governor", "external_id", "content_hash", "ingested_at", "proposal_status", "proposals_status_idx", "raw_governance_external_id_idx"]) assert.match(sql, new RegExp(token));
});

test("Nouns backfill source imports normalized votes and enumerated proposals", async () => {
  const { NounsSubgraphSource } = require("../packages/governance-index");
  const rawVote = { id: "vote-1", supportDetailed: 1, votesRaw: "1", reason: "", blockNumber: "12985438", blockTimestamp: "1700000000", transactionHash: TX, clientId: 0, voter: { id: ADDRESS }, proposal: { id: "1", title: "Nouns", description: "body", status: "ACTIVE", proposer: { id: OTHER }, targets: [], values: [], signatures: [], calldatas: [], createdTimestamp: "1699999000", createdBlock: "12985438", startBlock: "12985440", endBlock: "12985500", quorumVotes: "1", forVotes: "1", againstVotes: "0", abstainVotes: "0" } };
  const source = new NounsSubgraphSource({ finalityDepth: 0, fetch: async (_url, init) => ({ ok: true, async json(){ const { query, variables } = JSON.parse(init.body); if (query.includes("_meta")) return { data: { _meta: { block: { number: 12985438 } } } }; if (query.includes("proposals(")) return { data: { proposals: variables.after === "" ? [rawVote.proposal] : [] } }; return { data: { votes: variables.after === "" ? [rawVote] : [] } }; } }), pageSize: 1 });
  const store = new MemoryGovernanceStore();
  const result = await new GovernanceSyncWorker({ store, sources: { nouns: source } }).syncDao("nouns");
  assert.equal(result.records, 2);
  assert.equal(store.proposals[0].proposalId, "1");
  assert.equal(store.voteEvents[0].normalized.dao, "nouns");
});
