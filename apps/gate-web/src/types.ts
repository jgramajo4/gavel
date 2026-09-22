// Wire types mirroring the merged Gate server projections. Every type here is a
// PUBLIC or OWNER-BOUND server response. Nothing private to Gavel or to a voter
// (notification channel, destination, capacity, read state, delivery config,
// session/nonce/signature material) has a type here, because the browser must
// never be able to model — let alone render — a field the server does not serve.

export type Availability = 'accepting_now' | 'paused' | 'closed';
export type NormalizedLifecycle = 'PRE_VOTE' | 'VOTING' | 'CLOSED';

export type PublicReceiptState =
  | 'payment_required'
  | 'pending_settlement'
  | 'accepted'
  | 'rejected_by_policy'
  | 'duplicate'
  | 'malformed'
  | 'expired';

/** `GET /v1/gates` and `GET /v1/gates/:wallet` — public policy projection. */
export interface PublicPolicy {
  dao: 'nouns';
  supportedStages: NormalizedLifecycle[];
  acceptedStages: NormalizedLifecycle[];
  /** Voter attention price, USDC atomic units, decimal string. */
  attentionAmount: string;
  /** Fixed Gavel service fee, USDC atomic units, decimal string. */
  gavelFeeAmount: string;
  tags: string[];
}

export interface GovernancePower {
  dao: 'nouns';
  /** Exact indexed power, decimal string. Never rounded for display. */
  amount: string;
  /** Canonical "as of" timestamp for `amount`. */
  asOf: string;
}

export interface PublicGateProfile {
  wallet: string;
  label?: string | null;
  availability: Availability;
  /** Server-owned. The browser never derives acceptance from availability alone. */
  acceptingSubmissions: boolean;
  message?: string | null;
  policies?: PublicPolicy[];
  governancePower?: GovernancePower;
}

/** The exact EIP-712 quote the server signed and persisted. Immutable here. */
export interface QuoteDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export interface QuoteMessage {
  quoteId: string;
  payer: string;
  voter: string;
  attentionAmount: string;
  gavelFeeAmount: string;
  submissionHash: string;
  token: string;
  expiry: string;
  quoteVersion: string;
}

export interface IssuedQuote {
  domain: QuoteDomain;
  message: QuoteMessage;
  totalAmount: string;
  signature: string;
}

export interface SubmissionReceipt {
  publicId: string;
  state: PublicReceiptState;
  updatedAt?: string;
  acceptedAt?: string;
  quote?: IssuedQuote;
}

/** `POST /v1/gates/:wallet/submissions` → 409. */
export interface DuplicateReceipt {
  state: 'duplicate';
  existing: {
    publicId: string;
    state: PublicReceiptState;
    /** Frozen authenticated resume path. Never a new quote request. */
    resumeUrl: string;
  };
}

export interface SubmissionRequest {
  dao: 'nouns';
  proposalId: string;
  stage: NormalizedLifecycle;
  position: string;
  pitch: string;
  disclosures: string;
  evidenceUrls: string[];
}

export interface AuthChallenge {
  proofType: 'WalletSession' | 'GateEnrollment' | 'BasePayoutControl';
  primaryType: string;
  domain: { name: string; version: string; chainId: number | string; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  message: Record<string, string | boolean>;
  nonceHash: string;
  payloadHash: string;
}

/**
 * `dao_inbox` is the private inbox role. It is issued by the same challenge /
 * signature / session exchange as the other roles and is never interchangeable
 * with them: the server scopes `/v1/gate/me/inbox*` to `dao_inbox` alone, and
 * this client refuses to send a token of any other role to those routes.
 */
export type WalletSessionRole = 'base_sender' | 'dao_profile' | 'dao_inbox';

export interface WalletSession {
  wallet: string;
  role: WalletSessionRole;
  chainId: string;
  audience: string;
  issuedAt: string;
  expiry: string;
}

export interface VerifiedSession {
  /** Held in memory only. Never written to localStorage or sessionStorage. */
  token: string;
  session: WalletSession;
}

// --- Facts -----------------------------------------------------------------
// Provenance is load-bearing: only `canonical` and `decoded` were produced from
// canonical chain data. `enriched` is display-only and must never be styled as
// verified.

export interface CanonicalEvidence {
  actionIndex: number;
  target: string;
  valueWei: string;
  calldata: string;
  signature: string;
}

export interface CanonicalFact extends CanonicalEvidence {
  source: 'canonical';
  kind: 'raw_action';
  displayLabel: string;
  canonicalEvidence: CanonicalEvidence;
}

export interface DecodedNativeTransferFact {
  source: 'decoded';
  kind: 'native_eth_transfer';
  displayLabel: string;
  decoderVersion: string;
  actionIndex: number;
  canonicalEvidence: CanonicalEvidence;
  amountWei: string;
  recipient: string;
}

export interface DecodedUsdcTransferFact {
  source: 'decoded';
  kind: 'usdc_transfer';
  displayLabel: string;
  decoderVersion: string;
  actionIndex: number;
  canonicalEvidence: CanonicalEvidence;
  token: string;
  amountAtomic: string;
  recipient: string;
}

export type DecodedFact = DecodedNativeTransferFact | DecodedUsdcTransferFact;

export interface EnrichedFact {
  source: 'enriched';
  displayLabel: string;
  value: string;
  verifiable?: false;
}

export type Fact = CanonicalFact | DecodedFact | EnrichedFact;

// --- Private inbox ---------------------------------------------------------
// These mirror `projectInbox` in packages/server/src/gate/inbox-service.js —
// the OWNER-BOUND projection served by `GET /v1/gate/me/inbox*`. Nothing here
// is public: the directory and profile projections must never carry a field
// declared below. The projection deliberately omits the advocate's identity,
// the payer address, the quote, notification channel/destination, and read
// state, so there is nothing of that kind to model here either.

/**
 * Canonical target identity as the server recorded it at issuance time.
 *
 * `kind: 'candidate'` marks a Nouns Proposal Candidate seeking sponsorship. A
 * candidate carries `targetId`/`proposer`/`slug` and NO `proposalId`; an active
 * proposal carries `proposalId`. Every field is optional because this is a
 * stored snapshot projection, not a schema the browser may assume complete.
 */
export interface InboxCanonicalFacts {
  dao?: string;
  targetId?: string;
  proposalId?: string;
  kind?: string;
  proposer?: string;
  slug?: string;
  context?: string;
  nativeState?: string;
  eligibility?: string;
  mappingVersion?: string;
  sourceBlock?: string;
  sourceBlockHash?: string;
  contentHash?: string;
  refreshedAt?: string;
}

export interface InboxDecodedFacts {
  decoderVersion?: string;
  actions: DecodedFact[];
}

/** One accepted submission. List and detail share this exact projection. */
export interface InboxItem {
  id: string;
  archived: boolean;
  /** Inbox creation time — set only after Gate verified settlement. */
  createdAt: string | null;
  /** Advocate-controlled Markdown. Rendered only through MarkdownPitch. */
  pitch: string;
  /** Advocate-controlled Markdown. */
  disclosures: string;
  /** Advocate-controlled URLs. Rendered only through ExternalLink, never fetched. */
  evidenceUrls: string[];
  canonicalFacts: InboxCanonicalFacts;
  decodedFacts: InboxDecodedFacts;
  enrichedFacts: EnrichedFact[];
  /** Canonical actions the versioned decoder could not interpret. */
  rawUnknownActions: CanonicalEvidence[];
  issuanceLifecycle: string | null;
  currentLifecycle: string | null;
  stateChangedAfterQuote: boolean;
}

/** `POST /v1/gate/me/inbox/:id/archive`. Idempotent; archives nothing else. */
export interface InboxArchiveResult {
  id: string;
  archived: boolean;
}
