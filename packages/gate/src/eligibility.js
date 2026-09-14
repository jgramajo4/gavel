const NOUNS_LIFECYCLE_MAPPING_VERSION = 'nouns-lifecycle/1';
const NOUNS_LIFECYCLE_MAPPING = Object.freeze({
  ACTIVE: 'VOTING',
});

function mapNativeLifecycle(nativeState, proposal) {
  void proposal;
  return {
    eligibility: nativeState === 'ACTIVE' ? NOUNS_LIFECYCLE_MAPPING.ACTIVE : 'CLOSED',
    mappingVersion: NOUNS_LIFECYCLE_MAPPING_VERSION,
  };
}

module.exports = {
  NOUNS_LIFECYCLE_MAPPING,
  NOUNS_LIFECYCLE_MAPPING_VERSION,
  mapNativeLifecycle,
};
