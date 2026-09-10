/**
 * The one canonical derivation of what Gavel believes about a proposal.
 *
 * Three concepts are kept apart deliberately:
 *
 *   sourceState     what an upstream subgraph/API/contract reports. Preserved
 *                   for provenance and debugging; never authoritative on its own.
 *   effectiveStatus what Gavel believes is true, derived from canonical
 *                   primitives: the voting window, the finalized block, the
 *                   tallies and quorum, and the lifecycle events a source does
 *                   report.
 *   trackingState   how closely the indexer still needs to observe the proposal.
 *
 * The Nouns subgraph is the motivating case: its `status` enum only advances on
 * an explicit governance event (created/cancelled/vetoed/queued/executed), so a
 * proposal that simply ran out of voting time and lost is reported `ACTIVE`
 * forever. Believing that value keeps a canonically dead proposal in the refresh
 * set for the rest of the DAO's life.
 */

const TrackingState = Object.freeze({ HOT: "HOT", WARM: "WARM", FINAL: "FINAL" });

// Canonically terminal: no sequence of later blocks can move a proposal out of
// one of these.
const FINAL_STATUSES = Object.freeze(new Set([
  "DEFEATED", "EXECUTED", "CANCELLED", "VETOED", "EXPIRED", "SPONSORSHIP_EXPIRED",
]));
// Post-vote but still mutable: the proposal won, and queueing, execution, veto
// or expiry can still happen.
const WARM_STATUSES = Object.freeze(new Set(["SUCCEEDED", "QUEUED"]));
// Pre-finalization labels. These are the only source values Gavel may override,
// because they are the only ones a source can report while being stale about a
// voting window that has already closed. A source that says SUCCEEDED or QUEUED
// has observed an event Gavel cannot re-derive, so it is believed. UNKNOWN is
// deliberately absent: it marks a record that has not been read from its source
// yet, whose zeroed placeholder tallies would derive a confident wrong verdict.
// Pre-vote / in-vote labels. UPDATABLE is Nouns Governor `state()` enum 10
// (the proposer can still edit before voting starts). It is a phase of PENDING
// governance, not a distinct protocol outcome and not the Nouns UI string
// "OPEN FOR CHANGES". That copy belongs in a display layer. Gavel does not
// invent OPEN_FOR_CHANGES as a canonical status.
const OPEN_STATUSES = Object.freeze(new Set([
  "UPDATABLE", "PENDING", "ACTIVE", "OBJECTION_PERIOD",
]));

const STATUS_ALIASES = Object.freeze({
  CANCELED: "CANCELLED",
  OBJECTIONPERIOD: "OBJECTION_PERIOD",
  SPONSORSHIPEXPIRED: "SPONSORSHIP_EXPIRED",
  VETOD: "VETOED",
});

/** Upper-cases and folds spelling variants onto Gavel's canonical labels. */
function normalizeStatus(value) {
  const raw = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!raw) return "UNKNOWN";
  return STATUS_ALIASES[raw] || STATUS_ALIASES[raw.replace(/_/g, "")] || raw;
}

/**
 * An unrecognized label is deliberately HOT rather than FINAL: a source that
 * grows a new state must cost an extra refresh, never a frozen record.
 */
function trackingStateFor(status) {
  const normalized = normalizeStatus(status);
  if (FINAL_STATUSES.has(normalized)) return TrackingState.FINAL;
  if (WARM_STATUSES.has(normalized)) return TrackingState.WARM;
  return TrackingState.HOT;
}

function isTerminalStatus(status) {
  return FINAL_STATUSES.has(normalizeStatus(status));
}

function toBigInt(value) {
  if (value == null || value === "") return null;
  try { return BigInt(String(value)); } catch { return null; }
}

function verdict(effectiveStatus, reason) {
  return { effectiveStatus, trackingState: trackingStateFor(effectiveStatus), reason };
}

/**
 * Derives the canonical status of one proposal.
 *
 * `finalizedBlock` is the block height the caller has actually confirmed — the
 * indexer's finalized head or a pinned subgraph snapshot — not the chain tip.
 * Deriving against an unconfirmed height would terminalize a proposal from
 * tallies that can still move.
 */
function deriveGovernanceStatus(input = {}) {
  const sourceState = normalizeStatus(input.sourceState ?? input.state);
  if (sourceState === "UNKNOWN") return verdict(sourceState, "source_state_unknown");
  if (FINAL_STATUSES.has(sourceState)) return verdict(sourceState, "source_state_terminal");
  // SUCCEEDED/QUEUED and any label this module does not model are the source's
  // to report; Gavel only fills in the transition a source cannot observe.
  if (!OPEN_STATUSES.has(sourceState)) return verdict(sourceState, "source_state_post_vote");
  // Block-timed governance only. A timestamp-timed venue carries a placeholder
  // end block, and comparing a block height against it would terminalize an open
  // proposal instantly.
  if (input.timing != null && input.timing !== "block") return verdict(sourceState, "timing_not_block");

  const endBlock = toBigInt(input.endBlock);
  const finalizedBlock = toBigInt(input.finalizedBlock);
  // A zero end block is a placeholder, not a deadline that has already passed.
  if (endBlock == null || endBlock === 0n || finalizedBlock == null) return verdict(sourceState, "voting_window_unknown");
  if (finalizedBlock <= endBlock) return verdict(sourceState, "voting_open");

  const forVotes = toBigInt(input.forVotes);
  const againstVotes = toBigInt(input.againstVotes);
  const quorumVotes = toBigInt(input.quorumVotes);
  // Without tallies there is nothing to derive from. Staying on the source value
  // keeps the proposal observed rather than guessing an outcome.
  if (forVotes == null || againstVotes == null || quorumVotes == null) {
    return verdict(sourceState, "tallies_unavailable");
  }
  const passed = forVotes > againstVotes && forVotes >= quorumVotes;
  return passed
    ? verdict("SUCCEEDED", "voting_finalized_quorum_met")
    : verdict("DEFEATED", "voting_finalized_defeated");
}

/**
 * Returns a normalized proposal carrying its canonical lifecycle fields.
 *
 * `state` keeps its existing meaning (the raw upstream value) so external
 * contracts do not shift underneath consumers, and `outcome` keeps its existing
 * meaning (Gavel's derived verdict) which is now exactly `effectiveStatus`.
 * Idempotent: re-applying it re-derives from `sourceState`, not from a previous
 * derivation.
 */
function applyGovernanceLifecycle(normalized, options = {}) {
  const sourceState = normalizeStatus(normalized?.sourceState ?? normalized?.state);
  const derived = deriveGovernanceStatus({
    sourceState,
    timing: normalized?.timing,
    endBlock: normalized?.endBlock,
    forVotes: normalized?.forVotes,
    againstVotes: normalized?.againstVotes,
    quorumVotes: normalized?.quorumVotes,
    finalizedBlock: options.finalizedBlock,
  });
  return {
    ...normalized,
    state: normalized?.state == null ? sourceState : normalized.state,
    sourceState,
    effectiveStatus: derived.effectiveStatus,
    trackingState: derived.trackingState,
    lifecycleReason: derived.reason,
    outcome: derived.effectiveStatus,
  };
}

module.exports = {
  TrackingState,
  FINAL_STATUSES,
  WARM_STATUSES,
  OPEN_STATUSES,
  normalizeStatus,
  trackingStateFor,
  isTerminalStatus,
  deriveGovernanceStatus,
  applyGovernanceLifecycle,
};
