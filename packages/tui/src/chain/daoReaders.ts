/**
 * Which DAOs this build can read directly from chain.
 *
 * The TUI's live tally poller and delegation screens speak to contracts, and
 * contracts are per-DAO. Rather than assume every DAO has the Nouns governor
 * at the Nouns address -- which is what the single-DAO TUI did implicitly --
 * a DAO either has a reader here or it does not, and screens branch on that.
 *
 * A DAO with no reader is not broken: its proposals, tallies and state still
 * come from the governance index, and its votes and delegation are prepared
 * through the canonical CLI path (`gavel execution prepare`,
 * `gavel prepare-delegation`), which validates against live chain state in the
 * adapter that actually knows the DAO. What is missing is only the live
 * in-terminal poll, and saying so is better than reading the wrong contract.
 */
import type { PublicClient } from 'viem';
import { fetchTally, fetchProposalState } from '../data/votes.js';
import { currentDelegate, delegateTo } from '../actions/delegate.js';
import type { VoteTally, ProposalStatus } from '../types.js';
import type { Signer } from './clients.js';
import type { TxResult } from '../actions/vote.js';

export interface DaoChainReader {
  dao: string;
  fetchTally(client: PublicClient, proposalId: string): Promise<VoteTally>;
  fetchProposalState(client: PublicClient, proposalId: string): Promise<ProposalStatus>;
  currentDelegate(client: PublicClient, account: `0x${string}`): Promise<`0x${string}`>;
  delegateTo(client: PublicClient, signer: Signer, delegatee: `0x${string}`): Promise<TxResult>;
}

const READERS: Record<string, DaoChainReader> = {
  nouns: {
    dao: 'nouns',
    fetchTally,
    fetchProposalState,
    currentDelegate,
    delegateTo,
  },
};

export function getChainReader(dao: string): DaoChainReader | null {
  return READERS[dao] ?? null;
}

export function hasChainReader(dao: string): boolean {
  return Boolean(READERS[dao]);
}
