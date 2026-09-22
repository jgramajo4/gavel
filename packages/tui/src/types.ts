/** Shared domain types. */

export type ProposalStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'CANCELLED'
  | 'VETOED'
  | 'SUCCEEDED'
  | 'QUEUED'
  | 'EXECUTED'
  | 'DEFEATED'
  | 'EXPIRED'
  | 'UPDATABLE'
  | 'OBJECTION_PERIOD';

/**
 * A proposal, in whichever DAO it belongs to.
 *
 * `dao` is not optional and `id` is a string. Both are consequences of the
 * same fact: proposal ids are per-DAO counters, so Nouns #12 and ENS #12 are
 * different proposals, and ENS ids are uint256 values that do not survive
 * `Number()`. `key` is the composite identity (`dao:id`) and is what any map,
 * cache or list key must use.
 */
export interface Proposal {
  dao: string;
  daoDisplayName: string;
  key: string;
  id: string;
  /** `Nouns #812` -- always carries the DAO, so the user cannot mistake one for another. */
  label: string;
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
  /** Unix seconds, best-effort (derived / from indexer timestamps). */
  endTimestamp?: number;
  createdTimestamp?: number;
}

/** Live tally read directly from a governor (block-accurate). */
export interface VoteTally {
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  quorumVotes: bigint;
}

export type VoteSupport = 0 | 1 | 2; // 0 = Against, 1 = For, 2 = Abstain

export interface Prediction {
  proposalKey: string;
  passProbability: number; // 0..1
  label: 'PASS' | 'FAIL';
  fetchedAt: number; // unix ms
  raw?: unknown;
}

/**
 * A delegation record.
 *
 * `votingPowerLabel` and `delegationLabel` come from the DAO catalog, because
 * "Votes", "Voting power" and "Staked voting power" are different quantities
 * and a generic screen that calls all three the same thing is misleading.
 */
export interface DelegateInfo {
  dao: string;
  address: string;
  ens?: string;
  votingPower: bigint;
  votingPowerLabel: string;
  delegatingTo: string;
  delegationLabel: string;
  votes: DelegateVote[];
}

export interface DelegateVote {
  proposalKey: string;
  proposalId: string;
  support: VoteSupport;
  votes: bigint;
  reason?: string;
}

/** Decoded EAS attestation for the Passport feed (a Nouns-specific feature). */
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
