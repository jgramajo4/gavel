const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Interface, getAddress } = require("ethers");
const { DAO_CONFIGS, MemoryGovernanceStore, PostgresGovernanceStore, GovernanceSyncWorker, EnsGovernorSource, RailgunVotingSource, NounsSubgraphSource, createReadOnlyApi } = require("../packages/governance-index");
const { PostgresTransaction } = require("../packages/governance-index/src/postgres-store");
const { encodeProposalCursor } = require("../packages/governance-index/src/memory-store");
const { buildRuntime, healthStatus } = require("../packages/governance-index/bin/gavel-indexer");
const { redactErrorMessage } = require("../packages/governance-index/src/redaction");
const { sanitizeConfig } = require("../packages/governance-index/src/provenance");

const ADDRESS = getAddress("0x0000000000000000000000000000000000000001");
const OTHER = getAddress("0x0000000000000000000000000000000000000002");
const TX = `0x${"ab".repeat(32)}`;
const TX2 = `0x${"cd".repeat(32)}`;
const TX3 = `0x${"ef".repeat(32)}`;

async function request(server, route) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fetch(`http://127.0.0.1:${server.address().port}${route}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function vote(transactionHash) {
  return { daoId: "ens", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, proposalId: "1", voter: ADDRESS, support: "FOR", reason: null, voteWeight: "1", blockNumber: "10", timestamp: new Date(0).toISOString(), transactionHash, logIndex: 0, sourceKind: "ens-governor-logs", sourceEndpoint: "https://alice:secret@rpc.example/v2/API_KEY?token=hidden#secret", observedHead: "10" };
}

test("credential-bearing transport URLs are never persisted in governance data", async () => {
  for (const [index, sourceEndpoint] of [
    "https://eth-mainnet.g.alchemy.com/v2/SECRET",
    "https://mainnet.infura.io/v3/SECRET",
  ].entries()) {
    const store = new MemoryGovernanceStore();
    await store.transaction(async (tx) => {
      tx.upsertDao({ ...DAO_CONFIGS.ens, config: { endpoint: sourceEndpoint } });
      tx.upsertSource({ daoId: "ens", id: "governor-logs", kind: "ens-governor-logs", endpoint: sourceEndpoint, config: { endpoint: sourceEndpoint }, fromBlock: 1 });
      tx.ingest({
        raw: { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: index ? TX2 : TX, logIndex: 0, blockNumber: "10", blockHash: null, recordType: "vote", payload: {}, sourceKind: "ens-governor-logs", sourceEndpoint, observedHead: "10" },
        vote: { ...vote(index ? TX2 : TX), sourceEndpoint },
      });
      tx.insertDelegation({ daoId: "ens", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, delegator: ADDRESS, delegatee: OTHER, blockNumber: "10", timestamp: new Date(0).toISOString(), transactionHash: TX3, logIndex: index, sourceKind: "ens-governor-logs", sourceEndpoint });
    });
    for (const route of ["/v1/daos/ens/votes", `/v1/daos/ens/voters/${ADDRESS}/history`]) {
      const response = await request(createReadOnlyApi({ store }), route);
      const body = await response.json();
      assert.equal(body.items[0].sourceEndpoint, new URL(sourceEndpoint).origin);
      assert.doesNotMatch(JSON.stringify(body), /SECRET|\/v2\/|\/v3\//);
    }
    const persisted = JSON.stringify({ daos: [...store.daos.values()], sources: [...store.sources.values()], raw: store.rawRecords, votes: store.voteEvents, delegations: store.delegationEvents });
    assert.doesNotMatch(persisted, /SECRET|\/v2\/|\/v3\//);
    assert.equal(store.rawRecords[0].sourceEndpoint, new URL(sourceEndpoint).origin);
    assert.equal(store.voteEvents[0].sourceEndpoint, new URL(sourceEndpoint).origin);
    assert.equal(store.delegationEvents[0].sourceEndpoint, new URL(sourceEndpoint).origin);
  }
});

test("explicit public source endpoint is emitted instead of private transport provenance", async () => {
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => tx.insertVote({
    ...vote(TX),
    sourceEndpoint: "https://private.example/token/SECRET",
    sourcePublicEndpoint: "https://docs.example/json-rpc",
  }));
  const response = await request(createReadOnlyApi({ store }), "/v1/daos/ens/votes");
  const body = await response.json();
  assert.equal(body.items[0].sourceEndpoint, "https://docs.example/json-rpc");
  assert.equal("sourcePublicEndpoint" in body.items[0], false);
  assert.doesNotMatch(JSON.stringify(body), /private|SECRET/);
});

test("vote cursor is unique when events share a block and log index", async () => {
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => { for (const hash of [TX, TX2, TX3]) tx.insertVote({ ...vote(hash), sourceEndpoint: "https://rpc.example" }); });
  const seen = []; let cursor = null;
  do { const page = await store.listVotes({ daoId: "ens", limit: 1, cursor }); seen.push(...page.items.map((x) => x.transactionHash)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(seen.sort(), [TX, TX2, TX3].sort());
});

test("trailing replay replaces orphaned range records without deleting unaffected proposals", async () => {
  const store = new MemoryGovernanceStore();
  const make = (transactionHash, proposalId) => ({ raw: { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash, logIndex: 0, blockNumber: "10", blockHash: `0x${"01".repeat(32)}`, recordType: "vote", payload: { transactionHash }, sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" }, vote: { ...vote(transactionHash), proposalId, sourceEndpoint: "https://rpc.example" } });
  let canonical = [make(TX, "1")];
  const source = { id: "governor-logs", fromBlock: 1, replayBlocks: 10, config: DAO_CONFIGS.ens, rpcUrl: "https://rpc.example", async head(){ return 20; }, async fetchRange(from, to){ return canonical.filter((x) => 10 >= from && 10 <= to).map((x) => x.raw.payload); }, async normalizeLog(payload){ return canonical.find((x) => x.raw.payload.transactionHash === payload.transactionHash); } };
  await store.transaction(async (tx) => tx.upsertProposal({ daoId: "ens", proposalId: "99", contentHash: "9".repeat(64), normalized: { id: "99", createdBlock: "2" } }));
  const worker = new GovernanceSyncWorker({ store, sources: { ens: source }, batchSize: 100 });
  await worker.syncDao("ens"); canonical = [make(TX2, "2")]; await worker.syncDao("ens");
  assert.deepEqual(store.voteEvents.map((x) => x.transactionHash), [TX2]);
  assert.ok(await store.getProposal("ens", "99"));
});

test("same canonical event identity with changed content fails closed", async () => {
  const store = new MemoryGovernanceStore();
  const base = { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: TX, logIndex: 0, blockNumber: "10", blockHash: `0x${"01".repeat(32)}`, recordType: "vote", payload: { value: 1 }, sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" };
  await store.transaction(async (tx) => tx.ingest({ raw: base }));
  await assert.rejects(store.transaction(async (tx) => tx.reconcileRange({ daoId: "ens", sourceId: "governor-logs", fromBlock: 10, toBlock: 10, records: [{ raw: { ...base, payload: { value: 2 } } }] })), /canonical.*drift/i);
});

test("canonical replay replaces an event re-included at a different block placement", async () => {
  const store = new MemoryGovernanceStore();
  const raw = { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: TX, logIndex: 0, blockNumber: "10", blockHash: `0x${"01".repeat(32)}`, recordType: "vote", proposalId: "1", payload: { support: "FOR", voter: ADDRESS }, sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" };
  const original = { raw, vote: vote(TX) };
  await store.transaction(async (tx) => tx.ingest(original));
  const moved = { raw: { ...raw, blockNumber: "11", blockHash: `0x${"02".repeat(32)}`, observedHead: "21" }, vote: { ...vote(TX), blockNumber: "11", timestamp: new Date(1_000).toISOString(), observedHead: "21" } };
  await store.transaction(async (tx) => {
    tx.reconcileRange({ daoId: "ens", sourceId: "governor-logs", fromBlock: 10, toBlock: 11, records: [moved] });
    tx.ingest(moved);
  });
  assert.equal(store.rawRecords.length, 1);
  assert.equal(store.rawRecords[0].blockNumber, "11");
  assert.equal(store.rawRecords[0].blockHash, `0x${"02".repeat(32)}`);
  assert.equal(store.voteEvents.length, 1);
  assert.equal(store.voteEvents[0].blockNumber, "11");
});

test("Memory replay replaces a moved event whose old placement is outside the replay range", async () => {
  const store = new MemoryGovernanceStore();
  const raw = { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: TX, logIndex: 0, blockNumber: "9", blockHash: `0x${"01".repeat(32)}`, recordType: "vote", proposalId: "1", payload: { support: "FOR" }, sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" };
  await store.transaction(async (tx) => tx.ingest({ raw, vote: vote(TX) }));
  const moved = { raw: { ...raw, blockNumber: "10", blockHash: `0x${"02".repeat(32)}` }, vote: { ...vote(TX), blockNumber: "10" } };
  await store.transaction(async (tx) => { tx.reconcileRange({ daoId: "ens", sourceId: "governor-logs", fromBlock: 10, toBlock: 10, records: [moved] }); tx.ingest(moved); });
  assert.equal(store.rawRecords.length, 1);
  assert.equal(store.rawRecords[0].blockNumber, "10");
});

test("Memory proposal pages match PostgreSQL normalized-document shape", async () => {
  const store = new MemoryGovernanceStore();
  store.upsertProposal({ daoId: "ens", proposalId: "1", contentHash: "a".repeat(64), normalized: { id: "1", title: "normalized" } });
  assert.deepEqual((await store.listProposals({ daoId: "ens", limit: 10 })).items, [{ id: "1", title: "normalized" }]);
});

test("ENS indexed content hash is recomputed and verified", async () => {
  const { EnsDaoAdapter } = require("../packages/ens-adapter");
  const indexed = { id: "1", contentHash: "0".repeat(64), title: "", description: "body", proposer: ADDRESS, state: "ACTIVE", outcome: "ACTIVE", createdBlock: "1", createdAt: new Date(0).toISOString(), startBlock: "2", endBlock: "3", quorumVotes: "0", forVotes: "0", againstVotes: "0", abstainVotes: "0", actions: [], dao: "ens", chainId: 1, venue: "governor", timing: "block" };
  const governor = { async state(){ return 1; }, async proposalSnapshot(){ return 2n; }, async proposalDeadline(){ return 3n; }, async proposalVotes(){ return [0n, 0n, 0n]; }, async quorum(){ return 0n; }, async hashProposal(){ return 1n; } };
  await assert.rejects(new EnsDaoAdapter({ provider: {}, governor, token: {}, proposalLoader: async () => indexed }).fetchProposal("1"), /content hash/i);
});

test("Nouns raw vote canonical payload excludes mutable embedded proposal state", async () => {
  const base = { id: "vote-1", supportDetailed: 1, votesRaw: "1", reason: "", blockNumber: "100", blockTimestamp: "1700000000", transactionHash: TX, clientId: 0, voter: { id: ADDRESS } };
  const proposal = { id: "7", title: "Title", description: "body", status: "ACTIVE", proposer: { id: OTHER }, targets: [], values: [], signatures: [], calldatas: [], createdTimestamp: "1699999000", createdBlock: "90", startBlock: "101", endBlock: "200", quorumVotes: "1", forVotes: "1", againstVotes: "0", abstainVotes: "0" };
  const source = new NounsSubgraphSource({ endpoint: "https://gateway.example/subgraph/SECRET" });
  const first = await source.normalizeLog({ ...base, proposal }, 200);
  const second = await source.normalizeLog({ ...base, proposal: { ...proposal, status: "SUCCEEDED", forVotes: "99" } }, 210);
  assert.deepEqual(first.raw.payload, second.raw.payload);
  assert.equal(first.raw.sourceRecordKey, "vote:vote-1");
  assert.equal(first.raw.logIndex, null);
  assert.equal(first.vote.sourcePublicEndpoint, "https://gateway.example");
});

test("Nouns pages are pinned and proposals without votes are enumerated", async () => {
  const proposal = { id: "7", title: "No votes", description: "body", status: "ACTIVE", proposer: { id: OTHER }, targets: [], values: [], signatures: [], calldatas: [], createdTimestamp: "1700000000", createdBlock: "100", startBlock: "101", endBlock: "200", quorumVotes: "1", forVotes: "0", againstVotes: "0", abstainVotes: "0" };
  const requests = [];
  const source = new NounsSubgraphSource({ finalityDepth: 5, replayBlocks: 8, pageSize: 1, fetch: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); if (body.query.includes("_meta")) return { ok: true, async json(){ return { data: { _meta: { block: { number: 205 } } } }; } }; if (body.query.includes("proposals(")) return { ok: true, async json(){ return { data: { proposals: body.variables.after === "" ? [proposal] : [] } }; } }; return { ok: true, async json(){ return { data: { votes: [] } }; } }; } });
  assert.equal(await source.head(), 200);
  const proposals = await source.fetchProposals(90, 110, 200);
  assert.equal(proposals[0].proposal.normalized.id, "7");
  assert.equal(proposals[0].raw.sourceRecordKey, "proposal:7");
  assert.equal(proposals[0].raw.transactionHash, null);
  assert.equal(proposals[0].raw.logIndex, null);
  assert.equal(proposals[0].raw.blockNumber, "100");
  assert.equal(proposals[0].raw.recordType, "proposal");
  assert.equal(requests.at(-2).variables.snapshot, 200);
  assert.equal(requests.at(-2).variables.after, "");
  assert.equal(requests.at(-2).query.includes("skip"), false);
  assert.equal(source.replayBlocks, 8);
});

test("Nouns proposal records reconcile independently and disappearing proposals are removed", async () => {
  const store = new MemoryGovernanceStore();
  const proposal = { daoId: "nouns", proposalId: "7", contentHash: "a".repeat(64), normalized: { id: "7", contentHash: "a".repeat(64), createdBlock: "100" }, actions: [] };
  const record = { raw: { daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:7", externalId: "7", chainId: 1, contractAddress: DAO_CONFIGS.nouns.contractAddress, transactionHash: null, logIndex: null, blockNumber: "100", blockHash: null, recordType: "proposal", proposalId: "7", contentHash: "a".repeat(64), payload: { id: "7", createdBlock: "100" }, sourceKind: "nouns-subgraph", sourceEndpoint: "https://subgraph.example/private", observedHead: "110" }, proposal };
  let proposals = [record];
  const source = { id: "nouns-subgraph", fromBlock: 90, replayBlocks: 20, config: DAO_CONFIGS.nouns, rpcUrl: "https://subgraph.example/private", async head(){ return 110; }, async fetchRange(){ return []; }, async normalizeLog(){ throw new Error("unexpected vote"); }, async fetchProposals(){ return proposals; } };
  const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100 });
  await worker.syncDao("nouns");
  assert.equal(store.rawRecords.length, 1);
  assert.ok(await store.getProposal("nouns", "7"));
  proposals = [];
  // An incremental pass is not authoritative about which proposals exist, so it
  // must never delete one.
  await worker.syncDao("nouns", { fullProposalScan: false });
  assert.equal(store.rawRecords.length, 1);
  assert.ok(await store.getProposal("nouns", "7"));
  await worker.syncDao("nouns", { fullProposalScan: true });
  assert.equal(store.rawRecords.length, 0);
  assert.equal(await store.getProposal("nouns", "7"), null);
});

test("Nouns refreshes old normalized proposal state outside the replay creation range", async () => {
  const store = new MemoryGovernanceStore();
  let state = "ACTIVE";
  const source = {
    id: "nouns-subgraph", fromBlock: 90, replayBlocks: 20, config: DAO_CONFIGS.nouns, rpcUrl: "https://subgraph.example/private",
    async head(){ return 500; }, async fetchRange(){ return []; }, async normalizeLog(){ throw new Error("unexpected vote"); },
    async fetchProposals(){ return [{ raw: { daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:7", chainId: 1, contractAddress: DAO_CONFIGS.nouns.contractAddress, transactionHash: null, logIndex: null, blockNumber: "100", blockHash: null, recordType: "proposal", proposalId: "7", contentHash: "a".repeat(64), payload: { id: "7" }, sourceKind: "nouns-subgraph", sourceEndpoint: "https://subgraph.example/private", observedHead: "500" }, proposal: { daoId: "nouns", proposalId: "7", contentHash: "a".repeat(64), normalized: { id: "7", contentHash: "a".repeat(64), createdBlock: "100", state }, actions: [] } }]; },
  };
  await store.transaction(async (tx) => {
    tx.upsertProposal({ daoId: "nouns", proposalId: "7", contentHash: "a".repeat(64), normalized: { id: "7", contentHash: "a".repeat(64), createdBlock: "100", state }, actions: [] });
    tx.setCheckpoint({ daoId: "nouns", sourceId: "nouns-subgraph", nextBlock: 500, finalizedHead: 499, lastError: null });
  });
  state = "SUCCEEDED";
  await new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100 }).syncDao("nouns");
  assert.equal((await store.getProposal("nouns", "7")).state, "SUCCEEDED");
});

test("Railgun verified creation block is the default and remains overrideable", () => {
  const previous = {
    enabled: process.env.INDEXER_ENABLED_DAOS,
    rpc: process.env.ETHEREUM_RPC_URL,
    from: process.env.RAILGUN_FROM_BLOCK,
  };
  try {
    process.env.INDEXER_ENABLED_DAOS = "railgun-eth";
    process.env.ETHEREUM_RPC_URL = "https://rpc.example";
    delete process.env.RAILGUN_FROM_BLOCK;
    assert.equal(DAO_CONFIGS["railgun-eth"].fromBlock, 15505853);
    assert.equal(buildRuntime(new MemoryGovernanceStore()).sources["railgun-eth"].fromBlock, 15505853);
    process.env.RAILGUN_FROM_BLOCK = "15505854";
    assert.equal(buildRuntime(new MemoryGovernanceStore()).sources["railgun-eth"].fromBlock, 15505854);
  } finally {
    for (const [key, value] of [["INDEXER_ENABLED_DAOS", previous.enabled], ["ETHEREUM_RPC_URL", previous.rpc], ["RAILGUN_FROM_BLOCK", previous.from]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Railgun proposal loading refreshes and enumerates proposals with no votes", async () => {
  let loads = 0;
  const blockTags = [];
  const source = new RailgunVotingSource({ rpcUrl: "https://rpc.example", fromBlock: 1, provider: { async getBlock(){ return { timestamp: 1_700_000_000 }; } }, proposalLoader: async (id, blockTag) => { blockTags.push(["proposal", blockTag]); return { id: String(id), contentHash: String(++loads).padStart(64, "0"), createdBlock: "0", actions: [] }; }, proposalCountLoader: async (blockTag) => { blockTags.push(["count", blockTag]); return 2n; } });
  const iface = new Interface(["event VoteCast(uint256 indexed id,address indexed voter,bool affirmative,uint256 votes)"]);
  const encoded = iface.encodeEventLog(iface.getEvent("VoteCast"), [0n, ADDRESS, true, 1n]);
  const log = { address: DAO_CONFIGS["railgun-eth"].contractAddress, blockNumber: 10, transactionHash: TX, index: 0, topics: encoded.topics, data: encoded.data };
  const first = await source.normalizeLog(log, "20"); const second = await source.normalizeLog(log, "21");
  assert.notEqual(first.proposal.contentHash, second.proposal.contentHash);
  const proposals = await source.fetchProposals(1, 20, 20);
  assert.deepEqual(blockTags.slice(-3), [["count", 20], ["proposal", 20], ["proposal", 20]]);
  assert.deepEqual(proposals.map((x) => x.proposal.proposalId), ["0", "1"]);
  assert.deepEqual(proposals.map((x) => x.raw.sourceRecordKey), ["proposal:0", "proposal:1"]);
  assert.ok(proposals.every((x) => x.raw.recordType === "proposal" && x.raw.observedHead === "20"));
});

test("Railgun adapter reads proposal state at the requested finalized block", async () => {
  const { RailgunDaoAdapter } = require("../packages/railgun-adapter");
  const calls = [];
  const voting = {
    async proposals(id, overrides) { calls.push(["proposal", id, overrides]); return [false, ADDRESS, "cid", 100n, 0n, 0n, 3n, 2n, 0n, 0n]; },
    async getActions(id, overrides) { calls.push(["actions", id, overrides]); return []; },
  };
  const provider = { async getBlock(blockTag) { calls.push(["block", blockTag]); return { timestamp: 1_700_000_000 }; } };
  const proposal = await new RailgunDaoAdapter({ provider, voting, staking: {} }).fetchProposal("7", 12345);
  assert.equal(proposal.id, "7");
  assert.deepEqual(calls, [["proposal", "7", { blockTag: 12345 }], ["actions", "7", { blockTag: 12345 }], ["block", 12345]]);
});

test("worker enumerates Railgun proposals once across multiple batches", async () => {
  const store = new MemoryGovernanceStore();
  let enumerations = 0;
  const source = { id: "voting-logs", fromBlock: 1, replayBlocks: 0, config: DAO_CONFIGS["railgun-eth"], rpcUrl: "https://rpc.example", async head(){ return 5; }, async fetchRange(){ return []; }, async normalizeLog(){ throw new Error("unexpected vote"); }, async fetchProposals(){ enumerations += 1; return [{ daoId: "railgun-eth", proposalId: "0", contentHash: "a".repeat(64), normalized: { id: "0", contentHash: "a".repeat(64) }, actions: [] }]; } };
  const result = await new GovernanceSyncWorker({ store, sources: { "railgun-eth": source }, batchSize: 2 }).syncDao("railgun-eth");
  assert.equal(result.batches, 3);
  assert.equal(enumerations, 1);
  assert.equal(store.proposals.length, 1);
});

test("Railgun proposal enumeration removes proposals that disappear at a later finalized head", async () => {
  const store = new MemoryGovernanceStore();
  let head = 100;
  let count = 2n;
  const source = new RailgunVotingSource({
    rpcUrl: "https://rpc.example", fromBlock: 1, finalityDepth: 0, replayBlocks: 2,
    provider: { async getBlockNumber(){ return head; }, async getLogs(){ return []; } },
    proposalCountLoader: async () => count,
    proposalLoader: async (id) => ({ id: String(id), contentHash: String(Number(id) + 1).padStart(64, "0"), createdBlock: "0", actions: [] }),
  });
  const worker = new GovernanceSyncWorker({ store, sources: { "railgun-eth": source }, batchSize: 200 });
  await worker.syncDao("railgun-eth");
  assert.deepEqual(store.proposals.map((x) => x.proposalId), ["0", "1"]);
  head = 101;
  count = 1n;
  await worker.syncDao("railgun-eth", { fullProposalScan: false });
  assert.deepEqual(store.proposals.map((x) => x.proposalId), ["0", "1"], "an incremental pass never deletes proposals");
  await worker.syncDao("railgun-eth", { fullProposalScan: true });
  assert.deepEqual(store.proposals.map((x) => x.proposalId), ["0"]);
  assert.deepEqual(store.rawRecords.filter((x) => x.recordType === "proposal").map((x) => x.proposalId), ["0"]);
});

test("Index API client caps history page size at the API maximum", async () => {
  const { IndexApiClient } = require("../packages/governance-index");
  const urls = [];
  const client = new IndexApiClient({ baseUrl: "https://index.example", pageSize: 1000, fetch: async (url) => {
    urls.push(url);
    if (url.includes("/sync-status")) return { ok: true, async json(){ return { sources: [{ sourceId: "nouns-subgraph", finalizedHead: "500", updatedAt: new Date().toISOString(), lastError: null }] }; } };
    return { ok: true, async json(){ return { items: [], nextCursor: null }; } };
  } });
  await client.fetchHistory("ens", ADDRESS);
  assert.match(urls.find((url) => url.includes("/history")), /limit=100(?:&|$)/);
});

test("API returns a fixed 500 response while logging the internal error", async () => {
  const errors = [];
  const response = await request(createReadOnlyApi({ store: { async listDaos(){ throw new Error("password=super-secret"); } }, logger: { info(){}, error(value){ errors.push(value); } } }), "/v1/daos");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error", message: "Internal server error" });
  assert.doesNotMatch(errors[0].error, /super-secret/);
  assert.match(errors[0].error, /password=\[redacted\]/);
});

test("worker retry and failure logs redact credential-bearing upstream errors", async () => {
  const store = new MemoryGovernanceStore();
  const warnings = []; const errors = []; let attempts = 0;
  const secret = "https://user:pass@rpc.example/v2/SECRET?token=x";
  const source = {
    id: "governor-logs", fromBlock: 1, replayBlocks: 0, config: DAO_CONFIGS.ens, rpcUrl: secret,
    async head(){ return 1; }, async fetchRange(){ attempts += 1; throw new Error(`${secret} failed`); },
    async normalizeLog(){ throw new Error("unexpected"); },
  };
  const worker = new GovernanceSyncWorker({ store, sources: { ens: source }, retries: 2, logger: { info(){}, warn(value){ warnings.push(value); }, error(value){ errors.push(value); } } });
  await assert.rejects(worker.syncDao("ens"), /SECRET/);
  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
  assert.equal(errors.length, 1);
  for (const entry of [...warnings, ...errors]) {
    assert.doesNotMatch(JSON.stringify(entry), /user|pass|SECRET|token/);
    assert.match(entry.error, /^https:\/\/rpc\.example/);
  }
  assert.doesNotMatch(store.checkpoints.get("ens:governor-logs").lastError, /user|pass|SECRET|token/);
});

test("public status never exposes stored upstream errors", async () => {
  const checkpoint = { daoId: "ens", sourceId: "governor-logs", lastError: "https://user:pass@rpc.example/v2/SECRET?token=x failed" };
  const store = {
    async status(){ return { daos: 1, proposals: 0, votes: 0, delegations: 0, checkpoints: [checkpoint] }; },
    async syncStatus(){ return [checkpoint]; },
  };
  for (const route of ["/v1/status", "/v1/daos/ens/sync-status"]) {
    const response = await request(createReadOnlyApi({ store }), route);
    const body = JSON.stringify(await response.json());
    assert.doesNotMatch(body, /user|pass|SECRET|token/);
    assert.match(body, /sync_failed/);
  }
});

test("Postgres ingest and reconciliation support source-keyed Nouns proposals", async () => {
  const calls = [];
  let insertCount = 0;
  const client = { async query(text, values) {
    calls.push({ text, values });
    if (text.includes("INSERT INTO raw_governance_records")) return { rowCount: insertCount++ === 0 ? 1 : 0, rows: [] };
    if (text.includes("FROM raw_governance_records") && text.includes("BETWEEN")) return { rows: [{ daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:7", chainId: "1", contractAddress: DAO_CONFIGS.nouns.contractAddress, transactionHash: null, logIndex: null, blockNumber: "100", blockHash: null, recordType: "proposal", proposalId: "7", contentHash: "a".repeat(64), payload: { id: "7" } }] };
    return { rowCount: 1, rows: [] };
  } };
  const tx = new PostgresTransaction(client);
  const proposal = { daoId: "nouns", proposalId: "7", contentHash: "a".repeat(64), normalized: { id: "7", contentHash: "a".repeat(64), state: "ACTIVE", createdBlock: "100" }, actions: [] };
  const record = { raw: { daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:7", chainId: 1, contractAddress: DAO_CONFIGS.nouns.contractAddress, transactionHash: null, logIndex: null, blockNumber: "100", blockHash: null, recordType: "proposal", proposalId: "7", contentHash: "a".repeat(64), payload: { id: "7" }, sourceKind: "nouns-subgraph", sourceEndpoint: "https://example.invalid", observedHead: "110" }, proposal };
  assert.equal(await tx.ingest(record), true);
  assert.equal(await tx.ingest({ ...record, proposal: { ...proposal, normalized: { ...proposal.normalized, state: "SUCCEEDED" } } }), false);
  const rawInsert = calls.find((call) => call.text.includes("INSERT INTO raw_governance_records"));
  assert.match(rawInsert.text, /source_record_key/);
  assert.ok(rawInsert.values.includes("proposal:7"));
  assert.equal(calls.filter((call) => call.text.includes("INSERT INTO proposals")).length, 2, "mutable normalized proposal is refreshed on raw conflict");
  await tx.reconcileRange({ daoId: "nouns", sourceId: "nouns-subgraph", fromBlock: 90, toBlock: 110, records: [] });
  assert.ok(calls.some((call) => call.text.includes("DELETE FROM raw_governance_records") && call.text.includes("source_record_key")));
});

test("Postgres write parameters never contain credential-bearing transport URLs", async () => {
  const calls = [];
  const client = { async query(text, values = []) { calls.push({ text, values }); return { rowCount: 1, rows: [] }; } };
  const tx = new PostgresTransaction(client);
  const secret = "https://user:pass@mainnet.infura.io/v3/SECRET?token=hidden";
  await tx.upsertDao({ ...DAO_CONFIGS.ens, config: { endpoint: secret } });
  await tx.upsertSource({ daoId: "ens", id: "governor-logs", kind: "ens-governor-logs", endpoint: secret, config: { endpoint: secret }, fromBlock: 1 });
  await tx.ingest({
    raw: { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: TX, logIndex: 0, blockNumber: "10", blockHash: null, recordType: "vote", payload: {}, sourceKind: "ens-governor-logs", sourceEndpoint: secret, observedHead: "10" },
    vote: { ...vote(TX), sourceEndpoint: secret },
  });
  await tx.insertDelegation({ daoId: "ens", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, delegator: ADDRESS, delegatee: OTHER, blockNumber: "10", timestamp: new Date(0).toISOString(), transactionHash: TX2, logIndex: 0, sourceKind: "ens-governor-logs", sourceEndpoint: secret });
  const persisted = JSON.stringify(calls);
  assert.doesNotMatch(persisted, /user|pass|SECRET|token|\/v3\//);
  assert.match(persisted, /https:\/\/mainnet\.infura\.io/);
});

test("Postgres proposal reconciliation deletes source-keyed proposals missing from a canonical enumeration", async () => {
  const calls = [];
  const client = { async query(text, values = []) {
    calls.push({ text, values });
    if (text.includes("FROM raw_governance_records") && text.includes("record_type='proposal'")) return { rows: [{ daoId: "railgun-eth", sourceId: "voting-logs", sourceRecordKey: "proposal:1", proposalId: "1", blockNumber: "1", blockHash: null, recordType: "proposal", contentHash: "a".repeat(64), payload: { id: "1" } }] };
    return { rowCount: 1, rows: [] };
  } };
  await new PostgresTransaction(client).reconcileProposals({ daoId: "railgun-eth", sourceId: "voting-logs", records: [] });
  assert.ok(calls.some((call) => call.text.includes("DELETE FROM raw_governance_records") && call.values.includes("proposal:1")));
  assert.ok(calls.some((call) => call.text.includes("DELETE FROM proposals") && call.values.includes("1")));
});

test("Postgres canonical replay deletes the old placement of a moved event before re-ingest", async () => {
  const old = { daoId: "ens", sourceId: "governor-logs", sourceRecordKey: null, chainId: "1", contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: TX, logIndex: 0, blockNumber: "10", blockHash: `0x${"01".repeat(32)}`, recordType: "vote", proposalId: "1", contentHash: null, payload: { support: "FOR" } };
  const calls = [];
  const client = { async query(text, values = []) {
    calls.push({ text, values });
    if (text.includes("FROM raw_governance_records") && (text.includes("BETWEEN") || text.includes("lower(contract_address)"))) return { rows: [old] };
    return { rowCount: 1, rows: [] };
  } };
  const moved = { raw: { ...old, chainId: 1, blockNumber: "11", blockHash: `0x${"02".repeat(32)}`, sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" } };
  await new PostgresTransaction(client).reconcileRange({ daoId: "ens", sourceId: "governor-logs", fromBlock: 10, toBlock: 11, records: [moved] });
  assert.ok(calls.some((call) => call.text.includes("DELETE FROM raw_governance_records") && call.values.includes(TX)));
  assert.ok(calls.some((call) => call.text.includes("DELETE FROM vote_events") && call.values.includes(TX)));
});

test("Postgres pagination uses complete stable keysets and opaque proposal cursors", async () => {
  const queries = [];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes("FROM proposals")) return { rows: [
        { proposalId: "8", normalized: { id: "8" } },
        { proposalId: "7", normalized: { id: "7" } },
      ] };
      return { rows: [
        { blockNumber: "10", transactionHash: TX2, logIndex: 0 },
        { blockNumber: "10", transactionHash: TX3, logIndex: 0 },
      ] };
    },
    async end() {},
  };
  const store = new PostgresGovernanceStore({ pool });
  const proposals = await store.listProposals({ daoId: "ens", limit: 1, cursor: "9" });
  assert.equal(proposals.nextCursor, encodeProposalCursor("8"));
  assert.deepEqual(queries[0].values, ["ens", 2, "9"]);
  const votes = await store.listVotes({ daoId: "ens", voter: ADDRESS, limit: 1, cursor: { blockNumber: "10", transactionHash: TX, logIndex: 0 } });
  assert.ok(votes.nextCursor);
  assert.match(queries[1].text, /\(block_number,lower\(transaction_hash\),log_index\)>\(\$4,\$5,\$6\)/);
  assert.match(queries[1].text, /ORDER BY block_number,lower\(transaction_hash\),log_index LIMIT \$2/);
  assert.deepEqual(queries[1].values, ["ens", 2, ADDRESS.toLowerCase(), "10", TX, 0]);
});

test("Postgres store rejects a pool size that can deadlock source locking", () => {
  assert.throws(() => new PostgresGovernanceStore({ maxConnections: 1 }), /at least 2/i);
});

test("Postgres checkpoints are monotonic while recording the latest error", async () => {
  const queries = [];
  const client = { async query(text, values) { queries.push({ text, values }); return { rows: [], rowCount: 1 }; }, release() {} };
  const store = new PostgresGovernanceStore({ pool: { async connect() { return client; }, async end() {} } });
  await store.transaction(async (tx) => tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 5, finalizedHead: 7, lastError: "failure" }));
  const query = queries.find((entry) => entry.text.includes("INSERT INTO sync_checkpoints"));
  assert.match(query.text, /GREATEST\(sync_checkpoints\.next_block,excluded\.next_block\)/);
  assert.match(query.text, /last_error=excluded\.last_error/);
});

test("checkpoint persistence redacts credential-bearing errors at both store boundaries", async () => {
  const secret = "https://user:pass@rpc.example/v2/SECRET?token=hidden failed";
  const memory = new MemoryGovernanceStore();
  memory.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 1, finalizedHead: 1, lastError: secret });
  assert.doesNotMatch(memory.getCheckpoint("ens", "governor-logs").lastError, /user|pass|SECRET|token/);
  const queries = [];
  const tx = new PostgresTransaction({ async query(text, values) { queries.push({ text, values }); return { rows: [], rowCount: 1 }; } });
  await tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 1, finalizedHead: 1, lastError: secret });
  assert.doesNotMatch(JSON.stringify(queries), /user|pass|SECRET|token/);
});

test("source records preserve an explicit safe public provenance path", async () => {
  const store = new MemoryGovernanceStore();
  const source = new NounsSubgraphSource({ endpoint: "https://private.example/v2/SECRET", sourcePublicEndpoint: "https://docs.example/governance" });
  const proposal = { id: "7", title: "x", description: "body", status: "ACTIVE", proposer: { id: OTHER }, targets: [], values: [], signatures: [], calldatas: [], createdTimestamp: "1700000000", createdBlock: "100", startBlock: "101", endBlock: "200", quorumVotes: "1", forVotes: "0", againstVotes: "0", abstainVotes: "0" };
  source.fetch = async () => ({ ok: true, async json(){ return { data: { proposals: [proposal] } }; } });
  source.pageSize = 100;
  const [record] = await source.fetchProposals(1, 200, 200);
  await store.transaction(async (tx) => tx.ingest(record));
  assert.equal(store.rawRecords[0].sourceEndpoint, "https://docs.example/governance");
});

test("migration constrains vote and delegation provenance fields", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../packages/governance-index/migrations/001_initial.sql"), "utf8");
  const vote = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS vote_events"), sql.indexOf("CREATE INDEX IF NOT EXISTS vote_events_voter_history"));
  const delegation = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS delegation_events"), sql.indexOf("CREATE TABLE IF NOT EXISTS sync_checkpoints"));
  for (const table of [vote, delegation]) {
    assert.match(table, /chain_id bigint NOT NULL CHECK \(chain_id > 0\)/);
    assert.match(table, /contract_address text NOT NULL CHECK \(contract_address ~ '\^0x\[0-9A-Fa-f\]\{40\}\$'\)/);
    assert.match(table, /block_number bigint NOT NULL CHECK \(block_number >= 0\)/);
    assert.match(table, /transaction_hash text NOT NULL CHECK \(transaction_hash ~ '\^0x\[0-9A-Fa-f\]\{64\}\$'\)/);
    assert.match(table, /log_index integer NOT NULL CHECK \(log_index >= 0\)/);
  }
  assert.match(vote, /voter text NOT NULL CHECK \(voter ~ '\^0x\[0-9A-Fa-f\]\{40\}\$'\)/);
  assert.match(vote, /vote_weight numeric\(78,0\) NOT NULL CHECK \(vote_weight >= 0\)/);
  assert.match(vote, /observed_head bigint NOT NULL CHECK \(observed_head >= 0\)/);
  assert.match(delegation, /delegator text NOT NULL CHECK/);
  assert.match(delegation, /delegatee text NOT NULL CHECK/);
});

test("indexer health requires a clean, advancing checkpoint for every enabled DAO", () => {
  const now = 1_700_000_000_000;
  const fresh = new Date(now - 30_000).toISOString();
  const options = { now, maxAgeSeconds: 900 };
  const healthy = healthStatus({ checkpoints: [
    { daoId: "nouns", sourceId: "nouns-subgraph", updatedAt: fresh, lastError: null },
    { daoId: "ens", sourceId: "governor-logs", updatedAt: fresh, lastError: null },
  ] }, ["nouns", "ens"], options);
  assert.equal(healthy.ok, true);
  const missing = healthStatus({ checkpoints: healthy.checkpoints.slice(0, 1) }, ["nouns", "ens"], options);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["ens:governor-logs"]);
  const failed = healthStatus({ checkpoints: [{ daoId: "ens", sourceId: "governor-logs", updatedAt: fresh, lastError: "boom" }] }, ["ens"], options);
  assert.deepEqual(failed.errors, [{ daoId: "ens", sourceId: "governor-logs", lastError: "boom" }]);
  // A stalled indexer that recorded no error must not report healthy.
  const stalled = healthStatus({ checkpoints: [
    { daoId: "ens", sourceId: "governor-logs", updatedAt: new Date(now - 7_200_000).toISOString(), lastError: null },
  ] }, ["ens"], options);
  assert.equal(stalled.ok, false);
  assert.equal(stalled.stale[0].sourceId, "governor-logs");
});

test("request logs exclude attacker-controlled query strings", async () => {
  const entries = [];
  const logger = { info(value) { entries.push(value); }, error(value) { entries.push(value); } };
  const response = await request(createReadOnlyApi({ store: new MemoryGovernanceStore(), logger }), "/not-found?token=TOPSECRET");
  assert.equal(response.status, 404);
  assert.doesNotMatch(JSON.stringify(entries), /TOPSECRET|token=/);
  assert.equal(entries.at(-1).path, "/not-found");
});

test("redaction covers JSON credentials and bearer authorization", () => {
  const safe = redactErrorMessage(new Error('{"token":"ABCDEF","apiKey":"GHIJKL"} Authorization: Bearer TOPSECRET'));
  assert.doesNotMatch(safe, /ABCDEF|GHIJKL|TOPSECRET/);
  assert.match(safe, /\[redacted\]/);
});

test("persisted configs redact credential-valued fields recursively", () => {
  const safe = sanitizeConfig({
    apiKey: "ABCDEF",
    database_password: "DBSECRET",
    dbPassword: "CAMELSECRET",
    authToken: "AUTHSECRET",
    refresh_token: "REFRESHSECRET",
    credentials: "CREDENTIALSSECRET",
    connectionString: "postgresql://user:pass@db.example/gavel",
    nested: { password: "GHIJKL", headers: { authorization: "Bearer TOPSECRET" } },
    label: "public",
  });
  for (const key of ["apiKey", "database_password", "dbPassword", "authToken", "refresh_token", "credentials", "connectionString"]) assert.equal(safe[key], "[redacted]");
  assert.equal(safe.nested.password, "[redacted]");
  assert.equal(safe.nested.headers.authorization, "[redacted]");
  assert.equal(safe.label, "public");
  assert.doesNotMatch(JSON.stringify(safe), /ABCDEF|DBSECRET|CAMELSECRET|AUTHSECRET|REFRESHSECRET|CREDENTIALSSECRET|GHIJKL|TOPSECRET|postgresql:\/\/user|:pass@/);
});

test("redaction strips compound credential fields and non-HTTP connection URIs", () => {
  const unsafe = "database_password=DBSECRET dbPassword=CAMELSECRET authToken=AUTHSECRET refresh_token=REFRESHSECRET credentials=CREDENTIALSSECRET postgresql://user:pass@db.example/gavel?sslpassword=TLSSECRET";
  const safe = redactErrorMessage(new Error(unsafe));
  assert.doesNotMatch(safe, /DBSECRET|CAMELSECRET|AUTHSECRET|REFRESHSECRET|CREDENTIALSSECRET|TLSSECRET|postgresql:\/\/user|:pass@|\/gavel/);
  assert.match(safe, /postgresql:\/\/db\.example/);
});

test("Nouns source fails closed on malformed GraphQL page data", async () => {
  const source = new NounsSubgraphSource({ endpoint: "https://example.test/subgraph" });
  source.request = async () => ({ unexpected: [] });
  await assert.rejects(source.fetchProposals(1, 2, 2), /missing proposals array/i);
  await assert.rejects(source.fetchRange(1, 2, 2), /missing votes array/i);
});

test("worker applies finalized proposal refresh after replaying creation logs", async () => {
  const store = new MemoryGovernanceStore();
  const raw = { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: TX, logIndex: 0, blockNumber: "10", blockHash: `0x${"01".repeat(32)}`, recordType: "proposal", proposalId: "1", contentHash: "a".repeat(64), payload: { immutable: true }, sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" };
  const proposal = (state, forVotes) => ({ daoId: "ens", proposalId: "1", contentHash: "a".repeat(64), normalized: { id: "1", contentHash: "a".repeat(64), state, outcome: state, createdBlock: "10", forVotes }, actions: [] });
  const refreshed = { raw, proposal: proposal("SUCCEEDED", "99") };
  const stale = { raw, proposal: proposal("UNKNOWN", "0") };
  const source = { id: "governor-logs", fromBlock: 1, replayBlocks: 64, config: DAO_CONFIGS.ens, rpcUrl: "https://rpc.example", async head() { return 20; }, async fetchProposals() { return [refreshed]; }, async fetchRange(from, to) { return from <= 10 && to >= 10 ? [raw] : []; }, async normalizeLog() { return stale; } };
  await new GovernanceSyncWorker({ store, sources: { ens: source }, batchSize: 100 }).syncDao("ens");
  const indexed = await store.getProposal("ens", "1");
  assert.equal(indexed.state, "SUCCEEDED");
  assert.equal(indexed.forVotes, "99");
});

test("worker reconciles a moved proposal creation before applying its refresh", async () => {
  const store = new MemoryGovernanceStore();
  const make = (blockNumber, blockHash) => ({ raw: { daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: DAO_CONFIGS.ens.contractAddress, transactionHash: TX, logIndex: 0, blockNumber, blockHash, recordType: "proposal", proposalId: "1", contentHash: "a".repeat(64), payload: { immutable: true }, sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20" }, proposal: { daoId: "ens", proposalId: "1", contentHash: "a".repeat(64), normalized: { id: "1", contentHash: "a".repeat(64), state: "SUCCEEDED", createdBlock: blockNumber }, actions: [] } });
  store.ingest(make("9", `0x${"01".repeat(32)}`));
  const moved = make("10", `0x${"02".repeat(32)}`);
  const source = { id: "governor-logs", fromBlock: 1, replayBlocks: 64, config: DAO_CONFIGS.ens, rpcUrl: "https://rpc.example", async head() { return 20; }, async fetchProposals() { return [moved]; }, async fetchRange(from, to) { return from <= 10 && to >= 10 ? [moved.raw] : []; }, async normalizeLog() { return moved; } };
  await new GovernanceSyncWorker({ store, sources: { ens: source }, batchSize: 100 }).syncDao("ens");
  assert.equal(store.rawRecords.length, 1);
  assert.equal(store.rawRecords[0].blockNumber, "10");
});

test("Compose separates bootstrap, indexer, and SELECT-only API database roles", () => {
  const compose = fs.readFileSync(path.join(__dirname, "../docker-compose.yml"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../packages/governance-index/migrations/002_roles.sql"), "utf8");
  const init = fs.readFileSync(path.join(__dirname, "../packages/governance-index/docker/init-db.sh"), "utf8");
  assert.match(compose, /PGUSER: gavel_indexer/);
  assert.match(compose, /PGPASSWORD: \$\{GAVEL_INDEXER_DB_PASSWORD/);
  assert.match(compose, /PGUSER: gavel_api/);
  assert.match(compose, /PGPASSWORD: \$\{GAVEL_API_DB_PASSWORD/);
  assert.doesNotMatch(compose.match(/api:[\s\S]*?(?=\n  indexer:)/)[0], /gavel_indexer|gavel_admin/);
  assert.match(migration, /GRANT SELECT ON ALL TABLES IN SCHEMA public TO gavel_api/);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gavel_api/);
  assert.doesNotMatch(migration, /GRANT (?:INSERT|UPDATE|DELETE)[^;]* TO gavel_api/);
  assert.match(init, /CREATE ROLE gavel_api LOGIN/);
  assert.match(init, /CREATE ROLE gavel_indexer LOGIN/);
});

// docker-entrypoint init scripts only run against an empty data directory, so a
// deployment onto an existing volume has to be able to create the roles from
// the migration step instead. Without these variables it cannot.
test("the migrate service can provision application roles on a reused volume", () => {
  const compose = fs.readFileSync(path.join(__dirname, "../docker-compose.yml"), "utf8");
  const migrate = compose.match(/\n  migrate:[\s\S]*?(?=\n  api:)/)[0];
  assert.match(migrate, /GAVEL_INDEXER_DB_PASSWORD: \$\{GAVEL_INDEXER_DB_PASSWORD/);
  assert.match(migrate, /GAVEL_API_DB_PASSWORD: \$\{GAVEL_API_DB_PASSWORD/);
  // The migrate service is the only one that may hold both role passwords.
  const api = compose.match(/\n  api:[\s\S]*?(?=\n  indexer:)/)[0];
  assert.doesNotMatch(api, /GAVEL_INDEXER_DB_PASSWORD/);
});

test("the CLI advertises the deployment gate commands the handoff documents", () => {
  const cli = fs.readFileSync(path.join(__dirname, "../packages/governance-index/bin/gavel-indexer.js"), "utf8");
  const handoff = fs.readFileSync(path.join(__dirname, "../docs/deployment/TERRA_GOVERNANCE_INDEX_HANDOFF.md"), "utf8");
  for (const command of ["migrate", "ensure-roles", "verify-permissions"]) {
    assert.match(cli, new RegExp(`command === "${command}"`), `${command} must be implemented`);
    assert.ok(cli.includes(`  ${command}`), `${command} must appear in the usage text`);
    assert.ok(handoff.includes(command), `${command} must appear in the Terra handoff`);
  }
  // Documented flags have to exist, or the handoff is describing a CLI that is not this one.
  const options = cli.match(/options: \{[\s\S]*?\n    \}/)[0];
  for (const flag of ["--role", "--expect", "--allow-catalog-fallback", "--allow-missing-roles"]) {
    const name = flag.slice(2);
    assert.match(options, new RegExp(`(^|\\s)"?${name}"?:`, "m"), `${flag} must be a parsed option`);
    assert.ok(handoff.includes(flag), `${flag} must appear in the Terra handoff`);
  }
});
