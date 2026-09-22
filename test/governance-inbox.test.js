const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AttentionReason,
  buildGovernanceInbox,
  classifyProposal,
  filterInboxByDao,
  resolveDaoReadiness,
} = require("../packages/core");

const NOW = new Date("2026-03-01T12:00:00.000Z");
const hoursFromNow = (hours) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

const proposal = (overrides) => ({
  dao: "nouns",
  id: "1",
  title: "A proposal",
  state: "ACTIVE",
  endTime: hoursFromNow(72),
  createdAt: hoursFromNow(-200),
  ...overrides,
});

test("the inbox spans every followed DAO and keeps DAO identity on every row", () => {
  const inbox = buildGovernanceInbox({
    now: NOW,
    followedDaos: ["nouns", "ens", "railgun-eth"],
    proposals: [
      proposal({ dao: "nouns", id: "812", title: "Fund the thing", createdAt: hoursFromNow(-2), state: "PENDING" }),
      proposal({ dao: "ens", id: "123", title: "Treasury swap", endTime: hoursFromNow(8) }),
      proposal({ dao: "railgun-eth", id: "7", title: "Parameter change", state: "PENDING", createdAt: hoursFromNow(-500) }),
    ],
  });

  // Ends-soonest-first among what can still be acted on.
  assert.deepEqual(
    inbox.needsAttention.map((entry) => entry.label),
    ["ENS #123", "Nouns #812", "Railgun #7"],
  );
  assert.deepEqual(
    inbox.needsAttention.map((entry) => entry.attention),
    [AttentionReason.VOTING_ENDS_SOON, AttentionReason.NEW_PROPOSAL, AttentionReason.VOTING_OPENS_SOON],
  );
  // Composite keys, so two DAOs' #1 never collide.
  assert.deepEqual(inbox.proposals.map((entry) => entry.key), ["nouns:812", "ens:123", "railgun-eth:7"]);
  for (const entry of inbox.needsAttention) {
    assert.ok(entry.label.startsWith(entry.daoDisplayName), entry.label);
  }
  assert.deepEqual(inbox.counts, { followed: 3, available: 3, unavailable: 0, needsAttention: 3 });
});

test("an already-cast vote and a finished proposal drop out of needs-attention", () => {
  const inbox = buildGovernanceInbox({
    now: NOW,
    followedDaos: ["nouns"],
    proposals: [
      proposal({ id: "1", voted: true }),
      proposal({ id: "2", state: "EXECUTED" }),
      proposal({ id: "3" }),
    ],
  });
  assert.deepEqual(inbox.needsAttention.map((entry) => entry.proposalId), ["3"]);
  // They are still in the full list; only the attention section is filtered.
  assert.equal(inbox.proposals.length, 3);
});

test("a prepared action that needs execution outranks a closing vote", () => {
  const inbox = buildGovernanceInbox({
    now: NOW,
    followedDaos: ["nouns", "ens"],
    proposals: [
      proposal({ dao: "ens", id: "9", endTime: hoursFromNow(1) }),
      proposal({ dao: "nouns", id: "5", executionPending: true, endTime: hoursFromNow(200) }),
    ],
  });
  assert.deepEqual(inbox.needsAttention.map((entry) => entry.attention), [
    AttentionReason.EXECUTION_REQUIRED,
    AttentionReason.VOTING_ENDS_SOON,
  ]);
});

test("a DAO that failed to load stays visible as unavailable", () => {
  const inbox = buildGovernanceInbox({
    now: NOW,
    followedDaos: ["nouns", "ens"],
    proposals: [proposal({ dao: "nouns", id: "1" })],
    daoErrors: [{ dao: "ens", message: "governance index for ens is 9000s stale" }],
    readiness: [resolveDaoReadiness({ dao: "nouns", identityAddress: null, probe: { indexFresh: true } })],
  });
  const ens = inbox.daos.find((entry) => entry.dao === "ens");
  // Never dropped: a missing DAO looks like Gavel forgot it.
  assert.equal(ens.available, false);
  assert.match(ens.error, /stale/);
  assert.equal(ens.displayName, "ENS");
  // The healthy DAO is unaffected.
  const nouns = inbox.daos.find((entry) => entry.dao === "nouns");
  assert.equal(nouns.available, true);
  assert.equal(nouns.active, 1);
  assert.equal(nouns.monitor, "ready");
  assert.deepEqual(inbox.counts, { followed: 2, available: 1, unavailable: 1, needsAttention: 1 });
});

test("filtering by DAO is a view, not a different fetch", () => {
  const inbox = buildGovernanceInbox({
    now: NOW,
    followedDaos: ["nouns", "ens"],
    proposals: [proposal({ dao: "nouns", id: "1" }), proposal({ dao: "ens", id: "2" })],
  });
  const filtered = filterInboxByDao(inbox, "ens");
  assert.deepEqual(filtered.proposals.map((entry) => entry.key), ["ens:2"]);
  assert.deepEqual(filtered.daos.map((entry) => entry.dao), ["ens"]);
  assert.equal(filterInboxByDao(inbox, null), inbox);
});

test("classification is time-based and DAO-neutral", () => {
  assert.equal(classifyProposal({ state: "ACTIVE", endTime: hoursFromNow(2) }, { now: NOW }).reason, AttentionReason.VOTING_ENDS_SOON);
  assert.equal(classifyProposal({ state: "ACTIVE", endTime: hoursFromNow(100) }, { now: NOW }).reason, AttentionReason.VOTE_OPEN);
  assert.equal(classifyProposal({ state: "OBJECTION_PERIOD" }, { now: NOW }).reason, AttentionReason.VOTE_OPEN);
  assert.equal(classifyProposal({ state: "DEFEATED" }, { now: NOW }).reason, null);
  // A proposal with no deadline still classifies rather than throwing.
  assert.equal(classifyProposal({ state: "ACTIVE" }, { now: NOW }).endsIn, null);
});

test("an empty follow list produces an empty inbox, not an error", () => {
  const inbox = buildGovernanceInbox({ now: NOW, followedDaos: [], proposals: [] });
  assert.deepEqual(inbox.needsAttention, []);
  assert.deepEqual(inbox.daos, []);
  assert.equal(inbox.counts.followed, 0);
});
