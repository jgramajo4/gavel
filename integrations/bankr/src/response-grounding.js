"use strict";

const { BankrGateError } = require("./errors");
const { sanitizeDisplayText } = require("./format");

const DECIMAL_ID = /^(0|[1-9][0-9]*)$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;
const RECOMMENDATIONS = new Set(["FOR", "AGAINST", "ABSTAIN"]);

function invalid(message) {
  throw new BankrGateError("INVALID_PROPOSAL_RESPONSE_INPUT", message);
}

function stringField(value, name) {
  if (typeof value !== "string" || !value.trim()) invalid(`The structured proposal ${name} is missing.`);
  return value;
}

function markdownInline(value, name) {
  const sanitized = sanitizeDisplayText(value);
  if (/[\r\n\u2028\u2029]/u.test(sanitized)) {
    invalid(`The structured proposal ${name} must be a single line.`);
  }
  return sanitized.replace(/([\\`*_[\]{}()<>#+\-.!|])/g, "\\$1");
}

/**
 * Creates the identity-critical prefix for a Bankr proposal-analysis response.
 *
 * The host model may explain the already-computed evidence after this prefix,
 * but must not reconstruct or restate proposal identity, title, status, or the
 * recommendation. Those fields come only from the matching structured artifacts.
 */
function renderProposalGrounding({ proposal, prediction } = {}) {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    invalid("The structured proposal is missing.");
  }
  if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) {
    invalid("The structured prediction is missing.");
  }

  const proposalId = stringField(proposal.id, "ID");
  if (!DECIMAL_ID.test(proposalId)) invalid("The structured proposal ID is not canonical.");
  const title = stringField(proposal.title, "title");
  const contentHash = stringField(proposal.contentHash, "content hash");
  if (!CONTENT_HASH.test(contentHash)) invalid("The structured proposal content hash is not canonical.");
  const status = [proposal.effectiveStatus, proposal.outcome, proposal.state]
    .find((value) => typeof value === "string" && value.trim());
  if (!status) invalid("The structured proposal status is missing.");
  if (!RECOMMENDATIONS.has(prediction.recommendation)) {
    invalid("The structured recommendation is missing or unsupported.");
  }

  if (prediction.proposalId !== proposalId || prediction.proposalContentHash !== contentHash) {
    throw new BankrGateError(
      "PROPOSAL_RESPONSE_GROUNDING_MISMATCH",
      "The prediction does not match the structured proposal being presented.",
    );
  }

  const safeTitle = markdownInline(title, "title");
  const safeStatus = markdownInline(status, "status");
  const identity = Object.freeze({ proposalId, title, status, contentHash });
  const recommendation = prediction.recommendation;
  const markdown = [
    `**Proposal ${proposalId}: ${safeTitle}**`,
    `**Status:** ${safeStatus}`,
    `**Recommendation:** ${recommendation}`,
  ].join("\n");

  return Object.freeze({
    identity,
    recommendation,
    markdown,
    explanation: Object.freeze({
      confidencePercent: prediction.confidencePercent,
      confidenceCalibrated: prediction.confidenceCalibrated,
      confidenceKind: prediction.confidenceKind,
      policySource: prediction.policySource,
      reasoning: Object.freeze([...(Array.isArray(prediction.reasoning) ? prediction.reasoning : [])]),
      flags: Object.freeze([...(Array.isArray(prediction.flags) ? prediction.flags : [])]),
      precedents: Object.freeze([...(Array.isArray(prediction.precedents) ? prediction.precedents : [])]),
      draftReason: prediction.draftReason || null,
      security: prediction.security || null,
    }),
  });
}

module.exports = { renderProposalGrounding };
