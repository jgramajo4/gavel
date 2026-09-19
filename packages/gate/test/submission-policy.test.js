const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SUBMISSION_REQUEST_FIELDS,
  SubmissionPolicyError,
  assertStageAccepted,
  hashSubmission,
  validateSubmissionRequest,
} = require('../src');

const PAYER = '0x3333333333333333333333333333333333333333';
const VOTER = '0x1111111111111111111111111111111111111111';

function request(overrides = {}) {
  return {
    dao: 'nouns',
    proposalId: '42',
    stage: 'VOTING',
    position: 'FOR',
    pitch: '# Fund it\n\nThe treasury **can** afford this.',
    disclosures: 'I hold no position.',
    evidenceUrls: ['https://example.com/a'],
    ...overrides,
  };
}

function reject(input, identity = { payer: PAYER, voter: VOTER }) {
  try {
    validateSubmissionRequest(input, identity);
  } catch (error) {
    return error;
  }
  return null;
}

test('a well-formed request canonicalizes to the frozen immutable material and shared hash', () => {
  const result = validateSubmissionRequest(request(), { payer: PAYER, voter: VOTER });

  assert.deepEqual(Object.keys(result).sort(), ['submission', 'submissionHash']);
  assert.equal(result.submission.payer, result.submission.signedSender);
  assert.equal(result.submission.dao, 'nouns');
  assert.equal(result.submission.proposalId, '42');
  assert.equal(result.submission.stage, 'VOTING');
  assert.deepEqual(result.submission.evidenceUrls, ['https://example.com/a']);
  assert.equal(result.submissionHash, hashSubmission({
    payer: PAYER, signedSender: PAYER, voter: VOTER, dao: 'nouns', proposalId: '42',
    stage: 'VOTING', position: 'FOR', pitch: request().pitch, disclosures: request().disclosures,
    evidenceUrls: ['https://example.com/a'],
  }));
});

test('the immutable pitch is preserved byte-exactly rather than normalized', () => {
  const pitch = '  leading and trailing   \n\nsecond  line\r\n';
  const result = validateSubmissionRequest(request({ pitch }), { payer: PAYER, voter: VOTER });
  assert.equal(result.submission.pitch, pitch);
});

test('every parse, size, Markdown, and evidence violation is coarsely malformed', () => {
  const cases = [
    ['unknown field', request({ nickname: 'x' })],
    ['missing field', (() => { const value = request(); delete value.pitch; return value; })()],
    ['unsupported dao', request({ dao: 'ens' })],
    ['unknown stage', request({ stage: 'SETTLED' })],
    ['non-decimal proposal', request({ proposalId: '0x2a' })],
    ['empty position', request({ position: '' })],
    ['oversize pitch', request({ pitch: 'a'.repeat(4001) })],
    ['oversize disclosures', request({ disclosures: 'b'.repeat(2001) })],
    ['raw HTML pitch', request({ pitch: 'vote <script>alert(1)</script>' })],
    ['image pitch', request({ pitch: '![x](https://example.com/x.png)' })],
    ['http link pitch', request({ pitch: '[x](http://example.com)' })],
    ['javascript link pitch', request({ pitch: '[x](javascript:alert(1))' })],
    ['mermaid pitch', request({ pitch: '```mermaid\ngraph TD;\n```' })],
    ['http evidence', request({ evidenceUrls: ['http://example.com'] })],
    ['relative evidence', request({ evidenceUrls: ['/local'] })],
    ['six evidence URLs', request({ evidenceUrls: Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`) })],
    ['evidence not an array', request({ evidenceUrls: 'https://example.com' })],
  ];

  for (const [label, value] of cases) {
    const error = reject(value);
    assert.ok(error instanceof SubmissionPolicyError, `${label} must raise SubmissionPolicyError`);
    assert.equal(error.state, 'malformed', label);
    assert.equal(error.code, 'INVALID_SUBMISSION', label);
    assert.equal(error.statusCode, 400, label);
  }
});

test('the request never carries its own payer, voter, or signer identity', () => {
  assert.deepEqual([...SUBMISSION_REQUEST_FIELDS].sort(),
    ['dao', 'disclosures', 'evidenceUrls', 'pitch', 'position', 'proposalId', 'stage', 'targetId']);
  for (const field of ['payer', 'voter', 'signedSender', 'submissionHash', 'quoteId']) {
    assert.equal(reject(request({ [field]: PAYER })).state, 'malformed', field);
  }
});

test('an unsupported or unaccepted stage is a coarse policy rejection, never malformed', () => {
  assert.equal(assertStageAccepted('VOTING', { acceptVoting: true, acceptPreVote: false }), 'VOTING');

  for (const value of [
    ['PRE_VOTE', { acceptVoting: true, acceptPreVote: false }],
    ['CLOSED', { acceptVoting: true, acceptPreVote: false }],
    ['VOTING', { acceptVoting: false, acceptPreVote: false }],
  ]) {
    const error = reject(null) && null;
    assert.equal(error, null);
    assert.throws(() => assertStageAccepted(value[0], value[1]), (thrown) => {
      assert.ok(thrown instanceof SubmissionPolicyError);
      assert.equal(thrown.state, 'rejected_by_policy');
      assert.equal(thrown.code, 'NOT_ACCEPTING');
      assert.equal(thrown.statusCode, 403);
      return true;
    }, `${value[0]} must be rejected by policy`);
  }
});

test('rejections never echo the advocate text or private policy detail', () => {
  const secret = 'SECRET-PITCH-MARKER <img src=x>';
  const error = reject(request({ pitch: secret }));
  const serialized = `${error.message} ${JSON.stringify(error)} ${error.stack}`;
  assert.equal(serialized.includes('SECRET-PITCH-MARKER'), false);
  assert.equal(error.message, 'Submission content is invalid');
});
