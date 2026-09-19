const { NOUNS_LIFECYCLE_MAPPING_VERSION } = require('./eligibility');

const NOUNS_GATE_SUPPORTED_STAGES = Object.freeze(['PRE_VOTE', 'VOTING']);

function adaptNounsGateLifecycle(nativeState) {
  return {
    eligibility: nativeState === 'ACTIVE' ? 'VOTING' : 'CLOSED',
    mappingVersion: NOUNS_LIFECYCLE_MAPPING_VERSION,
  };
}

module.exports = {
  NOUNS_GATE_SUPPORTED_STAGES,
  adaptNounsGateLifecycle,
};
