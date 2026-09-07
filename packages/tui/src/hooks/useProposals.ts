/**
 * Proposal-list state. Reads the governance index — the public one unless
 * GAVEL_INDEX_API_URL selects another — falling back to the subgraph only when
 * that variable is explicitly empty. Refreshes in the background every 2 min
 * (paused when not focused or idle). Sorts active proposals first, then by most
 * recent.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchProposals } from '../data/subgraph.js';
import { fetchProposals as fetchIndexedProposals } from '../data/governanceIndex.js';
import { usePolling } from './usePolling.js';
import { POLL_INTERVALS } from '../constants.js';
import type { Proposal } from '../types.js';
import { useServices } from './AppContext.js';

function sortProposals(list: Proposal[]): Proposal[] {
  const activeRank = (p: Proposal): number => {
    if (p.status === 'ACTIVE' || p.status === 'OBJECTION_PERIOD') return 0;
    if (p.status === 'PENDING' || p.status === 'UPDATABLE') return 1;
    return 2;
  };
  return [...list].sort((a, b) => {
    const ra = activeRank(a);
    const rb = activeRank(b);
    if (ra !== rb) return ra - rb;
    return b.id - a.id; // most recent first
  });
}

export function useProposals(focused: boolean, idle: boolean) {
  const { config } = useServices();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(0);

  const load = useCallback(async () => {
    try {
      // The index is authoritative: it fails closed on a stalled sync rather
      // than silently falling back to a different view of the chain.
      const list = config.indexApiUrl
        ? await fetchIndexedProposals(config)
        : await fetchProposals(config);
      setProposals(sortProposals(list));
      setLastUpdated(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [config]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(load, POLL_INTERVALS.proposalList, focused && !idle);

  return { proposals, loading, error, lastUpdated, refresh: load };
}

