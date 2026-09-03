/**
 * Direct contract reads for live, block-accurate vote tallies. Used by the
 * proposal-detail poller — a single cheap `proposalVotes` read, not a subgraph
 * query.
 */
import type { PublicClient } from 'viem';
import { ADDRESSES } from '../constants.js';
import { nounsDaoAbi } from '../chain/abis.js';
import type { VoteTally, ProposalStatus } from '../types.js';

const STATE_MAP: ProposalStatus[] = [
  'PENDING',    // 0
  'ACTIVE',     // 1
  'CANCELLED',  // 2
  'DEFEATED',   // 3 (also Vetoed-adjacent in some govs; see subgraph for detail)
  'QUEUED',     // 4 -> actually Succeeded in OZ; Nouns has custom order below
  'EXPIRED',    // 5
  'EXECUTED',   // 6
];

/**
 * NounsDAO `state()` enum (custom, not vanilla OZ):
 * 0 Pending, 1 Active, 2 Cancelled, 3 Defeated, 4 Succeeded, 5 Queued,
 * 6 Expired, 7 Executed, 8 Vetoed, 9 ObjectionPeriod, 10 Updatable.
 */
const NOUNS_STATE_MAP: Record<number, ProposalStatus> = {
  0: 'PENDING',
  1: 'ACTIVE',
  2: 'CANCELLED',
  3: 'DEFEATED',
  4: 'QUEUED', // Succeeded — treat as queued-adjacent for display
  5: 'QUEUED',
  6: 'EXPIRED',
  7: 'EXECUTED',
  8: 'VETOED',
  9: 'OBJECTION_PERIOD',
  10: 'UPDATABLE',
};

export async function fetchTally(
  client: PublicClient,
  proposalId: number,
): Promise<VoteTally> {
  const [votes, quorum] = await Promise.all([
    client.readContract({
      address: ADDRESSES.NounsDAO as `0x${string}`,
      abi: nounsDaoAbi,
      functionName: 'proposalVotes',
      args: [BigInt(proposalId)],
    }),
    client.readContract({
      address: ADDRESSES.NounsDAO as `0x${string}`,
      abi: nounsDaoAbi,
      functionName: 'quorumVotes',
      args: [BigInt(proposalId)],
    }),
  ]);
  const [againstVotes, forVotes, abstainVotes] = votes as [bigint, bigint, bigint];
  return { forVotes, againstVotes, abstainVotes, quorumVotes: quorum as bigint };
}

export async function fetchProposalState(
  client: PublicClient,
  proposalId: number,
): Promise<ProposalStatus> {
  const raw = (await client.readContract({
    address: ADDRESSES.NounsDAO as `0x${string}`,
    abi: nounsDaoAbi,
    functionName: 'state',
    args: [BigInt(proposalId)],
  })) as number;
  return NOUNS_STATE_MAP[Number(raw)] ?? STATE_MAP[Number(raw)] ?? 'PENDING';
}

