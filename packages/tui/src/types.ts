/** Shared domain types. */

export type ProposalStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'CANCELLED'
  | 'VETOED'
  | 'QUEUED'
  | 'EXECUTED'
  | 'DEFEATED'
  | 'EXPIRED'
  | 'UPDATABLE'
  | 'OBJECTION_PERIOD';

export interface Proposal {
  id: number;
  title: string;
  description: string;
  proposer: string;
  status: ProposalStatus;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  quorumVotes: bigint;
  /** Block numbers from the governor. */
  startBlock: number;
  endBlock: number;
  /** Unix seconds, best-effort (derived / from subgraph timestamps). */
  endTimestamp?: number;
  createdTimestamp?: number;
}

/** Live tally read directly from the governor (block-accurate). */
export interface VoteTally {
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  quorumVotes: bigint;
}

export type VoteSupport = 0 | 1 | 2; // 0 = Against, 1 = For, 2 = Abstain

export interface Prediction {
  proposalId: number;
  passProbability: number; // 0..1
  label: 'PASS' | 'FAIL';
  fetchedAt: number; // unix ms
  raw?: unknown;
}

export interface DelegateInfo {
  address: string;
  ens?: string;
  votingPower: bigint;
  delegatingTo: string;
  votes: DelegateVote[];
}

export interface DelegateVote {
  proposalId: number;
  support: VoteSupport;
  votes: bigint;
  reason?: string;
}

/** Decoded EAS attestation for the Passport feed. */
export interface Attestation {
  id: string;
  schemaId: string;
  attester: string;
  recipient: string;
  refUID: string;
  revocable: boolean;
  revocationTime: number;
  expirationTime: number;
  time: number;
  data: string; // raw hex
  decoded?: Record<string, unknown>;
  passportType?: 'MILESTONE' | 'PEER' | 'PASSPORT' | 'UNKNOWN';
}

export interface RewardsBalance {
  clientId: number;
  balance: bigint;
  approved: boolean;
}

