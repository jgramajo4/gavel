const {
  MAX_EVIDENCE_URLS,
  NORMALIZED_LIFECYCLES,
  NOUNS_QUOTE_ISSUANCE_STAGES,
} = require('./constants');
const { NOUNS_DAO } = require('./enrollment');
const { submissionSchema } = require('./schema');
const { canonicalizeSubmission, hashSubmission } = require('./submission-hash');
const { validateDisclosureMarkdown, validatePitchMarkdown } = require('./markdown');

// The advocate supplies only content. Payer, voter, and signed sender come from
// the authenticated session and the routed Gate profile, never from the body.
const SUBMISSION_REQUEST_FIELDS = Object.freeze([
  'dao', 'proposalId', 'stage', 'position', 'pitch', 'disclosures', 'evidenceUrls',
]);

// Public rejection copy is deliberately coarse: it never echoes advocate text,
// private policy values, capacity, or any other operator-private detail.
const MALFORMED_MESSAGE = 'Submission content is invalid';
const NOT_ACCEPTING_MESSAGE = 'Not currently accepting new submissions';

class SubmissionPolicyError extends Error {
  constructor(state, code, statusCode, message) {
    super(message);
    this.name = 'SubmissionPolicyError';
    this.state = state;
    this.code = code;
    this.statusCode = statusCode;
  }

  toJSON() {
    return { state: this.state, code: this.code, statusCode: this.statusCode, message: this.message };
  }
}

function malformed() {
  return new SubmissionPolicyError('malformed', 'INVALID_SUBMISSION', 400, MALFORMED_MESSAGE);
}

function notAccepting() {
  return new SubmissionPolicyError('rejected_by_policy', 'NOT_ACCEPTING', 403, NOT_ACCEPTING_MESSAGE);
}

function validateSubmissionRequest(request, { payer, voter } = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw malformed();
  const names = Object.keys(request);
  if (names.length !== SUBMISSION_REQUEST_FIELDS.length
      || names.some((field) => !SUBMISSION_REQUEST_FIELDS.includes(field))) {
    throw malformed();
  }
  if (request.dao !== NOUNS_DAO) throw malformed();
  if (!NORMALIZED_LIFECYCLES.includes(request.stage)) throw malformed();
  if (!Array.isArray(request.evidenceUrls) || request.evidenceUrls.length > MAX_EVIDENCE_URLS) throw malformed();

  // Size and CommonMark AST validation runs before hashing so that disallowed
  // content never reaches persistence, deduplication, or any mutable check.
  try {
    validatePitchMarkdown(request.pitch);
    validateDisclosureMarkdown(request.disclosures);
  } catch {
    throw malformed();
  }

  let submission;
  try {
    submissionSchema.parse({
      payer, signedSender: payer, voter,
      dao: request.dao, proposalId: request.proposalId, stage: request.stage, position: request.position,
      pitch: request.pitch, disclosures: request.disclosures, evidenceUrls: request.evidenceUrls,
    });
    submission = canonicalizeSubmission({
      payer, signedSender: payer, voter,
      dao: request.dao, proposalId: request.proposalId, stage: request.stage, position: request.position,
      pitch: request.pitch, disclosures: request.disclosures, evidenceUrls: request.evidenceUrls,
    });
  } catch {
    throw malformed();
  }

  return { submission, submissionHash: hashSubmission(submission) };
}

// Stage support is a policy decision, not a parse error: an unsupported or
// unaccepted stage is coarsely rejected without confirming anything private.
function assertStageAccepted(stage, policy) {
  if (!NOUNS_QUOTE_ISSUANCE_STAGES.includes(stage)) throw notAccepting();
  if (!policy || policy.acceptPreVote !== false || policy.acceptVoting !== true) throw notAccepting();
  return stage;
}

module.exports = {
  MALFORMED_MESSAGE,
  NOT_ACCEPTING_MESSAGE,
  SUBMISSION_REQUEST_FIELDS,
  SubmissionPolicyError,
  assertStageAccepted,
  validateSubmissionRequest,
};
