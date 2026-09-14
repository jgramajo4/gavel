const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AVAILABILITY,
  NORMALIZED_LIFECYCLES,
  NOUNS_QUOTE_ISSUANCE_STAGES,
  PUBLIC_RECEIPT_STATES,
  MIN_ATTENTION_AMOUNT,
  GAVEL_FEE_AMOUNT,
  QUOTE_VERSION,
  QUOTE_LIFETIME_SECONDS,
  MAX_PITCH_CODE_POINTS,
  MAX_DISCLOSURE_CODE_POINTS,
  MAX_EVIDENCE_URLS,
  validateDaoPolicy,
  serializeDaoPolicy,
} = require('../src');

test('exports the frozen Gate vocabulary and numeric constants', () => {
  assert.deepEqual(AVAILABILITY, ['accepting_now', 'paused', 'closed']);
  assert.deepEqual(NORMALIZED_LIFECYCLES, ['PRE_VOTE', 'VOTING', 'CLOSED']);
  assert.deepEqual(PUBLIC_RECEIPT_STATES, [
    'payment_required',
    'pending_settlement',
    'accepted',
    'rejected_by_policy',
    'duplicate',
    'malformed',
    'expired',
  ]);
  assert.equal(MIN_ATTENTION_AMOUNT, 1_000_000n);
  assert.equal(GAVEL_FEE_AMOUNT, 250_000n);
  assert.equal(QUOTE_VERSION, 1);
  assert.equal(QUOTE_LIFETIME_SECONDS, 600);
  assert.equal(MAX_PITCH_CODE_POINTS, 4000);
  assert.equal(MAX_DISCLOSURE_CODE_POINTS, 2000);
  assert.equal(MAX_EVIDENCE_URLS, 5);
});

test('validates a supported Nouns VOTING policy without integer loss', () => {
  const amount = '90071992547409931234567890';
  const policy = validateDaoPolicy({
    dao: 'nouns',
    daoChainId: 1,
    enabled: true,
    availability: 'accepting_now',
    attentionAmount: amount,
    acceptedStages: ['VOTING'],
  }, ['VOTING']);

  assert.equal(policy.attentionAmount, BigInt(amount));
  assert.equal(serializeDaoPolicy(policy).attentionAmount, amount);
});

test('quote-issuance policy boundary rejects unsupported Nouns PRE_VOTE', () => {
  assert.ok(NORMALIZED_LIFECYCLES.includes('PRE_VOTE'));
  assert.deepEqual(NOUNS_QUOTE_ISSUANCE_STAGES, ['VOTING']);
  assert.equal(Object.isFrozen(NOUNS_QUOTE_ISSUANCE_STAGES), true);
  assert.throws(() => validateDaoPolicy({
    dao: 'nouns',
    daoChainId: 1,
    enabled: true,
    availability: 'accepting_now',
    attentionAmount: '1000000',
    acceptedStages: ['PRE_VOTE'],
  }), /VOTING|acceptedStages/);
});

test('validates policy again and emits only deterministic material during serialization', () => {
  const base = {
    dao: 'nouns',
    daoChainId: 1,
    enabled: true,
    availability: 'accepting_now',
    attentionAmount: '90071992547409931234567890',
    acceptedStages: ['VOTING'],
  };
  const validated = validateDaoPolicy(base);

  for (const mutation of [
    (policy) => { policy.dao = 'forged'; },
    (policy) => { policy.daoChainId = 8453; },
    (policy) => { policy.enabled = 'true'; },
    (policy) => { policy.acceptedStages = ['PRE_VOTE']; },
    (policy) => { policy.extra = 'forged'; },
  ]) {
    const policy = structuredClone(validated);
    mutation(policy);
    assert.throws(() => serializeDaoPolicy(policy));
  }

  assert.deepEqual(serializeDaoPolicy(base), {
    dao: 'nouns',
    daoChainId: 1,
    enabled: true,
    availability: 'accepting_now',
    attentionAmount: '90071992547409931234567890',
    acceptedStages: ['VOTING'],
  });
});

test('rejects invalid policies and stages unsupported by the caller', () => {
  const base = {
    dao: 'nouns',
    daoChainId: 1,
    enabled: true,
    availability: 'accepting_now',
    attentionAmount: '1000000',
    acceptedStages: ['VOTING'],
  };

  for (const input of [
    { ...base, dao: 'other' },
    { ...base, daoChainId: 8453 },
    { ...base, availability: 'unknown' },
    { ...base, attentionAmount: '999999' },
    { ...base, attentionAmount: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, acceptedStages: [] },
    { ...base, acceptedStages: ['PRE_VOTE'] },
  ]) {
    assert.throws(() => validateDaoPolicy(input, ['VOTING']));
  }
});

test('freezes the Nouns MVP policy to VOTING regardless of caller-supported stages', () => {
  const base = {
    dao: 'nouns',
    daoChainId: 1,
    enabled: true,
    availability: 'accepting_now',
    attentionAmount: '1000000',
    acceptedStages: ['VOTING'],
  };

  assert.doesNotThrow(() => validateDaoPolicy(base, ['PRE_VOTE']));
  assert.throws(() => validateDaoPolicy({ ...base, acceptedStages: [] }, ['VOTING']));
  assert.throws(() => validateDaoPolicy({ ...base, acceptedStages: ['CLOSED'] }, ['CLOSED']));
  assert.throws(() => validateDaoPolicy({ ...base, acceptedStages: ['PRE_VOTE'] }, ['PRE_VOTE']));
});
