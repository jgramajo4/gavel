const AVAILABILITY = Object.freeze(['accepting_now', 'paused', 'closed']);
const NORMALIZED_LIFECYCLES = Object.freeze(['PRE_VOTE', 'VOTING', 'CLOSED']);
const NOUNS_QUOTE_ISSUANCE_STAGES = Object.freeze(['PRE_VOTE', 'VOTING']);
const PUBLIC_RECEIPT_STATES = Object.freeze([
  'payment_required',
  'pending_settlement',
  'accepted',
  'rejected_by_policy',
  'duplicate',
  'malformed',
  'expired',
]);
const FACT_SOURCES = Object.freeze(['canonical', 'decoded', 'enriched']);
const CANONICAL_BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const MIN_ATTENTION_AMOUNT = 1_000_000n;
const GAVEL_FEE_AMOUNT = 250_000n;
const QUOTE_VERSION = 1;
const QUOTE_LIFETIME_SECONDS = 600;
const MAX_PITCH_CODE_POINTS = 4000;
const MAX_DISCLOSURE_CODE_POINTS = 2000;
const MAX_EVIDENCE_URLS = 5;

module.exports = {
  AVAILABILITY,
  NORMALIZED_LIFECYCLES,
  NOUNS_QUOTE_ISSUANCE_STAGES,
  PUBLIC_RECEIPT_STATES,
  FACT_SOURCES,
  CANONICAL_BASE_USDC_ADDRESS,
  MIN_ATTENTION_AMOUNT,
  GAVEL_FEE_AMOUNT,
  QUOTE_VERSION,
  QUOTE_LIFETIME_SECONDS,
  MAX_PITCH_CODE_POINTS,
  MAX_DISCLOSURE_CODE_POINTS,
  MAX_EVIDENCE_URLS,
};
