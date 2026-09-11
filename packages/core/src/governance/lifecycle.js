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

const FINAL_STATUSES = Object.freeze(new Set([
  "DEFEATED", "EXECUTED", "CANCELLED", "VETOED", "EXPIRED", "SPONSORSHIP_EXPIRED",
]));
const WARM_STATUSES = Object.freeze(new Set(["SUCCEEDED", "QUEUED"]));
const OPEN_STATUSES = Object.freeze(new Set([
  "UPDATABLE", "PENDING", "ACTIVE", "OBJECTION_PERIOD",
]));

const STATUS_ALIASES = Object.freeze({
  CANCELED: "CANCELLED",
  OBJECTIONPERIOD: "OBJECTION_PERIOD",
  SPONSORSHIPEXPIRED: "SPONSORSHIP_EXPIRED",
  VETOD: "VETOED",
});

function normalizeStatus(value) {
  const raw = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!raw) return "UNKNOWN";
  return STATUS_ALIASES[raw] || STATUS_ALIASES[raw.replace(/_/g, "")] || raw;
}

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

function deriveGovernanceStatus(input = {}) {
  const sourceState = normalizeStatus(input.sourceState ?? input.state);
  if (sourceState === "UNKNOWN") return verdict(sourceState, "source_state_unknown");
  if (FINAL_STATUSES.has(sourceState)) return verdict(sourceState, "source_state_terminal");
  if (!OPEN_STATUSES.has(sourceState)) return verdict(sourceState, "source_state_post_vote");
  if (input.timing != null && input.timing !== "block") return verdict(sourceState, "timing_not_block");

  const endBlock = toBigInt(input.endBlock);
  const finalizedBlock = toBigInt(input.finalizedBlock);
  if (endBlock == null || endBlock === 0n || finalizedBlock == null) return verdict(sourceState, "voting_window_unknown");
  if (finalizedBlock <= endBlock) return verdict(sourceState, "voting_open");

  const forVotes = toBigInt(input.forVotes);
  const againstVotes = toBigInt(input.againstVotes);
  const quorumVotes = toBigInt(input.quorumVotes);
  if (forVotes == null || againstVotes == null || quorumVotes == null) {
    return verdict(sourceState, "tallies_unavailable");
  }
  const passed = forVotes > againstVotes && forVotes >= quorumVotes;
  return passed
    ? verdict("SUCCEEDED", "voting_finalized_quorum_met")
    : verdict("DEFEATED", "voting_finalized_defeated");
}

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

function firstPresent(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return undefined;
}

function knownStatus(value) {
  const text = firstPresent(value);
  return !text || text === "UNKNOWN" ? undefined : text;
}

/**
 * Merge canonical persisted lifecycle columns onto a stored `normalized` blob.
 *
 * Migration 003 backfilled `effective_status` / `tracking_state` without
 * rewriting historical JSON. Reads must not treat that blob as authoritative
 * for those fields. `state` stays the raw upstream value.
 *
 * Store defaults (UNKNOWN / HOT) are not copied onto documents that never had
 * a lifecycle verdict. A migrated Nouns 992 has a real DEFEATED/FINAL pair and
 * is overlaid; a title-only placeholder stays a title-only placeholder.
 */
function presentProposal(normalized, persisted = {}) {
  if (!normalized && !persisted) return null;
  const doc = normalized && typeof normalized === "object" ? { ...normalized } : {};
  const sourceState = firstPresent(
    knownStatus(persisted.sourceState),
    knownStatus(persisted.proposalStatus),
    doc.sourceState,
    doc.state,
  );
  const outcome = firstPresent(knownStatus(persisted.outcome), doc.outcome);
  const effectiveStatus = firstPresent(knownStatus(doc.effectiveStatus), knownStatus(persisted.effectiveStatus), outcome);
  const trackingState = firstPresent(
    doc.trackingState,
    effectiveStatus ? persisted.trackingState : undefined,
  );
  const lifecycleReason = firstPresent(persisted.lifecycleReason, doc.lifecycleReason);
  const state = firstPresent(doc.state, knownStatus(persisted.proposalStatus), sourceState);
  return {
    ...doc,
    ...(state ? { state } : {}),
    ...(sourceState ? { sourceState } : {}),
    ...(outcome ? { outcome } : {}),
    ...(effectiveStatus ? { effectiveStatus } : {}),
    ...(trackingState ? { trackingState } : {}),
    ...(lifecycleReason ? { lifecycleReason } : {}),
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
  presentProposal,
};
