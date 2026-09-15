const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NOUNS_CANONICAL_NATIVE_STATES,
  NOUNS_LIFECYCLE_MAPPING,
  NOUNS_LIFECYCLE_MAPPING_VERSION,
  mapNativeLifecycle,
} = require('../src');

const proposal = { id: '42' };

test('accepts only canonical labeled Nouns native states and fails raw Governor code 1 closed', () => {
  assert.deepEqual(NOUNS_CANONICAL_NATIVE_STATES, ['ACTIVE']);
  assert.equal(Object.isFrozen(NOUNS_CANONICAL_NATIVE_STATES), true);
  for (const rawState of [1, '1']) {
    assert.deepEqual(mapNativeLifecycle(rawState, proposal), {
      eligibility: 'CLOSED',
      mappingVersion: NOUNS_LIFECYCLE_MAPPING_VERSION,
    });
  }
});

test('uses the frozen versioned Nouns lifecycle mapping', () => {
  assert.equal(Object.isFrozen(NOUNS_LIFECYCLE_MAPPING), true);
  assert.equal(NOUNS_LIFECYCLE_MAPPING_VERSION, 'nouns-lifecycle/1');
  assert.deepEqual(mapNativeLifecycle('ACTIVE', proposal), {
    eligibility: 'VOTING',
    mappingVersion: NOUNS_LIFECYCLE_MAPPING_VERSION,
  });
});

test('fails every non-ACTIVE Nouns native state closed without PRE_VOTE semantics', () => {
  for (const nativeState of [
    'PENDING',
    'CANCELED',
    'DEFEATED',
    'SUCCEEDED',
    'QUEUED',
    'EXPIRED',
    'EXECUTED',
    'VETOED',
    'UNKNOWN',
    'toString',
    { mapNativeLifecycle: () => ({ eligibility: 'VOTING', mappingVersion: 'evil/1' }) },
  ]) {
    assert.deepEqual(mapNativeLifecycle(nativeState, proposal), {
      eligibility: 'CLOSED',
      mappingVersion: NOUNS_LIFECYCLE_MAPPING_VERSION,
    });
  }
});
