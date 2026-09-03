/**
 * Subgraph-first reads for the proposal list and delegate history (indexed,
 * batchable). Live tallies and tx construction go through direct contract reads
 * elsewhere — this module is for the cheap, indexed bulk queries.
 */
import type { Config } from '../config.js';
import type { Proposal, ProposalStatus, DelegateVote } from '../types.js';

async function query<T>(url: string, gql: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: gql, variables }),
  });
  if (!res.ok) {
    throw new Error(`subgraph ${res.status}: ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`subgraph error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  if (!json.data) throw new Error('subgraph: empty response');
  return json.data;
}

interface RawProposal {
  id: string;
  title: string | null;
  description: string | null;
  proposer: { id: string };
  status: string;
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  quorumVotes: string;
  startBlock: string;
  endBlock: string;
  createdTimestamp: string | null;
  // The Nouns subgraph exposes voting-period end via block; some deployments
  // also surface an executionETA. We derive human time downstream.
}

function mapStatus(raw: string): ProposalStatus {
  const s = raw.toUpperCase();
  const known: ProposalStatus[] = [
    'PENDING', 'ACTIVE', 'CANCELLED', 'VETOED', 'QUEUED',
    'EXECUTED', 'DEFEATED', 'EXPIRED', 'UPDATABLE', 'OBJECTION_PERIOD',
  ];
  return (known.find((k) => k === s) ?? 'PENDING') as ProposalStatus;
}

const PROPOSALS_QUERY = /* GraphQL */ `
  query Proposals($first: Int!) {
    proposals(first: $first, orderBy: createdTimestamp, orderDirection: desc) {
      id
      title
      description
      proposer { id }
      status
      forVotes
      againstVotes
      abstainVotes
      quorumVotes
      startBlock
      endBlock
      createdTimestamp
    }
  }
`;

export async function fetchProposals(config: Config, first = 40): Promise<Proposal[]> {
  const data = await query<{ proposals: RawProposal[] }>(
    config.subgraphUrl,
    PROPOSALS_QUERY,
    { first },
  );
  return data.proposals.map((p) => ({
    id: Number(p.id),
    title: (p.title ?? `Proposal ${p.id}`).trim() || `Proposal ${p.id}`,
    description: p.description ?? '',
    proposer: p.proposer?.id ?? '',
    status: mapStatus(p.status),
    forVotes: BigInt(p.forVotes ?? '0'),
    againstVotes: BigInt(p.againstVotes ?? '0'),
    abstainVotes: BigInt(p.abstainVotes ?? '0'),
    quorumVotes: BigInt(p.quorumVotes ?? '0'),
    startBlock: Number(p.startBlock ?? '0'),
    endBlock: Number(p.endBlock ?? '0'),
    createdTimestamp: p.createdTimestamp ? Number(p.createdTimestamp) : undefined,
  }));
}

const DELEGATE_QUERY = /* GraphQL */ `
  query Delegate($id: ID!) {
    delegate(id: $id) {
      id
      delegatedVotesRaw
      votes(first: 100, orderBy: blockNumber, orderDirection: desc) {
        proposal { id }
        support
        supportDetailed
        votes
        reason
      }
    }
    account(id: $id) {
      delegate { id }
    }
  }
`;

interface RawDelegate {
  delegate: {
    id: string;
    delegatedVotesRaw: string;
    votes: Array<{
      proposal: { id: string };
      supportDetailed: number;
      votes: string;
      reason: string | null;
    }>;
  } | null;
  account: { delegate: { id: string } | null } | null;
}

export interface DelegateSubgraphResult {
  votingPower: bigint;
  delegatingTo: string;
  votes: DelegateVote[];
}

export async function fetchDelegate(
  config: Config,
  address: string,
): Promise<DelegateSubgraphResult> {
  const id = address.toLowerCase();
  const data = await query<RawDelegate>(config.subgraphUrl, DELEGATE_QUERY, { id });
  const votes: DelegateVote[] = (data.delegate?.votes ?? []).map((v) => ({
    proposalId: Number(v.proposal.id),
    support: (v.supportDetailed as 0 | 1 | 2) ?? 2,
    votes: BigInt(v.votes ?? '0'),
    reason: v.reason ?? undefined,
  }));
  return {
    votingPower: BigInt(data.delegate?.delegatedVotesRaw ?? '0'),
    delegatingTo: data.account?.delegate?.id ?? '',
    votes,
  };
}

