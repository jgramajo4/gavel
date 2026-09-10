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
