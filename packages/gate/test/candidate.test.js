const assert = require('node:assert/strict');
const test = require('node:test');
const { keccak256, toUtf8Bytes } = require('ethers');
const {
  NOUNS_CANDIDATE_MAPPING_VERSION,
  candidateTargetId,
  adaptNounsCandidateLifecycle,
} = require('../src');

const PROPOSER = '0x1111111111111111111111111111111111111111';

test('candidate identity binds lowercase proposer and keccak256 UTF-8 slug', () => {
  assert.equal(
    candidateTargetId(PROPOSER.toUpperCase().replace('0X', '0x'), 'Fund public goods 🚀'),
    `candidate:${PROPOSER}:${keccak256(toUtf8Bytes('Fund public goods 🚀')).toLowerCase()}`,
  );
  assert.throws(() => candidateTargetId('not-an-address', 'slug'));
  assert.equal(candidateTargetId(PROPOSER, ''), `candidate:${PROPOSER}:${keccak256(toUtf8Bytes(''))}`);
  assert.throws(() => candidateTargetId(PROPOSER, null));
});

test('candidate lifecycle exposes only live original candidates as PRE_VOTE', () => {
  const live = { latestVersionValid: true, canceled: false, proposalIdToUpdate: '0', matchingProposalIds: [] };
  assert.deepEqual(adaptNounsCandidateLifecycle(live), {
    eligibility: 'PRE_VOTE', mappingVersion: NOUNS_CANDIDATE_MAPPING_VERSION,
  });
  for (const candidate of [
    { ...live, latestVersionValid: false },
    { ...live, canceled: true },
    { ...live, proposalIdToUpdate: '1' },
    { ...live, matchingProposalIds: ['42'] },
  ]) assert.equal(adaptNounsCandidateLifecycle(candidate).eligibility, 'CLOSED');
  assert.throws(() => adaptNounsCandidateLifecycle({ ...live, canceled: 'false' }), /malformed/i);
});

test('signature expiry alone does not close a candidate', () => {
  assert.equal(adaptNounsCandidateLifecycle({
    latestVersionValid: true, canceled: false, proposalIdToUpdate: '0', matchingProposalIds: [],
    latestSignatureExpirationTimestamp: '1',
  }).eligibility, 'PRE_VOTE');
});
