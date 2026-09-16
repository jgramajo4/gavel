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
  ens?: string | null;
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

export interface WalletSession {
  wallet: string;
  role: 'base_sender' | 'dao_profile';
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

// There is deliberately no `InboxItem` type. Declaring the shape of a route the
// backend does not serve would make this file the de facto contract for it.
// Fact provenance types above stay: they come from the frozen `@gavel/gate`
// fact schema and are rendered by FactPanel, not by an inbox response parser.
