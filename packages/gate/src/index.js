const constants = require('./constants');
const schema = require('./schema');
const submissionHash = require('./submission-hash');
const {
  NOUNS_LIFECYCLE_MAPPING,
  NOUNS_LIFECYCLE_MAPPING_VERSION,
  mapNativeLifecycle,
} = require('./eligibility');
const {
  SUPPORTED_DECODER_VERSIONS,
  decodeAction,
  validateFact,
  requireVerificationFact,
  serializeVerificationFact,
} = require('./facts');
const markdown = require('./markdown');

module.exports = {
  ...constants,
  createDaoPolicySchema: schema.createDaoPolicySchema,
  validateDaoPolicy: schema.validateDaoPolicy,
  serializeDaoPolicy: schema.serializeDaoPolicy,
  canonicalizeSubmission: submissionHash.canonicalizeSubmission,
  serializeCanonicalSubmission: submissionHash.serializeCanonicalSubmission,
  hashSubmission: submissionHash.hashSubmission,
  NOUNS_LIFECYCLE_MAPPING,
  NOUNS_LIFECYCLE_MAPPING_VERSION,
  mapNativeLifecycle,
  SUPPORTED_DECODER_VERSIONS,
  decodeAction,
  validateFact,
  requireVerificationFact,
  serializeVerificationFact,
  validateMarkdown: markdown.validateMarkdown,
  renderMarkdown: markdown.renderMarkdown,
  validatePitchMarkdown: markdown.validatePitchMarkdown,
  validateDisclosureMarkdown: markdown.validateDisclosureMarkdown,
};
