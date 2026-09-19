const test = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../src');

const PAYER = '0x3333333333333333333333333333333333333333';
const VOTER = '0x1111111111111111111111111111111111111111';
const TARGET = `candidate:0x${'aa'.repeat(20)}:0x${'bb'.repeat(32)}`;
const NOW = 1_800_000_000n;
const CONFIG = {
  daoChainId: 1n,
  daoVerifier: '0x00000000000000000000000000000000000000da',
  maxLifetime: 600n,
};

function enrollment(overrides = {}) {
  return {
    wallet: VOTER,
    purpose: 'enrollment',
    availability: 'accepting_now',
    dao: 'nouns',
    daoChainId: '1',
    acceptPreVote: true,
    acceptVoting: false,
    attentionAmount: '1000000',
    nonce: `0x${'11'.repeat(32)}`,
    issuedAt: NOW.toString(),
    expiry: (NOW + 600n).toString(),
    version: '1',
    ...overrides,
  };
}

function candidateSubmission(overrides = {}) {
  return {
    payer: PAYER,
    signedSender: PAYER,
    voter: VOTER,
    dao: 'nouns',
    targetId: TARGET,
    stage: 'PRE_VOTE',
    position: 'SPONSOR',
    pitch: 'Please sponsor this candidate.',
    disclosures: 'None.',
    evidenceUrls: [],
    ...overrides,
  };
}

test('Nouns enrollment accepts PRE_VOTE and/or VOTING but never neither', () => {
  assert.doesNotThrow(() => gate.validateGateEnrollment(enrollment(), CONFIG, NOW));
  assert.doesNotThrow(() => gate.validateGateEnrollment(enrollment({ acceptVoting: true }), CONFIG, NOW));
  assert.doesNotThrow(() => gate.validateGateEnrollment(enrollment({ acceptPreVote: false, acceptVoting: true }), CONFIG, NOW));
  assert.throws(() => gate.validateGateEnrollment(enrollment({ acceptPreVote: false, acceptVoting: false }), CONFIG, NOW), /stage|accept/i);
});

test('Nouns policy accepts either or both supported stages with deterministic serialization', () => {
  const base = {
    dao: 'nouns', daoChainId: 1, enabled: true, availability: 'accepting_now',
    attentionAmount: '1000000', acceptedStages: ['PRE_VOTE'],
  };
  assert.deepEqual(gate.serializeDaoPolicy(base).acceptedStages, ['PRE_VOTE']);
  assert.deepEqual(gate.serializeDaoPolicy({ ...base, acceptedStages: ['PRE_VOTE', 'VOTING'] }).acceptedStages,
    ['PRE_VOTE', 'VOTING']);
  assert.throws(() => gate.validateDaoPolicy({ ...base, acceptedStages: [] }));
  assert.throws(() => gate.validateDaoPolicy({ ...base, acceptedStages: ['CLOSED'] }));
});

test('candidate submissions bind the exact target identity without a numeric proposalId', () => {
  const canonical = gate.canonicalizeSubmission(candidateSubmission());
  assert.equal(canonical.targetId, TARGET);
  assert.equal(Object.hasOwn(canonical, 'proposalId'), false);
  const serialized = JSON.parse(gate.serializeCanonicalSubmission(candidateSubmission()));
  assert.equal(serialized[4], TARGET);
  assert.notEqual(gate.hashSubmission(candidateSubmission()), gate.hashSubmission(candidateSubmission({
    targetId: `${TARGET.slice(0, -1)}c`,
  })));
});

test('legacy proposal submissions keep their existing canonical hash', () => {
  const legacy = { ...candidateSubmission(), proposalId: '42', stage: 'VOTING', position: 'FOR' };
  delete legacy.targetId;
  const targetForm = { ...legacy, targetId: 'proposal:42' };
  delete targetForm.proposalId;
  assert.equal(gate.hashSubmission(legacy), gate.hashSubmission(targetForm));
  assert.equal(gate.canonicalizeSubmission(targetForm).proposalId, '42');
});

test('candidate request shape uses targetId and PRE_VOTE policy must be explicitly accepted', () => {
  const request = {
    dao: 'nouns', targetId: TARGET, stage: 'PRE_VOTE', position: 'SPONSOR',
    pitch: 'Please sponsor it.', disclosures: 'None.', evidenceUrls: [],
  };
  const validated = gate.validateSubmissionRequest(request, { payer: PAYER, voter: VOTER });
  assert.equal(validated.submission.targetId, TARGET);
  assert.equal(gate.assertStageAccepted('PRE_VOTE', { acceptPreVote: true, acceptVoting: false }), 'PRE_VOTE');
  assert.throws(() => gate.assertStageAccepted('PRE_VOTE', { acceptPreVote: false, acceptVoting: true }));
  assert.throws(() => gate.validateSubmissionRequest({ ...request, proposalId: '42' }, { payer: PAYER, voter: VOTER }));
  for (const position of ['FOR', 'AGAINST', 'CAST_VOTE', '0xdeadbeef']) {
    assert.throws(() => gate.validateSubmissionRequest({ ...request, position }, { payer: PAYER, voter: VOTER }));
  }
});
