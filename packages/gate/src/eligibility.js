const NOUNS_LIFECYCLE_MAPPING_VERSION = 'nouns-lifecycle/1';
const NOUNS_CANONICAL_NATIVE_STATES = Object.freeze(['ACTIVE']);
const NOUNS_LIFECYCLE_MAPPING = Object.freeze({
  ACTIVE: 'VOTING',
});

function mapNativeLifecycle(nativeState, proposal) {
  void proposal;
  return {
    eligibility: nativeState === NOUNS_CANONICAL_NATIVE_STATES[0]
      ? NOUNS_LIFECYCLE_MAPPING.ACTIVE
      : 'CLOSED',
    mappingVersion: NOUNS_LIFECYCLE_MAPPING_VERSION,
  };
}

module.exports = {
  NOUNS_CANONICAL_NATIVE_STATES,
  NOUNS_LIFECYCLE_MAPPING,
  NOUNS_LIFECYCLE_MAPPING_VERSION,
  mapNativeLifecycle,
};
