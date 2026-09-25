"use strict";

const { candidateTargetId, parseNounsCandidateTargetId } = require("@gavel/gate");
const { BankrGateError } = require("./errors");
const { sanitizeDisplayText, truncateDisplay } = require("./format");

const CANDIDATE_POSITION = "SPONSOR";
const NOUNS_CHAIN_ID = 1;
const NOUNS_GOVERNOR_ADDRESS = "0x6f3e6272a167e8accb32072d08e0957f9c79223d";

/**
 * Stage language.
 *
 * A Proposal Candidate is SEEKING SPONSORSHIP. No on-chain vote is open on it,
 * so every string here avoids "vote", "voting", and "ballot". An active
 * proposal is the only thing this integration ever calls VOTING.
 */
const STAGE_LANGUAGE = Object.freeze({
  PRE_VOTE: Object.freeze({
    stage: "PRE_VOTE",
    ask: "Sponsor",
    headline: "Seeking sponsorship",
    attentionNoun: "sponsorship attention",
    summary: "This is a Nouns Proposal Candidate seeking sponsorship. It is PRE_VOTE: no on-chain vote is open.",
  }),
  VOTING: Object.freeze({
    stage: "VOTING",
    ask: "Vote",
    headline: "Active proposal",
    attentionNoun: "voting attention",
    summary: "This is an active Nouns proposal in VOTING.",
  }),
});

function stageLanguage(stage) {
  const language = STAGE_LANGUAGE[stage];
  if (!language) throw new BankrGateError("INVALID_TARGET", "Gate does not issue quotes for that stage.");
  return language;
}

function ineligible(message) {
  return new BankrGateError("TARGET_NOT_ELIGIBLE", message);
}

/** Builds the canonical candidate target id from a proposer address and slug. */
function buildCandidateTargetId(proposer, slug) {
  try {
    return candidateTargetId(proposer, slug);
  } catch (cause) {
    throw new BankrGateError("INVALID_TARGET", "That proposer and slug do not form a Nouns candidate id.", { cause });
  }
}

/**
 * Turns one canonical index row into a Gate target descriptor.
 *
 * Candidates map to PRE_VOTE/SPONSOR and NEVER to VOTING. Active proposals map
 * to VOTING. Nothing is inferred when the index says otherwise: an ineligible
 * or unknown row is refused rather than reshaped into a payable target.
 */
function describeTarget(row, { position } = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw ineligible("The canonical index has no such Nouns target.");
  }
  if (row.kind === "candidate") {
    let identity;
    try {
      identity = parseNounsCandidateTargetId(row.targetId);
    } catch {
      throw ineligible("This candidate's canonical identity is unreadable.");
    }
    if (row.nativeState !== "ACTIVE" || row.eligibility !== "PRE_VOTE") {
      throw ineligible("This Proposal Candidate is no longer eligible for sponsorship requests.");
    }
    if (position !== undefined && position !== CANDIDATE_POSITION) {
      throw new BankrGateError(
        "INVALID_TARGET",
        "A Proposal Candidate can only be advocated with the SPONSOR position.",
      );
    }
    const language = stageLanguage("PRE_VOTE");
    return Object.freeze({
      kind: "candidate",
      targetId: row.targetId,
      proposer: identity.proposer,
      slug: sanitizeDisplayText(row.slug),
      title: truncateDisplay(row.title || row.slug || row.targetId),
      stage: "PRE_VOTE",
      position: CANDIDATE_POSITION,
      nativeState: row.nativeState,
      eligibility: row.eligibility,
      mappingVersion: row.mappingVersion,
      language,
      canonical: Object.freeze({
        contentHash: row.contentHash,
        sourceBlock: row.sourceBlock,
        sourceBlockHash: row.sourceBlockHash,
        refreshedAt: row.refreshedAt,
        actionCount: Array.isArray(row.actions) ? row.actions.length : 0,
      }),
      /** The exact target identity fields a Gate submission body carries. */
      submissionTarget: Object.freeze({ targetId: row.targetId }),
    });
  }

  const proposalId = String(row.proposalId ?? "");
  if (!/^(0|[1-9][0-9]*)$/.test(proposalId)) {
    throw ineligible("The canonical index has no such Nouns proposal.");
  }
  if (row.effectiveStatus !== "ACTIVE") {
    throw ineligible("This Nouns proposal is not in an open voting window.");
  }
  const trimmed = typeof position === "string" ? position.trim() : "";
  if (!trimmed) {
    throw new BankrGateError("INVALID_TARGET", "State the position you are advocating for on this proposal.");
  }
  const language = stageLanguage("VOTING");
  return Object.freeze({
    kind: "proposal",
    targetId: `proposal:${proposalId}`,
    proposalId,
    title: truncateDisplay(row.title || `Nouns proposal ${proposalId}`),
    stage: "VOTING",
    position: trimmed,
    nativeState: row.effectiveStatus,
    eligibility: "VOTING",
    language,
    canonical: Object.freeze({
      contentHash: row.contentHash,
      sourceBlock: row.sourceBlock,
      sourceBlockHash: row.sourceBlockHash,
      refreshedAt: row.refreshedAt,
      actionCount: Array.isArray(row.actions) ? row.actions.length : 0,
    }),
    submissionTarget: Object.freeze({ proposalId }),
  });
}

/**
 * Resolves a real governance target through the canonical index.
 *
 * Accepts a canonical `targetId`, a `proposer` + `slug` pair for a candidate, or
 * a `proposalId`. Nothing resolves from a title or a URL: this integration does
 * not guess which candidate an advocate means, and it never fetches a link.
 */
async function resolveTarget(indexApi, input = {}) {
  const { targetId, proposer, slug, proposalId, position } = input;
  let id = targetId;
  if (!id && proposer !== undefined && slug !== undefined) id = buildCandidateTargetId(proposer, slug);
  if (!id && proposalId !== undefined) id = `proposal:${String(proposalId)}`;
  if (typeof id !== "string" || !id) {
    throw new BankrGateError(
      "INVALID_TARGET",
      "Name the Nouns candidate (proposer and slug, or its canonical target id) or the proposal id.",
    );
  }
  const row = id.startsWith("candidate:")
    ? await indexApi.getTarget(id)
    : await indexApi.getProposal(id.slice("proposal:".length));
  if (!row) throw ineligible("The canonical index has no such Nouns target.");
  if (id.startsWith("candidate:") && row.targetId !== id) {
    throw ineligible("The canonical index returned a different target than the one requested.");
  }
  if (id.startsWith("proposal:") && (
    typeof row.proposalId !== "string"
    || row.proposalId !== id.slice("proposal:".length)
    || typeof row.chainId !== "number"
    || row.chainId !== NOUNS_CHAIN_ID
    || typeof row.governorAddress !== "string"
    || !/^0x[0-9a-fA-F]{40}$/.test(row.governorAddress)
    || row.governorAddress.toLowerCase() !== NOUNS_GOVERNOR_ADDRESS
  )) {
    throw new BankrGateError(
      "PROPOSAL_IDENTITY_MISMATCH",
      "The canonical index returned a different proposal than the one requested.",
    );
  }
  return describeTarget(row, { position });
}

module.exports = {
  CANDIDATE_POSITION,
  STAGE_LANGUAGE,
  buildCandidateTargetId,
  describeTarget,
  resolveTarget,
  stageLanguage,
};
