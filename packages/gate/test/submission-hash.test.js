const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizeSubmission,
  serializeCanonicalSubmission,
  hashSubmission,
} = require('../src');

const PAYER = '0x00000000000000000000000000000000000000aa';
const VOTER = '0x00000000000000000000000000000000000000bb';

function submission(overrides = {}) {
  return {
    payer: PAYER,
    signedSender: PAYER,
    voter: VOTER,
    dao: 'nouns',
    proposalId: '123456789012345678901234567890',
    stage: 'VOTING',
    position: 'FOR',
    pitch: '  Keep exact spacing\n🙂  ',
    disclosures: 'line one\r\nline two',
    evidenceUrls: ['https://example.com/a', 'https://example.org/b'],
    ...overrides,
  };
}

test('canonicalizes addresses and hashes deterministically with keccak256', () => {
  const first = canonicalizeSubmission(submission());
  const second = canonicalizeSubmission(submission({ payer: PAYER.toUpperCase().replace('0X', '0x') }));

  assert.equal(first.payer, '0x00000000000000000000000000000000000000AA');
  assert.equal(first.pitch, '  Keep exact spacing\n🙂  ');
  assert.equal(first.disclosures, 'line one\r\nline two');
  assert.equal(hashSubmission(submission()), hashSubmission(submission()));
  assert.equal(hashSubmission(submission()), hashSubmission(second));
  assert.match(hashSubmission(submission()), /^0x[0-9a-f]{64}$/);
});

test('serializes exactly the immutable hash fields in canonical order', () => {
  const serialized = JSON.parse(serializeCanonicalSubmission(submission()));

  assert.equal(serialized.length, 10);
  assert.deepEqual(serialized, [
    'gavel-gate-submission-v1',
    '0x00000000000000000000000000000000000000AA',
    '0x00000000000000000000000000000000000000bb',
    'nouns',
    '123456789012345678901234567890',
    'VOTING',
    'FOR',
    '  Keep exact spacing\n🙂  ',
    'line one\r\nline two',
    ['https://example.com/a', 'https://example.org/b'],
  ]);
});

test('every immutable submission field changes the canonical hash', () => {
  const original = submission();
  const variants = [
    submission({ payer: '0x00000000000000000000000000000000000000cc', signedSender: '0x00000000000000000000000000000000000000cc' }),
    submission({ voter: '0x00000000000000000000000000000000000000cc' }),
    submission({ dao: 'nouns-v2' }),
    submission({ proposalId: '123456789012345678901234567891' }),
    submission({ stage: 'CLOSED' }),
    submission({ position: 'AGAINST' }),
    submission({ pitch: `${original.pitch} ` }),
    submission({ disclosures: `${original.disclosures}\n` }),
    submission({ evidenceUrls: [...original.evidenceUrls].reverse() }),
  ];

  for (const variant of variants) {
    assert.notEqual(hashSubmission(variant), hashSubmission(original));
  }
});

test('rejects payer and signed sender mismatch before hashing', () => {
  assert.throws(
    () => hashSubmission(submission({ signedSender: '0x00000000000000000000000000000000000000cc' })),
    /payer must equal signedSender/,
  );
});

test('rejects invalid addresses, unsafe proposal numbers, and invalid evidence', () => {
  assert.throws(() => hashSubmission(submission({ voter: 'not-an-address' })));
  assert.throws(() => hashSubmission(submission({ proposalId: Number.MAX_SAFE_INTEGER + 1 })));
  assert.throws(() => hashSubmission(submission({ evidenceUrls: ['http://example.com'] })));
});
