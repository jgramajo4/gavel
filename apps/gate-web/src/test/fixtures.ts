import type {
  CanonicalFact,
  DecodedFact,
  DuplicateReceipt,
  EnrichedFact,
  InboxItem,
  IssuedQuote,
  PublicGateProfile,
  SubmissionReceipt,
  VerifiedSession,
} from '../types';

export const SPLITTER = '0x1111111111111111111111111111111111111111';
export const USDC = '0x2222222222222222222222222222222222222222';
export const PAYER = '0x3333333333333333333333333333333333333333';
export const VOTER = '0x4444444444444444444444444444444444444444';

/** A Base-Sepolia quote: the app must never assume chain 8453. */
export const TEST_CHAIN_ID = 84532;

/** Quote expiry and a fixed "now" five minutes inside it. Checkout and the
 *  payment boundary take an injected clock so expiry tests never depend on the
 *  machine's wall clock. */
export const QUOTE_EXPIRY_SECONDS = 1793577600;
export const NOW_SECONDS = QUOTE_EXPIRY_SECONDS - 300;
export const nowMs = () => NOW_SECONDS * 1000;

export const quote: IssuedQuote = Object.freeze({
  domain: { name: 'GavelGateSplitter', version: '1', chainId: TEST_CHAIN_ID, verifyingContract: SPLITTER },
  message: {
    quoteId: `0x${'ab'.repeat(32)}`,
    payer: PAYER,
    voter: VOTER,
    attentionAmount: '5000000',
    gavelFeeAmount: '250000',
    submissionHash: `0x${'cd'.repeat(32)}`,
    token: USDC,
    expiry: String(QUOTE_EXPIRY_SECONDS),
    quoteVersion: '1',
  },
  totalAmount: '5250000',
  signature: `0x${'11'.repeat(64)}1b`,
});

export const quotedReceipt: SubmissionReceipt = {
  publicId: 'AAAAAAAAAAAAAAAAAAAAAA',
  state: 'payment_required',
  updatedAt: '2026-09-16T10:00:00.000Z',
  quote,
};

export const duplicateReceipt: DuplicateReceipt = {
  state: 'duplicate',
  existing: {
    publicId: 'AAAAAAAAAAAAAAAAAAAAAA',
    state: 'payment_required',
    resumeUrl: '/v1/submissions/AAAAAAAAAAAAAAAAAAAAAA/resume',
  },
};

export const acceptingProfile: PublicGateProfile = {
  wallet: VOTER,
  ens: 'voter.eth',
  availability: 'accepting_now',
  acceptingSubmissions: true,
  policies: [
    {
      dao: 'nouns',
      supportedStages: ['VOTING'],
      acceptedStages: ['VOTING'],
      attentionAmount: '5000000',
      gavelFeeAmount: '250000',
      tags: ['treasury', 'infra'],
    },
  ],
  governancePower: { dao: 'nouns', amount: '37', asOf: '2026-09-16T09:45:00.000Z' },
};

/** Zero indexed power must still render as an accepting Gate. */
export const zeroPowerProfile: PublicGateProfile = {
  ...acceptingProfile,
  wallet: '0x5555555555555555555555555555555555555555',
  ens: null,
  governancePower: { dao: 'nouns', amount: '0', asOf: '2026-09-16T09:45:00.000Z' },
};

export const highPowerProfile: PublicGateProfile = {
  ...acceptingProfile,
  wallet: '0x6666666666666666666666666666666666666666',
  ens: 'whale.eth',
  governancePower: { dao: 'nouns', amount: '412', asOf: '2026-09-16T09:45:00.000Z' },
};

export const closedProfile: PublicGateProfile = {
  wallet: '0x7777777777777777777777777777777777777777',
  availability: 'closed',
  acceptingSubmissions: false,
  message: 'Not currently accepting new submissions',
  governancePower: { dao: 'nouns', amount: '12', asOf: '2026-09-16T09:45:00.000Z' },
};

/**
 * A profile object deliberately polluted with fields that are PRIVATE to Gavel
 * or to the voter. The merged server never serves these; if a future regression
 * starts serving them, public components must still refuse to render them.
 */
// Values are unmistakable sentinels rather than realistic ones so a leak
// assertion can never be satisfied by an unrelated digit or common word that
// legitimately appears in public copy.
export const PRIVATE_FIXTURE_FIELDS = Object.freeze({
  notificationChannel: 'PRIVATE_CHANNEL_EMAIL',
  notificationDestination: 'PRIVATE_DESTINATION_voter@example.com',
  notificationStatus: 'PRIVATE_NOTIFICATION_SENT',
  deliverySettings: 'PRIVATE_DELIVERY_XMTP_ENABLED',
  capacityRemaining: 'PRIVATE_CAPACITY_REMAINING_7',
  settledInWindow: 'PRIVATE_SETTLED_IN_WINDOW_18',
  readAt: 'PRIVATE_READ_AT_2026-09-16T10:00:00.000Z',
  inboxState: 'PRIVATE_INBOX_UNREAD',
  sessionToken: 'PRIVATE_SESSION_TOKEN',
  quoteSignature: 'PRIVATE_QUOTE_SIGNATURE_0xdeadbeef',
  enrollmentNonce: 'PRIVATE_ENROLLMENT_NONCE_0xfeedface',
  ipAddress: 'PRIVATE_IP_203.0.113.7',
});

export const pollutedProfile = { ...acceptingProfile, ...PRIVATE_FIXTURE_FIELDS } as PublicGateProfile;

/**
 * Proposal facts for FactPanel. These come from the frozen `@gavel/gate` fact
 * schema — canonical actions, the allowlist decoder, and display-only
 * enrichment — not from any inbox response.
 */
export const canonicalFacts: CanonicalFact[] = [
  {
    source: 'canonical',
    kind: 'raw_action',
    displayLabel: 'Raw canonical action',
    actionIndex: 1,
    target: '0x8888888888888888888888888888888888888888',
    valueWei: '0',
    calldata: '0xdeadbeef',
    signature: 'unknownCall(bytes)',
    canonicalEvidence: {
      actionIndex: 1,
      target: '0x8888888888888888888888888888888888888888',
      valueWei: '0',
      calldata: '0xdeadbeef',
      signature: 'unknownCall(bytes)',
    },
  },
];

export const decodedFacts: DecodedFact[] = [
  {
    source: 'decoded',
    kind: 'native_eth_transfer',
    displayLabel: 'Native ETH transfer',
    decoderVersion: 'gate-facts/1',
    actionIndex: 0,
    amountWei: '75000000000000000000',
    recipient: '0x9999999999999999999999999999999999999999',
    canonicalEvidence: {
      actionIndex: 0,
      target: '0x9999999999999999999999999999999999999999',
      valueWei: '75000000000000000000',
      calldata: '0x',
      signature: '',
    },
  },
];

export const enrichedFacts: EnrichedFact[] = [
  { source: 'enriched', displayLabel: 'Recipient ENS', value: 'builder.eth', verifiable: false },
];


// --- Private inbox ---------------------------------------------------------
// Bodies shaped exactly like `projectInbox` in the merged server's
// inbox-service.js, so a test that passes here is testing the real contract.

export const PROPOSER = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
export const CANDIDATE_TARGET_ID = `candidate:${PROPOSER.toLowerCase()}:0x${'cd'.repeat(32)}`;

/** A `dao_inbox` session. Never interchangeable with the other two roles. */
export const inboxSession: VerifiedSession = {
  token: 'i'.repeat(43),
  session: {
    wallet: VOTER,
    role: 'dao_inbox',
    chainId: '1',
    audience: 'gate',
    issuedAt: '1',
    expiry: '9999999999',
  },
};

/** A `dao_profile` session — valid for enrollment, never for the inbox. */
export const profileSession: VerifiedSession = {
  ...inboxSession,
  token: 'p'.repeat(43),
  session: { ...inboxSession.session, role: 'dao_profile' },
};

/** A Nouns proposal candidate seeking sponsorship: PRE_VOTE, no proposalId. */
export const candidateInboxItem: InboxItem = {
  id: 'inbox-candidate',
  archived: false,
  createdAt: '2026-09-18T00:10:00.000Z',
  pitch: 'Please **sponsor** this candidate. [Context](https://example.com/candidate)',
  disclosures: 'Paid by the proposer.',
  evidenceUrls: ['https://example.com/evidence', 'http://insecure.example.com/leak'],
  canonicalFacts: {
    dao: 'nouns',
    targetId: CANDIDATE_TARGET_ID,
    kind: 'candidate',
    proposer: PROPOSER,
    slug: 'fund nouns',
    context: 'candidate sponsorship',
    nativeState: 'ACTIVE',
    eligibility: 'PRE_VOTE',
    mappingVersion: 'nouns-candidate-lifecycle/1',
    sourceBlock: '123',
    sourceBlockHash: `0x${'cc'.repeat(32)}`,
    contentHash: `0x${'dd'.repeat(32)}`,
    refreshedAt: '2026-09-18T00:09:00.000Z',
  },
  decodedFacts: { decoderVersion: 'gate-facts/1', actions: [] },
  enrichedFacts: [],
  rawUnknownActions: [],
  issuanceLifecycle: 'PRE_VOTE',
  currentLifecycle: 'PRE_VOTE',
  stateChangedAfterQuote: false,
};

/** An active governance proposal: VOTING, with a canonical proposal ID. */
export const proposalInboxItem: InboxItem = {
  id: 'inbox-proposal',
  archived: false,
  createdAt: '2026-09-18T01:10:00.000Z',
  pitch: 'Vote FOR proposal 812.',
  disclosures: '',
  evidenceUrls: [],
  canonicalFacts: {
    dao: 'nouns',
    targetId: 'proposal:812',
    proposalId: '812',
    nativeState: 'ACTIVE',
    eligibility: 'VOTING',
    mappingVersion: 'nouns-lifecycle/1',
    sourceBlock: '900',
    sourceBlockHash: `0x${'ee'.repeat(32)}`,
    contentHash: `0x${'ff'.repeat(32)}`,
    refreshedAt: '2026-09-18T01:09:00.000Z',
  },
  decodedFacts: { decoderVersion: 'gate-facts/1', actions: decodedFacts },
  enrichedFacts: enrichedFacts,
  rawUnknownActions: [canonicalFacts[0].canonicalEvidence],
  issuanceLifecycle: 'VOTING',
  currentLifecycle: 'VOTING',
  stateChangedAfterQuote: false,
};
