"use strict";

const { normalizedProposalSchema } = require("../schema/governance");
const { predictionDocumentSchema } = require("../schema/prediction");
const { normalizeStatus, FINAL_STATUSES, WARM_STATUSES, OPEN_STATUSES } = require("./lifecycle");
const { canonicalProposalIdentity, assertCanonicalProposalIdentity, assertProposalBinding } = require("@gavel/proposal-identity");

const AUTHORITATIVE_STATUSES = new Set([...FINAL_STATUSES, ...WARM_STATUSES, ...OPEN_STATUSES]);
const FORGED_FIELD = /^\s*(?:(?:#{1,6}|>|[-+*])\s+|(?:\*\*|__|`)?\s*)?(?:proposal(?:\s+id)?|status|recommendation)\s*(?::|#|[-–—])/iu;
const FORMAT_CONTROL = /\p{Cf}/u;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

class ProposalPresentationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProposalPresentationError";
    this.code = code;
  }
}

function fail(code, message) { throw new ProposalPresentationError(code, message); }

function inlineText(value, name) {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_PROPOSAL_PRESENTATION", `${name} is missing`);
  if (/[\r\n\u2028\u2029]/u.test(value) || FORMAT_CONTROL.test(value) || CONTROL.test(value)) {
    fail("INVALID_PROPOSAL_PRESENTATION", `${name} is not safe single-line text`);
  }
  return value
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()#!|])/g, "\\$1");
}

function canonicalEffectiveStatus(proposal) {
  if (typeof proposal.effectiveStatus !== "string") {
    fail("INVALID_PROPOSAL_STATUS", "A canonical effectiveStatus is required; raw state is not authoritative");
  }
  if (proposal.effectiveStatus !== normalizeStatus(proposal.effectiveStatus)
      || !AUTHORITATIVE_STATUSES.has(proposal.effectiveStatus)) {
    fail("INVALID_PROPOSAL_STATUS", "The canonical effectiveStatus is unsupported");
  }
  return proposal.effectiveStatus;
}

function explanatoryProse(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") fail("INVALID_EXPLANATION", "Explanation must be plain text");
  if (FORMAT_CONTROL.test(value) || CONTROL.test(value)) fail("INVALID_EXPLANATION", "Explanation contains unsafe format or control characters");
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  if (lines.some((line) => FORGED_FIELD.test(line))) {
    fail("FORGED_AUTHORITATIVE_METADATA", "Explanation may not introduce proposal, status, or recommendation fields");
  }
  const escaped = lines.map((line) => {
    if (!line) return ">";
    // Each line is a literal inline code span inside the explanation quote.
    // A delimiter longer than any run in the source keeps backticks literal;
    // Markdown block syntax, inline links, HTML and linkification are inert.
    const longest = Math.max(0, ...[...line.matchAll(/`+/g)].map(([run]) => run.length));
    const fence = "`".repeat(longest + 1);
    return `> ${fence} ${line} ${fence}`;
  });
  return escaped.join("\n");
}

function presentProposalResponse({ proposal: proposalInput, prediction: predictionInput, explanation = "" } = {}) {
  const proposal = normalizedProposalSchema.parse(proposalInput);
  const prediction = predictionDocumentSchema.parse(predictionInput);
  const proposalIdentity = canonicalProposalIdentity(proposalInput.identity, "proposal identity");
  const predictionIdentity = canonicalProposalIdentity(predictionInput.identity, "prediction identity");
  assertCanonicalProposalIdentity({
    dao: proposal.dao ?? proposalIdentity.dao,
    chainId: proposal.chainId ?? proposalIdentity.chainId,
    governorAddress: proposalIdentity.governorAddress,
    proposalId: proposal.id,
  }, proposalIdentity);
  assertCanonicalProposalIdentity({
    dao: prediction.dao,
    chainId: prediction.chainId,
    governorAddress: predictionIdentity.governorAddress,
    proposalId: prediction.proposalId,
  }, predictionIdentity);
  const binding = assertProposalBinding({
    proposalIdentity,
    proposalContentHash: proposal.contentHash,
    predictionIdentity,
    predictionContentHash: prediction.proposalContentHash,
  });
  const status = canonicalEffectiveStatus(proposal);
  const title = inlineText(proposal.title, "proposal title");
  const prose = explanatoryProse(explanation);
  const authoritativeMarkdown = [
    `**Proposal ${binding.identity.proposalId}: ${title}**`,
    `**Status:** ${status}`,
    `**Recommendation:** ${prediction.recommendation}`,
  ].join("\n");
  const markdown = prose ? `${authoritativeMarkdown}\n\n**Explanation**\n${prose}` : authoritativeMarkdown;
  return Object.freeze({
    identity: binding.identity,
    contentHash: binding.contentHash,
    status,
    recommendation: prediction.recommendation,
    authoritativeMarkdown,
    markdown,
  });
}

module.exports = {
  ProposalPresentationError,
  canonicalEffectiveStatus,
  explanatoryProse,
  presentProposalResponse,
};
