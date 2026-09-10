const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DAO_CONFIGS,
  MemoryGovernanceStore,
  GovernanceSyncWorker,
  NounsSubgraphSource,
  EnsGovernorSource,
} = require("../packages/governance-index");
const {
  TrackingState,
  applyGovernanceLifecycle,
  deriveGovernanceStatus,
  trackingStateFor,
} = require("../packages/core/src/governance/lifecycle");
const { NOUNS_REFRESH_PROPOSALS_QUERY } = require("../packages/governance-index/src/nouns-source");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "nouns-proposals-991-996.json"), "utf8"));
const SNAPSHOT = Number(FIXTURE.snapshotBlock);
const FINALITY_DEPTH = 12;
// `NounsSubgraphSource.head()` subtracts its finality depth, so the head the
// subgraph reports has to be ahead of the snapshot the worker will pin.
const SUBGRAPH_HEAD = SNAPSHOT + FINALITY_DEPTH;

function fixtureProposal(id) {
  const row = FIXTURE.proposals.find((proposal) => proposal.id === String(id));
  if (!row) throw new Error(`no fixture for proposal ${id}`);
  const { expected, ...subgraphRow } = row;
  return { subgraphRow, expected };
}

/**
 * A Nouns subgraph stand-in. Records every GraphQL call so a test can assert how
 * much upstream work one cycle actually costs, and serves a fixed proposal set
 * from the fixture rather than from a live service.
 */
function nounsSubgraph(options = {}) {
  const proposals = (options.proposals || FIXTURE.proposals).map(({ expected, ...row }) => row);
  const calls = [];
  const fetch = async (_endpoint, init) => {
    const { query, variables } = JSON.parse(init.body);
    const operation = query.includes("_meta") ? "meta"
      : query.includes("votes(") ? "votes"
      : query.includes("id_in") ? "refreshProposals"
      : query.includes("createdBlock_gte") ? "newProposals"
      : "allProposals";
    calls.push({ operation, variables });
    if (operation === "meta") return json({ _meta: { block: { number: SUBGRAPH_HEAD } } });
    if (operation === "votes") return json({ votes: [] });
    if (operation === "refreshProposals") {
      const wanted = new Set((variables.ids || []).map(String));
      return json({ proposals: proposals.filter((row) => wanted.has(String(row.id))) });
    }
    if (operation === "newProposals") {
      const after = String(variables.after || "");
      const from = BigInt(variables.from);
      return json({
        proposals: proposals
          .filter((row) => BigInt(row.createdBlock) >= from && String(row.id) > after)
          .sort((a, b) => (String(a.id) > String(b.id) ? 1 : -1)),
      });
    }
    const after = String(variables.after || "");
    return json({ proposals: proposals.filter((row) => String(row.id) > after).sort((a, b) => (String(a.id) > String(b.id) ? 1 : -1)) });
  };
  const source = new NounsSubgraphSource({ fetch, finalityDepth: FINALITY_DEPTH, replayBlocks: 8, pageSize: 500 });
  return { source, calls };
}

function json(data) {
  return { ok: true, async json() { return { data }; } };
}

function refreshedIds(calls) {
  return calls.filter((call) => call.operation === "refreshProposals").flatMap((call) => call.variables.ids.map(String));
}

test("a stale source ACTIVE on a finalized losing vote derives DEFEATED and FINAL", () => {
  for (const id of ["992", "993", "995"]) {
    const { subgraphRow, expected } = fixtureProposal(id);
    const derived = deriveGovernanceStatus({
      sourceState: subgraphRow.status,
      timing: "block",
      endBlock: subgraphRow.endBlock,
      finalizedBlock: FIXTURE.snapshotBlock,
      forVotes: subgraphRow.forVotes,
      againstVotes: subgraphRow.againstVotes,
      quorumVotes: subgraphRow.quorumVotes,
    });
    assert.equal(subgraphRow.status, "ACTIVE", `proposal ${id} fixture must carry the stale upstream value`);
    assert.equal(derived.effectiveStatus, expected.effectiveStatus, `proposal ${id} effective status`);
    assert.equal(derived.trackingState, TrackingState.FINAL, `proposal ${id} tracking state`);
  }
});

test("every lifecycle phase maps to the tracking state that matches how much it can still change", () => {
  const hot = ["UPDATABLE", "PENDING", "ACTIVE", "OBJECTION_PERIOD", "SPONSORING", "REVIEW"];
  const warm = ["SUCCEEDED", "QUEUED"];
  const final = ["DEFEATED", "EXECUTED", "CANCELLED", "CANCELED", "VETOED", "EXPIRED", "SPONSORSHIP_EXPIRED"];
  for (const status of hot) assert.equal(trackingStateFor(status), TrackingState.HOT, status);
  for (const status of warm) assert.equal(trackingStateFor(status), TrackingState.WARM, status);
  for (const status of final) assert.equal(trackingStateFor(status), TrackingState.FINAL, status);
  // An unmodelled label must cost a refresh, never a frozen record.
  assert.equal(trackingStateFor("SOME_NEW_UPSTREAM_STATE"), TrackingState.HOT);
});

test("a pending proposal whose voting has not started stays trackable, and an active one stays HOT", () => {
  const { subgraphRow: pending } = fixtureProposal("996");
  const derivedPending = applyGovernanceLifecycle(
    { state: pending.status, timing: "block", endBlock: pending.endBlock, forVotes: pending.forVotes, againstVotes: pending.againstVotes, quorumVotes: pending.quorumVotes },
    { finalizedBlock: FIXTURE.snapshotBlock },
  );
  assert.equal(derivedPending.effectiveStatus, "PENDING");
  assert.equal(derivedPending.trackingState, TrackingState.HOT);
  assert.equal(derivedPending.lifecycleReason, "voting_open");

  const derivedActive = applyGovernanceLifecycle(
    { state: "ACTIVE", timing: "block", endBlock: String(SNAPSHOT + 500), forVotes: "1", againstVotes: "0", quorumVotes: "9" },
    { finalizedBlock: FIXTURE.snapshotBlock },
  );
  assert.equal(derivedActive.effectiveStatus, "ACTIVE");
  assert.equal(derivedActive.trackingState, TrackingState.HOT);
});

test("a proposal that won its finalized vote is WARM until the source reports what happened next", () => {
  const won = { state: "ACTIVE", timing: "block", endBlock: "100", forVotes: "90", againstVotes: "10", quorumVotes: "50" };
  const succeeded = applyGovernanceLifecycle(won, { finalizedBlock: "200" });
  assert.equal(succeeded.effectiveStatus, "SUCCEEDED");
  assert.equal(succeeded.trackingState, TrackingState.WARM);

  const queued = applyGovernanceLifecycle({ ...won, state: "QUEUED" }, { finalizedBlock: "200" });
  assert.equal(queued.effectiveStatus, "QUEUED");
  assert.equal(queued.trackingState, TrackingState.WARM);
  assert.equal(queued.lifecycleReason, "source_state_post_vote");
});

test("the source state is preserved alongside the derived status rather than overwritten", () => {
  const { subgraphRow } = fixtureProposal("992");
  const derived = applyGovernanceLifecycle(
    { state: subgraphRow.status, timing: "block", endBlock: subgraphRow.endBlock, forVotes: subgraphRow.forVotes, againstVotes: subgraphRow.againstVotes, quorumVotes: subgraphRow.quorumVotes },
    { finalizedBlock: FIXTURE.snapshotBlock },
  );
  assert.equal(derived.state, "ACTIVE", "`state` keeps its existing meaning for external consumers");
  assert.equal(derived.sourceState, "ACTIVE");
  assert.equal(derived.effectiveStatus, "DEFEATED");
  assert.equal(derived.outcome, "DEFEATED", "`outcome` remains the derived verdict");
  assert.equal(derived.trackingState, TrackingState.FINAL);
  // Re-deriving must not feed a previous verdict back into itself.
  assert.deepEqual(applyGovernanceLifecycle(derived, { finalizedBlock: FIXTURE.snapshotBlock }), derived);
});

test("incremental sync terminalizes stale-ACTIVE Nouns proposals without a full enumeration", async () => {
  const store = new MemoryGovernanceStore();
  const { source, calls } = nounsSubgraph();
  const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100_000 });

  const first = await worker.syncDao("nouns", { fullProposalScan: false });
  assert.equal(first.fullProposalScan, false, "the very first pass under test is incremental");
  assert.equal(calls.some((call) => call.operation === "allProposals"), false, "no full enumeration was performed");

  for (const { id, expected } of FIXTURE.proposals.map((row) => ({ id: row.id, expected: row.expected }))) {
    const indexed = await store.getProposal("nouns", id);
    assert.ok(indexed, `proposal ${id} was indexed`);
    assert.equal(indexed.effectiveStatus, expected.effectiveStatus, `proposal ${id} effective status`);
    assert.equal(indexed.trackingState, expected.trackingState, `proposal ${id} tracking state`);
  }
  const stale = await store.getProposal("nouns", "992");
  assert.equal(stale.state, "ACTIVE", "the raw upstream value is preserved for provenance");
  assert.equal(stale.effectiveStatus, "DEFEATED");
});

test("a terminalized proposal leaves the routine refresh set, so steady-state cost tracks open governance", async () => {
  const store = new MemoryGovernanceStore();
  const { source, calls } = nounsSubgraph();
  const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100_000 });
  await worker.syncDao("nouns", { fullProposalScan: false });

  const context = await store.getProposalSyncContext("nouns");
  assert.deepEqual(
    context.refreshProposals.map((row) => row.proposalId),
    ["996"],
    "only the proposal that can still change is planned for refresh",
  );

  calls.length = 0;
  await worker.syncDao("nouns", { fullProposalScan: false });
  assert.deepEqual(refreshedIds(calls), ["996"], "a stale upstream ACTIVE cannot hold a defeated proposal in the refresh set");
  assert.equal(calls.filter((call) => call.operation === "refreshProposals").length, 1);
});

test("a WARM proposal is re-read on a slower cadence than a live vote", async () => {
  const store = new MemoryGovernanceStore();
  const won = { id: "42", contentHash: "a".repeat(64), createdBlock: "10", state: "ACTIVE", timing: "block", endBlock: "100", forVotes: "90", againstVotes: "10", quorumVotes: "50" };
  await store.transaction(async (tx) => {
    tx.upsertProposal({ daoId: "nouns", proposalId: "42", contentHash: won.contentHash, normalized: applyGovernanceLifecycle(won, { finalizedBlock: "200" }), actions: [] });
  });
  assert.equal((await store.getProposal("nouns", "42")).trackingState, TrackingState.WARM);

  const fresh = await store.getProposalSyncContext("nouns", { warmRefreshIntervalMs: 60_000 });
  assert.deepEqual(fresh.refreshProposals.map((row) => row.proposalId), [], "a just-read WARM proposal is not re-read immediately");

  const due = await store.getProposalSyncContext("nouns", { warmRefreshIntervalMs: 60_000, now: Date.now() + 120_000 });
  assert.deepEqual(due.refreshProposals.map((row) => row.proposalId), ["42"], "it is re-read once its interval elapses");
});

test("a stale hot set collapses without upstream requests when the stored tallies already prove the outcome", async () => {
  const store = new MemoryGovernanceStore();
  const { subgraphRow } = fixtureProposal("992");
  // An index written before the lifecycle model: the derived verdict was never
  // consulted, so the row sits in the hot set on a raw ACTIVE.
  await store.transaction(async (tx) => {
    tx.upsertProposal({
      daoId: "nouns",
      proposalId: "992",
      contentHash: "a".repeat(64),
      lastObservedBlock: FIXTURE.snapshotBlock,
      normalized: {
        id: "992", contentHash: "a".repeat(64), state: "ACTIVE", outcome: "ACTIVE", timing: "block",
        createdBlock: subgraphRow.createdBlock, endBlock: subgraphRow.endBlock,
        forVotes: subgraphRow.forVotes, againstVotes: subgraphRow.againstVotes, quorumVotes: subgraphRow.quorumVotes,
      },
      actions: [],
    });
  });
  assert.equal((await store.getProposal("nouns", "992")).trackingState, undefined);

  const { source, calls } = nounsSubgraph({ proposals: [] });
  await new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100_000 }).syncDao("nouns", { fullProposalScan: false });

  const repaired = await store.getProposal("nouns", "992");
  assert.equal(repaired.effectiveStatus, "DEFEATED");
  assert.equal(repaired.trackingState, TrackingState.FINAL);
  assert.deepEqual(refreshedIds(calls), [], "terminalization spent no upstream request");
});

test("stored tallies read before the deadline are never terminalized locally", async () => {
  const store = new MemoryGovernanceStore();
  const { subgraphRow } = fixtureProposal("992");
  const midVote = String(BigInt(subgraphRow.endBlock) - 10n);
  await store.transaction(async (tx) => {
    tx.upsertProposal({
      daoId: "nouns", proposalId: "992", contentHash: "a".repeat(64), lastObservedBlock: midVote,
      normalized: {
        id: "992", contentHash: "a".repeat(64), state: "ACTIVE", outcome: "ACTIVE", timing: "block",
        createdBlock: subgraphRow.createdBlock, endBlock: subgraphRow.endBlock,
        forVotes: "0", againstVotes: "0", quorumVotes: subgraphRow.quorumVotes,
      },
      actions: [],
    });
  });
  const { source, calls } = nounsSubgraph({ proposals: [] });
  await new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100_000 }).syncDao("nouns", { fullProposalScan: false });

  assert.notEqual((await store.getProposal("nouns", "992")).trackingState, TrackingState.FINAL);
  assert.deepEqual(refreshedIds(calls), ["992"], "an unfinished observation is refreshed upstream instead of guessed");
});

test("full reconciliation still repairs history and removes proposals that disappeared", async () => {
  const store = new MemoryGovernanceStore();
  const worker = (subgraph) => new GovernanceSyncWorker({ store, sources: { nouns: subgraph.source }, batchSize: 100_000 });
  await worker(nounsSubgraph()).syncDao("nouns", { fullProposalScan: false });
  assert.equal(store.proposals.length, 6);

  // Corrupt an indexed row the way a partial write or an older build would have.
  await store.transaction(async (tx) => {
    const row = store.proposals.find((proposal) => proposal.proposalId === "993");
    tx.upsertProposal({ ...row, normalized: { ...row.normalized, state: "ACTIVE", outcome: "ACTIVE", effectiveStatus: "ACTIVE", trackingState: TrackingState.HOT, forVotes: "0" } });
  });
  assert.equal((await store.getProposal("nouns", "993")).effectiveStatus, "ACTIVE");

  const survivors = FIXTURE.proposals.filter((row) => row.id !== "994");
  const full = nounsSubgraph({ proposals: survivors });
  const result = await worker(full).syncDao("nouns", { fullProposalScan: true });
  assert.equal(result.fullProposalScan, true);
  assert.ok(full.calls.some((call) => call.operation === "allProposals"), "reconciliation enumerates every proposal");
  assert.equal((await store.getProposal("nouns", "993")).effectiveStatus, "DEFEATED", "reconciliation repaired the corrupted row");
  assert.equal(await store.getProposal("nouns", "994"), null, "a proposal absent from a full enumeration is removed");
});

test("an incremental pass never deletes a historical proposal", async () => {
  const store = new MemoryGovernanceStore();
  await new GovernanceSyncWorker({ store, sources: { nouns: nounsSubgraph().source }, batchSize: 100_000 }).syncDao("nouns", { fullProposalScan: false });
  const indexed = store.proposals.map((row) => row.proposalId).sort();

  // Upstream now returns nothing at all. Only a full enumeration is authoritative
  // about which proposals exist, so an incremental pass must leave history alone.
  const empty = nounsSubgraph({ proposals: [] });
  await new GovernanceSyncWorker({ store, sources: { nouns: empty.source }, batchSize: 100_000 }).syncDao("nouns", { fullProposalScan: false });
  assert.deepEqual(store.proposals.map((row) => row.proposalId).sort(), indexed);
  assert.equal(store.rawRecords.filter((row) => row.recordType === "proposal").length, 6);
});

test("incremental discovery keeps the replay window and never rescans from genesis", async () => {
  const store = new MemoryGovernanceStore();
  const { source, calls } = nounsSubgraph();
  const worker = new GovernanceSyncWorker({ store, sources: { nouns: source }, batchSize: 100_000 });
  await worker.syncDao("nouns", { fullProposalScan: true });
  const checkpoint = store.checkpoints.get("nouns:nouns-subgraph");
  assert.equal(Number(checkpoint.nextBlock), SNAPSHOT + 1);

  calls.length = 0;
  await worker.syncDao("nouns", { fullProposalScan: false });
  const discovery = calls.find((call) => call.operation === "newProposals");
  assert.ok(discovery, "an incremental pass still discovers newly created proposals");
  // replayBlocks (8) plus the one-block overlap the worker applies.
  assert.equal(Number(discovery.variables.from), SNAPSHOT + 1 - 8 - 1);
  assert.equal(calls.some((call) => call.operation === "allProposals"), false);
});

test("a lifecycle change is logged once with its reason, and immutable proposals are silent", async () => {
  const store = new MemoryGovernanceStore();
  const lines = [];
  const logger = { info: (row) => lines.push(row), warn() {}, error() {} };
  const worker = new GovernanceSyncWorker({ store, sources: { nouns: nounsSubgraph().source }, batchSize: 100_000, logger });
  await worker.syncDao("nouns", { fullProposalScan: false });

  const finalized = lines.filter((row) => row.event === "proposal_finalized");
  assert.deepEqual(finalized.map((row) => row.proposalId).sort(), ["991", "992", "993", "994", "995"]);
  const defeated = finalized.find((row) => row.proposalId === "992");
  assert.equal(defeated.sourceState, "ACTIVE");
  assert.equal(defeated.effectiveStatus, "DEFEATED");
  assert.equal(defeated.trackingState, TrackingState.FINAL);
  assert.equal(defeated.lifecycleReason, "voting_finalized_defeated");
  assert.ok(defeated.refreshReason, "every lifecycle line names why the proposal was looked at");

  lines.length = 0;
  await worker.syncDao("nouns", { fullProposalScan: false });
  assert.deepEqual(lines.filter((row) => row.event === "proposal_finalized"), [], "an unchanged immutable proposal logs nothing");
  const plan = lines.find((row) => row.event === "proposal_refresh_plan");
  assert.equal(plan.upstreamRefresh, 1, "one open proposal, not the whole history");
});

test("status reports the lifecycle census the refresh plan is drawn from", async () => {
  const store = new MemoryGovernanceStore();
  await new GovernanceSyncWorker({ store, sources: { nouns: nounsSubgraph().source }, batchSize: 100_000 }).syncDao("nouns", { fullProposalScan: false });
  assert.deepEqual(await store.status().then((status) => status.tracking), [
    { daoId: "nouns", trackingState: "FINAL", count: 5 },
    { daoId: "nouns", trackingState: "HOT", count: 1 },
  ]);
});

test("an ENS proposal awaiting its first canonical read is never terminalized from placeholder tallies", async () => {
  // `normalizeLog` produces a record with UNKNOWN state and zeroed tallies before
  // `refreshProposal` fills it in. Deriving from those would confidently mark a
  // brand new proposal DEFEATED.
  const placeholder = applyGovernanceLifecycle(
    { state: "UNKNOWN", timing: "block", endBlock: "201", forVotes: "0", againstVotes: "0", quorumVotes: "0" },
    { finalizedBlock: "5000" },
  );
  assert.equal(placeholder.effectiveStatus, "UNKNOWN");
  assert.equal(placeholder.trackingState, TrackingState.HOT);
  assert.equal(placeholder.lifecycleReason, "source_state_unknown");
});

test("ENS refreshes are still driven by the Governor's own state and skip FINAL rows", async () => {
  const views = [];
  const governor = {
    async state() { views.push("state"); return 3; },
    async proposalSnapshot() { return 100n; },
    async proposalDeadline() { return 200n; },
    async proposalVotes() { return [9n, 1n, 0n]; },
    async quorum() { return 5n; },
  };
  const source = new EnsGovernorSource({
    rpcUrl: "https://rpc.example", fromBlock: 100, governor,
    provider: { async getLogs() { return []; }, async getBlock() { return { timestamp: 1_700_000_000 }; } },
  });
  const refreshProposals = [
    { proposalId: "1", contentHash: "a".repeat(64), trackingState: TrackingState.HOT, normalized: { id: "1", state: "ACTIVE", actions: [] } },
    { proposalId: "2", contentHash: "b".repeat(64), trackingState: TrackingState.FINAL, normalized: { id: "2", state: "ACTIVE", actions: [] } },
  ];
  const refreshed = await source.fetchProposals(1000, 1020, 1020, { full: false, refreshProposals });
  assert.deepEqual(refreshed.map((row) => row.proposal.proposalId), ["1"], "tracking state decides, not the raw source value");
  assert.equal(views.length, 1);
  assert.equal(refreshed[0].proposal.normalized.state, "DEFEATED", "the Governor's own state is authoritative for ENS");
});

test("the configured Nouns governor answers state(uint256); the token address does not", () => {
  const { NOUNS_TOKEN_ADDRESS, GOVERNANCE_ADDRESS, GOVERNANCE_ABI } = require("../packages/nouns-adapter/src/vote");
  assert.equal(DAO_CONFIGS.nouns.currentGovernor, GOVERNANCE_ADDRESS, "currentGovernor must name the Governor, not the token");
  assert.notEqual(DAO_CONFIGS.nouns.currentGovernor, NOUNS_TOKEN_ADDRESS);
  assert.equal(DAO_CONFIGS.nouns.tokenAddress, NOUNS_TOKEN_ADDRESS);
  assert.ok(GOVERNANCE_ABI.some((entry) => entry.includes("function state(uint256")));
  // The provenance key of every already-indexed Nouns record stays put.
  assert.equal(DAO_CONFIGS.nouns.contractAddress, NOUNS_TOKEN_ADDRESS);
});

test("the refresh query the indexer sends is a bounded id lookup, not a full page walk", () => {
  assert.match(NOUNS_REFRESH_PROPOSALS_QUERY, /id_in:\$ids/);
  assert.doesNotMatch(NOUNS_REFRESH_PROPOSALS_QUERY, /id_gt/);
});

test("the Postgres store persists the derived status and tracking state alongside the raw one", async () => {
  const { PostgresTransaction } = require("../packages/governance-index/src/postgres-store");
  const queries = [];
  const tx = new PostgresTransaction({ async query(text, values) { queries.push({ text, values }); return { rows: [], rowCount: 1 }; } });
  const { subgraphRow } = fixtureProposal("992");
  const normalized = applyGovernanceLifecycle(
    { id: "992", state: subgraphRow.status, timing: "block", endBlock: subgraphRow.endBlock, forVotes: subgraphRow.forVotes, againstVotes: subgraphRow.againstVotes, quorumVotes: subgraphRow.quorumVotes },
    { finalizedBlock: FIXTURE.snapshotBlock },
  );
  await tx.upsertProposal({ daoId: "nouns", proposalId: "992", contentHash: "a".repeat(64), normalized, lastObservedBlock: FIXTURE.snapshotBlock });

  const insert = queries.find((query) => query.text.includes("INSERT INTO proposals"));
  assert.match(insert.text, /effective_status,tracking_state,lifecycle_reason,last_observed_block/);
  assert.match(insert.text, /effective_status=excluded\.effective_status,tracking_state=excluded\.tracking_state/);
  assert.equal(insert.values[6], "ACTIVE", "proposal_status stays the raw upstream value");
  assert.equal(insert.values[16], "DEFEATED", "effective_status is Gavel's verdict");
  assert.equal(insert.values[17], TrackingState.FINAL);
  assert.equal(insert.values[18], "voting_finalized_defeated");
});

test("the Postgres refresh plan is a tracking-state query that never selects FINAL rows", async () => {
  const { PostgresGovernanceStore } = require("../packages/governance-index/src/postgres-store");
  const queries = [];
  const store = Object.create(PostgresGovernanceStore.prototype);
  store.pool = { async query(text, values) { queries.push({ text, values }); return { rows: [] }; } };
  await store.getProposalSyncContext("nouns", { warmRefreshIntervalMs: 900_000 });

  const plan = queries.find((query) => query.text.includes("tracking_state"));
  assert.match(plan.text, /tracking_state <> \$2/);
  assert.doesNotMatch(plan.text, /proposal_status/, "raw source state no longer decides refresh eligibility");
  assert.deepEqual(plan.values.slice(1), ["FINAL", "HOT", 900]);
});
