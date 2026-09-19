"use strict";

const {
  MAX_DISCLOSURE_CODE_POINTS,
  MAX_EVIDENCE_URLS,
  MAX_PITCH_CODE_POINTS,
  validateDisclosureMarkdown,
  validatePitchMarkdown,
} = require("@gavel/gate");
const { BankrGateError } = require("./errors");
const { parseIssuedQuote } = require("./quote");

/**
 * Advocate content is UNTRUSTED DATA, start to finish.
 *
 * The pitch, the disclosures, and every evidence URL are validated for shape
 * and size, carried verbatim to Gate, and never acted upon. Specifically, an
 * evidence URL is never fetched, never unfurled, never previewed, never
 * summarized, and never treated as a tool, a redirect, or an instruction. There
 * is no HTTP client in this module and no code path that could add one.
 */
function validateEvidenceUrls(value) {
  if (!Array.isArray(value)) {
    throw new BankrGateError("INVALID_SUBMISSION", "Evidence URLs must be a list.");
  }
  if (value.length > MAX_EVIDENCE_URLS) {
    throw new BankrGateError("INVALID_SUBMISSION", `Gate accepts at most ${MAX_EVIDENCE_URLS} evidence URLs.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new BankrGateError("INVALID_SUBMISSION", "Each evidence URL must be a string.");
    }
    let parsed;
    try {
      parsed = new URL(entry);
    } catch {
      throw new BankrGateError("INVALID_SUBMISSION", "Each evidence URL must be an absolute HTTPS URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new BankrGateError("INVALID_SUBMISSION", "Each evidence URL must be an absolute HTTPS URL.");
    }
    // Returned verbatim: Gate hashes what the advocate wrote, not a rewrite.
    return entry;
  });
}

function codePoints(value) {
  return Array.from(String(value)).length;
}

/**
 * Builds the exact Gate submission body.
 *
 * Payer, voter, and signed sender are deliberately absent: Gate takes those
 * from the authenticated session and the routed profile, never from the body.
 * Target identity is whatever `targets.js` resolved from canonical data —
 * a candidate sends `targetId`, an active proposal sends `proposalId`.
 */
function buildSubmissionRequest({ target, pitch, disclosures, evidenceUrls = [] } = {}) {
  if (!target || typeof target !== "object") {
    throw new BankrGateError("INVALID_TARGET", "Resolve the governance target before composing a request.");
  }
  if (typeof pitch !== "string" || pitch.trim() === "") {
    throw new BankrGateError("INVALID_SUBMISSION", "Write the pitch you want this voter to read.");
  }
  if (typeof disclosures !== "string") {
    throw new BankrGateError("INVALID_SUBMISSION", "Disclosures must be text. Send an empty string if you have none.");
  }
  if (codePoints(pitch) > MAX_PITCH_CODE_POINTS) {
    throw new BankrGateError("INVALID_SUBMISSION", `The pitch must be at most ${MAX_PITCH_CODE_POINTS} characters.`);
  }
  if (codePoints(disclosures) > MAX_DISCLOSURE_CODE_POINTS) {
    throw new BankrGateError(
      "INVALID_SUBMISSION",
      `Disclosures must be at most ${MAX_DISCLOSURE_CODE_POINTS} characters.`,
    );
  }
  try {
    validatePitchMarkdown(pitch);
    validateDisclosureMarkdown(disclosures);
  } catch (cause) {
    throw new BankrGateError(
      "INVALID_SUBMISSION",
      "Gate does not accept this Markdown. Use plain paragraphs, lists, and emphasis.",
      { cause },
    );
  }
  return Object.freeze({
    dao: "nouns",
    ...target.submissionTarget,
    stage: target.stage,
    position: target.position,
    pitch,
    disclosures,
    evidenceUrls: Object.freeze(validateEvidenceUrls(evidenceUrls)),
  });
}

function receiptFrom(body, { resumed = false } = {}) {
  return Object.freeze({
    publicId: body.publicId,
    state: body.state,
    resumed,
    ...(body.updatedAt === undefined ? {} : { updatedAt: body.updatedAt }),
    ...(body.acceptedAt === undefined ? {} : { acceptedAt: body.acceptedAt }),
    quote: body.quote ? parseIssuedQuote(body.quote) : null,
  });
}

/**
 * Creates exactly ONE Gate submission, and resumes rather than duplicating.
 *
 * Two rules are enforced here:
 *
 *  1. A 409 `duplicate` is followed to its resume URL. The ORIGINAL quote comes
 *     back; no second quote is ever requested.
 *  2. A lost HTTP response is never a reason to create a new quote. On a
 *     transport failure the byte-identical body is re-sent — same content, same
 *     canonical submission hash — so Gate's owner-bound hash lookup either
 *     issues the one quote it was always going to issue, or hands back the one
 *     it already issued. The body is frozen at build time and is never
 *     regenerated, re-worded, or re-timestamped on a retry.
 */
async function createOrResumeSubmission({ gateApi, token, voterWallet, request, attempts = 2 } = {}) {
  if (!request || typeof request !== "object") {
    throw new BankrGateError("INVALID_SUBMISSION", "Build the submission request first.");
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new BankrGateError("INVALID_CONFIG", "attempts must be a positive integer.");
  }
  let body;
  let lastTransportError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      body = await gateApi.createSubmission(token, voterWallet, request);
      lastTransportError = undefined;
      break;
    } catch (error) {
      if (error instanceof BankrGateError && error.code === "TRANSPORT_FAILED") {
        lastTransportError = error;
        continue;
      }
      throw error;
    }
  }
  if (lastTransportError) {
    throw new BankrGateError(
      "SUBMISSION_RESULT_UNKNOWN",
      "Gate did not answer. The request may already exist. Re-send this exact request to recover it; do not change it.",
      { cause: lastTransportError },
    );
  }
  if (!body || typeof body !== "object") {
    throw new BankrGateError("INVALID_QUOTE", "Gate returned an unreadable submission response.");
  }

  if (body.state === "duplicate") {
    const existing = body.existing || {};
    const resumed = await gateApi.resumeSubmission(token, existing.resumeUrl);
    if (!resumed) {
      throw new BankrGateError(
        "DUPLICATE_UNRESUMABLE",
        "Gate already holds this exact request but would not return it to this payer.",
        { state: "duplicate" },
      );
    }
    return receiptFrom(resumed, { resumed: true });
  }
  return receiptFrom(body, { resumed: false });
}

module.exports = { buildSubmissionRequest, createOrResumeSubmission, validateEvidenceUrls };
