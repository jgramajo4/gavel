const test = require("node:test");
const assert = require("node:assert/strict");
const { presentProposal } = require("../packages/core/src/governance/lifecycle");
const { MemoryGovernanceStore } = require("../packages/governance-index/src/memory-store");
const { createReadOnlyApi } = require("../packages/governance-index/src/api");
const { toTrainingEvidence } = require("../packages/core/src/backtest/chronology");

async function request(server, path, options = {}) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function migratedNouns992() {
  // Shape of a row after 003_proposal_lifecycle: columns are correct, JSON is not.
  return {
    daoId: "nouns",
    proposalId: "992",
    contentHash: "a".repeat(64),
    effectiveStatus: "DEFEATED",
    trackingState: "FINAL",
    lifecycleReason: "migrated_from_outcome",
    normalized: {
      id: "992",
      contentHash: "a".repeat(64),
      title: "Stale ACTIVE blob",
      description: "historical",
      proposer: "0x0000000000000000000000000000000000000001",
      state: "ACTIVE",
      outcome: "DEFEATED",
      createdBlock: "1",
      createdAt: "2024-01-01T00:00:00.000Z",
      startBlock: "10",
      endBlock: "20",
      quorumVotes: "1",
      forVotes: "0",
      againstVotes: "2",
      abstainVotes: "0",
      actions: [],
    },
  };
}

function refreshedNouns996() {
  return {
    daoId: "nouns",
    proposalId: "996",
    contentHash: "b".repeat(64),
    effectiveStatus: "PENDING",
    trackingState: "HOT",
    lifecycleReason: "voting_open",
    normalized: {
      id: "996",
      contentHash: "b".repeat(64),
      title: "Open",
      description: "fresh",
      proposer: "0x0000000000000000000000000000000000000001",
      state: "PENDING",
      outcome: "PENDING",
      sourceState: "PENDING",
      effectiveStatus: "PENDING",
      trackingState: "HOT",
      lifecycleReason: "voting_open",
      createdBlock: "1",
      createdAt: "2024-01-01T00:00:00.000Z",
      startBlock: "10",
      endBlock: "999999",
      quorumVotes: "1",
      forVotes: "0",
      againstVotes: "0",
      abstainVotes: "0",
      actions: [],
    },
  };
}

test("presentProposal overlays persisted columns without rewriting state", () => {
  const row = migratedNouns992();
  const presented = presentProposal(row.normalized, row);
  assert.equal(presented.state, "ACTIVE");
  assert.equal(presented.sourceState, "ACTIVE");
  assert.equal(presented.outcome, "DEFEATED");
  assert.equal(presented.effectiveStatus, "DEFEATED");
  assert.equal(presented.trackingState, "FINAL");
  assert.equal(row.normalized.effectiveStatus, undefined);
  assert.equal(row.normalized.trackingState, undefined);
});

test("memory proposal refresh replaces coherent snapshot provenance for unchanged material", async () => {
  let now = "2026-09-14T00:00:00.000Z";
  const store = new MemoryGovernanceStore({ clock: () => new Date(now) });
  const proposal = migratedNouns992();
  const makeRecord = (blockNumber, blockHash) => ({
    raw: {
      daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:992",
      chainId: 1, contractAddress: proposal.normalized.proposer, transactionHash: null, logIndex: null,
      blockNumber, blockHash, observedHead: blockNumber, recordType: "proposal", proposalId: "992",
      contentHash: proposal.contentHash, payload: { id: "992" }, sourceKind: "nouns-subgraph",
      sourceEndpoint: "https://index.example",
    },
    proposal,
  });
  store.ingest(makeRecord("100", `0x${"1".repeat(64)}`));
  now = "2026-09-14T00:05:00.000Z";
  const refreshed = makeRecord("105", `0x${"2".repeat(64)}`);
  store.reconcileProposals({ daoId: "nouns", sourceId: "nouns-subgraph", records: [refreshed] });
  assert.equal(store.ingest(refreshed), false);

  assert.deepEqual(await store.getGateProposal("nouns", "992"), {
    chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
    proposalId: "992", title: proposal.normalized.title, proposer: proposal.normalized.proposer,
    refreshedAt: now, sourceBlock: "105", sourceBlockHash: `0x${"2".repeat(64)}`,
    effectiveStatus: "DEFEATED", contentHash: `0x${proposal.contentHash}`, actions: [],
  });
  const gateResponse = await request(createReadOnlyApi({ store }), "/v1/gate/daos/nouns/proposals/992");
  assert.equal(gateResponse.status, 200);
  assert.equal(gateResponse.body.proposalId, "992");
  assert.equal(gateResponse.body.chainId, 1);
  assert.equal(gateResponse.body.governorAddress, "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d");
  assert.equal(gateResponse.body.title, proposal.normalized.title);
  assert.equal(gateResponse.body.proposer, proposal.normalized.proposer);

  now = "2026-09-14T00:10:00.000Z";
  const stale = makeRecord("101", `0x${"3".repeat(64)}`);
  stale.proposal = { ...proposal, normalized: { ...proposal.normalized, effectiveStatus: "ACTIVE" } };
  assert.equal(store.ingest(stale), false);
  assert.deepEqual(await store.getGateProposal("nouns", "992"), {
    chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
    proposalId: "992", title: proposal.normalized.title, proposer: proposal.normalized.proposer,
    refreshedAt: "2026-09-14T00:05:00.000Z", sourceBlock: "105",
    sourceBlockHash: `0x${"2".repeat(64)}`, effectiveStatus: "DEFEATED",
    contentHash: `0x${proposal.contentHash}`, actions: [],
  });

  store.rawRecords.push({ ...store.rawRecords[0], sourceId: "unrelated", sourceRecordKey: "proposal:unrelated",
    blockNumber: "999", blockHash: `0x${"4".repeat(64)}`, ingestedAt: "2026-09-14T00:20:00.000Z" });
  store.proposalActions.push({ daoId: "nouns", proposalId: "992", index: 0, target: proposal.normalized.proposer,
    valueWei: "0", signature: "", calldata: "0x", privateDestination: "secret@example.test" });
  const projection = await store.getGateProposal("nouns", "992");
  assert.equal(projection.sourceBlock, "105");
  assert.deepEqual(projection.actions, [{ actionIndex: 0, target: proposal.normalized.proposer,
    valueWei: "0", signature: "", calldata: "0x" }]);

  store.proposalActions.push({ daoId: "nouns", proposalId: "992", index: 0, target: proposal.normalized.proposer,
    valueWei: "0", signature: "", calldata: "0x" });
  await assert.rejects(store.getGateProposal("nouns", "992"), /action index/);

  const before = structuredClone({ proposals: store.proposals, actions: store.proposalActions });
  for (const actions of [null, false, 0, "", new Array(1)]) {
    assert.throws(() => store.upsertProposal({ ...proposal, actions }), /proposal action/);
    assert.deepEqual({ proposals: store.proposals, actions: store.proposalActions }, before);
  }
});

test("a migration-style memory row is hydrated on get and list", async () => {
  const store = new MemoryGovernanceStore();
  store.proposals.push(migratedNouns992());
  store.proposals.push(refreshedNouns996());

  const single = await store.getProposal("nouns", "992");
  assert.equal(single.state, "ACTIVE");
  assert.equal(single.sourceState, "ACTIVE");
  assert.equal(single.outcome, "DEFEATED");
  assert.equal(single.effectiveStatus, "DEFEATED");
  assert.equal(single.trackingState, "FINAL");

  const fresh = await store.getProposal("nouns", "996");
  assert.equal(fresh.state, "PENDING");
  assert.equal(fresh.effectiveStatus, "PENDING");
  assert.equal(fresh.trackingState, "HOT");

  const page = await store.listProposals({ daoId: "nouns", limit: 10 });
  const byId = Object.fromEntries(page.items.map((item) => [item.id, item]));
  assert.equal(byId["992"].effectiveStatus, "DEFEATED");
  assert.equal(byId["992"].state, "ACTIVE");
  assert.equal(byId["996"].effectiveStatus, "PENDING");
});

test("Nouns proposals 993-998 retain titles across descending pagination", async () => {
  const store = new MemoryGovernanceStore();
  const titles = new Map([
    ["993", "Nounworks for Nouns"],
    ["994", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
    ["995", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
    ["996", "Camp operational costs 2026/2027"],
    ["997", "Unwrap & Stake Treasury WETH"],
    ["998", "Unwrap & Stake Treasury WETH"],
  ]);
  for (const [proposalId, title] of [...titles].reverse()) {
    store.upsertProposal({
      daoId: "nouns", proposalId, contentHash: proposalId.padStart(64, "0"), actions: [],
      normalized: { id: proposalId, title, state: "ACTIVE", effectiveStatus: "ACTIVE" },
    });
  }

  const seen = [];
  let cursor;
  do {
    const page = await store.listProposals({ daoId: "nouns", limit: 2, cursor });
    seen.push(...page.items.map(({ id, title }) => [id, title]));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(seen, [...titles].reverse());
  assert.equal(new Map(seen).size, 6);
});

test("API list and detail expose the same hydrated lifecycle fields", async () => {
  const store = new MemoryGovernanceStore();
  await store.transaction(async (tx) => tx.upsertDao({ id: "nouns", chainId: 1 }));
  store.proposals.push(migratedNouns992());
  store.proposals.push(refreshedNouns996());

  const detail = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals/992");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.state, "ACTIVE");
  assert.equal(detail.body.sourceState, "ACTIVE");
  assert.equal(detail.body.outcome, "DEFEATED");
  assert.equal(detail.body.effectiveStatus, "DEFEATED");
  assert.equal(detail.body.trackingState, "FINAL");

  const list = await request(createReadOnlyApi({ store }), "/v1/daos/nouns/proposals?limit=10");
  assert.equal(list.status, 200);
  const item = list.body.items.find((row) => row.id === "992");
  assert.deepEqual(
    {
      state: item.state,
      sourceState: item.sourceState,
      outcome: item.outcome,
      effectiveStatus: item.effectiveStatus,
      trackingState: item.trackingState,
    },
    {
      state: "ACTIVE",
      sourceState: "ACTIVE",
      outcome: "DEFEATED",
      effectiveStatus: "DEFEATED",
      trackingState: "FINAL",
    },
  );
  const open = list.body.items.find((row) => row.id === "996");
  assert.equal(open.effectiveStatus, "PENDING");
  assert.equal(open.trackingState, "HOT");
});

test("backtest redaction still strips lifecycle fields from training evidence", () => {
  const presented = presentProposal(migratedNouns992().normalized, migratedNouns992());
  const evidence = toTrainingEvidence({
    blockNumber: "10",
    source: { entityId: "a" },
    proposal: presented,
  });
  assert.equal(evidence.proposal.state, undefined);
  assert.equal(evidence.proposal.outcome, undefined);
  assert.equal(evidence.proposal.sourceState, undefined);
  assert.equal(evidence.proposal.effectiveStatus, undefined);
  assert.equal(evidence.proposal.trackingState, undefined);
  assert.equal(evidence.proposal.lifecycleReason, undefined);
  assert.equal(evidence.proposal.title, "Stale ACTIVE blob");
});
