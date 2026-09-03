/**
 * Proposal-list state. Subgraph fetch + a 2-min background refresh (paused when
 * not focused or idle). Sorts active proposals first, then by most recent.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchProposals } from '../data/subgraph.js';
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
      const list = await fetchProposals(config);
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

