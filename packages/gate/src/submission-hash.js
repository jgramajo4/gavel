const { getAddress, keccak256, toUtf8Bytes } = require('ethers');
const { submissionSchema } = require('./schema');

const SUBMISSION_HASH_DOMAIN_TAG = 'gavel-gate-submission-v1';

function canonicalizeSubmission(input) {
  const parsed = submissionSchema.parse(input);
  const payer = getAddress(parsed.payer);
  const signedSender = getAddress(parsed.signedSender);
  if (payer !== signedSender) {
    throw new TypeError('payer must equal signedSender in Gate MVP');
  }

  const proposalId = parsed.proposalId?.toString(10)
    ?? (parsed.targetId?.startsWith('proposal:') ? parsed.targetId.slice('proposal:'.length) : undefined);
  const candidateTargetId = parsed.targetId?.startsWith('candidate:') ? parsed.targetId : undefined;
  return Object.freeze({
    payer,
    signedSender,
    voter: getAddress(parsed.voter),
    dao: parsed.dao,
    ...(candidateTargetId === undefined ? { proposalId } : { targetId: candidateTargetId }),
    stage: parsed.stage,
    position: parsed.position,
    pitch: parsed.pitch,
    disclosures: parsed.disclosures,
    evidenceUrls: Object.freeze([...parsed.evidenceUrls]),
  });
}

// Fixed-order JSON array framing is unambiguous: JSON escapes string content,
// array positions are versioned here, and no object-key ordering is involved.
function serializeCanonicalSubmission(input) {
  const value = canonicalizeSubmission(input);
  return JSON.stringify([
    SUBMISSION_HASH_DOMAIN_TAG,
    value.payer,
    value.voter,
    value.dao,
    value.proposalId ?? value.targetId,
    value.stage,
    value.position,
    value.pitch,
    value.disclosures,
    value.evidenceUrls,
  ]);
}

function hashSubmission(input) {
  return keccak256(toUtf8Bytes(serializeCanonicalSubmission(input)));
}

module.exports = {
  SUBMISSION_HASH_DOMAIN_TAG,
  canonicalizeSubmission,
  serializeCanonicalSubmission,
  hashSubmission,
};