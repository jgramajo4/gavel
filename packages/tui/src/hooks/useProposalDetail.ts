/**
 * Proposal-detail live state.
 *
 * Polls the on-chain tally at a cadence tiered by proposal state: 15s active,
 * 10s ending-soon, static once terminal, paused when idle.
 *
 * Live polling requires a DAO chain reader. For a DAO without one, the
 * indexed tally is shown and `live` is false -- an honest "this is indexed,
 * not block-accurate" rather than a poll against some other DAO's governor.
 */
import { useCallback, useEffect, useState } from 'react';
import { getChainReader } from '../chain/daoReaders.js';
import { usePolling } from './usePolling.js';
import { POLL_INTERVALS, ENDING_SOON_THRESHOLD_S } from '../constants.js';
import { isTerminalStatus } from '../utils/format.js';
import type { Proposal, VoteTally } from '../types.js';
import { useServices } from './AppContext.js';

export function useProposalDetail(proposal: Proposal, idle: boolean) {
  const { publicClient } = useServices();
  const reader = getChainReader(proposal.dao);
  const [tally, setTally] = useState<VoteTally>({
    forVotes: proposal.forVotes,
    againstVotes: proposal.againstVotes,
    abstainVotes: proposal.abstainVotes,
    quorumVotes: proposal.quorumVotes,
  });
  const [status, setStatus] = useState(proposal.status);
  const [lastUpdated, setLastUpdated] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const terminal = isTerminalStatus(status);
  const endingSoon =
    proposal.endTimestamp !== undefined &&
    proposal.endTimestamp * 1000 - Date.now() < ENDING_SOON_THRESHOLD_S * 1000;
  const interval = endingSoon ? POLL_INTERVALS.endingSoonDetail : POLL_INTERVALS.activeDetail;

  const load = useCallback(async () => {
    if (!reader) return;
    try {
      const [t, s] = await Promise.all([
        reader.fetchTally(publicClient, proposal.id),
        reader.fetchProposalState(publicClient, proposal.id),
      ]);
      setTally(t);
      setStatus(s);
      setLastUpdated(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [publicClient, proposal.id, reader]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(load, interval, Boolean(reader) && !terminal && !idle);

  return { tally, status, lastUpdated, error, terminal, live: Boolean(reader), refresh: load };
}
