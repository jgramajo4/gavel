/**
 * The unified governance inbox.
 *
 * The home screen used to be "the Nouns proposal list", which made Nouns the
 * application rather than one of the DAOs it follows. The inbox replaces it
 * with a question that has an answer across every DAO at once: what needs my
 * attention, and where?
 *
 * The ranking is built here, not in a component, for the same reason the
 * wizard is: it is governance semantics. "Ends soonest first, among the
 * proposals you can still act on" is a policy, and a policy that lives in a
 * render function cannot be tested or reused by a headless runtime.
 *
 * DAO identity is never dropped from a row. Every entry carries its DAO id and
 * display name, and `formatDaoProposal()` puts the DAO name in the label,
 * because the worst failure mode of a merged inbox is voting in the wrong
 * governance system.
 */

const { daoProposalKey, daoProposalRef, formatDaoProposal } = require("../dao/proposal-ref");
const { findDaoDescriptor } = require("../dao/catalog");

/** Why a row is in "needs attention". Ordered most to least urgent. */
const AttentionReason = Object.freeze({
  EXECUTION_REQUIRED: "EXECUTION_REQUIRED",
  VOTING_ENDS_SOON: "VOTING_ENDS_SOON",
  VOTE_OPEN: "VOTE_OPEN",
  NEW_PROPOSAL: "NEW_PROPOSAL",
  VOTING_OPENS_SOON: "VOTING_OPENS_SOON",
});

const ATTENTION_RANK = Object.freeze({
  [AttentionReason.EXECUTION_REQUIRED]: 0,
  [AttentionReason.VOTING_ENDS_SOON]: 1,
  [AttentionReason.VOTE_OPEN]: 2,
  [AttentionReason.NEW_PROPOSAL]: 3,
  [AttentionReason.VOTING_OPENS_SOON]: 4,
});

const ENDING_SOON_SECONDS = 24 * 60 * 60;
const NEW_PROPOSAL_SECONDS = 48 * 60 * 60;

const OPEN_STATES = new Set(["ACTIVE", "OBJECTION_PERIOD"]);
const UPCOMING_STATES = new Set(["PENDING", "UPDATABLE"]);

function seconds(value) {
  if (value == null) return null;
  if (typeof value === "number") return Math.floor(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Classify one proposal for one user.
 *
 * `voted` and `executionPending` come from the caller because they are facts
 * about this user's own state, which the inbox does not fetch.
 */
function classifyProposal(proposal, context = {}) {
  const now = context.now ? Math.floor(context.now.getTime() / 1000) : Math.floor(Date.now() / 1000);
  const state = String(proposal.state || proposal.status || "").toUpperCase();
  const endsAt = seconds(proposal.endTime ?? proposal.endTimestamp);
  const createdAt = seconds(proposal.createdAt ?? proposal.createdTimestamp);
  const endsIn = endsAt != null ? endsAt - now : null;

  if (proposal.executionPending === true) {
    return { reason: AttentionReason.EXECUTION_REQUIRED, endsIn };
  }
  if (OPEN_STATES.has(state) && proposal.voted !== true) {
    if (endsIn != null && endsIn >= 0 && endsIn <= ENDING_SOON_SECONDS) {
      return { reason: AttentionReason.VOTING_ENDS_SOON, endsIn };
    }
    return { reason: AttentionReason.VOTE_OPEN, endsIn };
  }
  if (UPCOMING_STATES.has(state)) {
    if (createdAt != null && now - createdAt <= NEW_PROPOSAL_SECONDS) {
      return { reason: AttentionReason.NEW_PROPOSAL, endsIn };
    }
    return { reason: AttentionReason.VOTING_OPENS_SOON, endsIn };
  }
  return { reason: null, endsIn };
}

function inboxEntry(proposal, context) {
  const ref = daoProposalRef(proposal.dao, proposal.id);
  const { reason, endsIn } = classifyProposal(proposal, context);
  const descriptor = findDaoDescriptor(ref.dao);
  return {
    key: daoProposalKey(ref),
    dao: ref.dao,
    daoDisplayName: descriptor?.displayName || ref.dao,
    chainId: ref.chainId,
    proposalId: ref.proposalId,
    label: formatDaoProposal(ref),
    title: String(proposal.title || "").trim() || `Proposal ${ref.proposalId}`,
    state: String(proposal.state || proposal.status || "UNKNOWN").toUpperCase(),
    endsIn,
    endsAt: seconds(proposal.endTime ?? proposal.endTimestamp),
    voted: proposal.voted === true,
    recommendation: proposal.recommendation || null,
    attention: reason,
    needsAttention: reason != null,
  };
}

/**
 * Build the whole inbox.
 *
 * `daos` carries one entry per followed DAO even when its proposals failed to
 * load, so a DAO that is down appears in the "Following" list with its error
 * instead of vanishing. A missing DAO looks like Gavel forgot it; a DAO marked
 * unavailable looks like what it is.
 */
function buildGovernanceInbox(input = {}) {
  const context = { now: input.now || new Date() };
  const followed = input.followedDaos || [];
  const proposals = (input.proposals || []).map((proposal) => inboxEntry(proposal, context));
  const failures = new Map((input.daoErrors || []).map((entry) => [entry.dao, entry.message]));
  const readiness = new Map((input.readiness || []).map((entry) => [entry.dao, entry]));

  const needsAttention = proposals
    .filter((entry) => entry.needsAttention)
    .sort((left, right) => {
      const rank = ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention];
      if (rank !== 0) return rank;
      // Soonest deadline first; proposals with no known deadline go last.
      if (left.endsIn == null && right.endsIn == null) return left.key.localeCompare(right.key);
      if (left.endsIn == null) return 1;
      if (right.endsIn == null) return -1;
      return left.endsIn - right.endsIn;
    });

  const daos = followed.map((dao) => {
    const descriptor = findDaoDescriptor(dao);
    const mine = proposals.filter((entry) => entry.dao === dao);
    const error = failures.get(dao) || null;
    const ready = readiness.get(dao) || null;
    return {
      dao,
      displayName: descriptor?.displayName || dao,
      active: mine.filter((entry) => OPEN_STATES.has(entry.state)).length,
      needsAttention: mine.filter((entry) => entry.needsAttention).length,
      total: mine.length,
      available: !error,
      error,
      monitor: ready?.monitor || null,
      vote: ready?.vote || null,
    };
  });

  return {
    needsAttention,
    proposals,
    daos,
    counts: {
      followed: followed.length,
      available: daos.filter((entry) => entry.available).length,
      unavailable: daos.filter((entry) => !entry.available).length,
      needsAttention: needsAttention.length,
    },
  };
}

/** Narrow an already-built inbox to one DAO, without refetching anything. */
function filterInboxByDao(inbox, dao) {
  if (!dao) return inbox;
  return {
    ...inbox,
    needsAttention: inbox.needsAttention.filter((entry) => entry.dao === dao),
    proposals: inbox.proposals.filter((entry) => entry.dao === dao),
    daos: inbox.daos.filter((entry) => entry.dao === dao),
  };
}

module.exports = {
  AttentionReason,
  ENDING_SOON_SECONDS,
  NEW_PROPOSAL_SECONDS,
  buildGovernanceInbox,
  classifyProposal,
  filterInboxByDao,
};
