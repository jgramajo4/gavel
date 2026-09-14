const { getAddress, keccak256, toUtf8Bytes } = require('ethers');
const { submissionSchema } = require('./schema');

function canonicalizeSubmission(input) {
  const parsed = submissionSchema.parse(input);
  const payer = getAddress(parsed.payer);
  const signedSender = getAddress(parsed.signedSender);
  if (payer !== signedSender) {
    throw new TypeError('payer must equal signedSender in Gate MVP');
  }

  return Object.freeze({
    payer,
    signedSender,
    voter: getAddress(parsed.voter),
    dao: parsed.dao,
    proposalId: parsed.proposalId.toString(10),
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
    'gavel-gate-submission-v1',
    value.payer,
    value.voter,
    value.dao,
    value.proposalId,
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
  canonicalizeSubmission,
  serializeCanonicalSubmission,
  hashSubmission,
};