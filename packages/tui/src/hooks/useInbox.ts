/**
 * The unified inbox's state.
 *
 * Fetching is here; ranking and classification are in `@gavel/core`'s
 * `buildGovernanceInbox()`. That split is deliberate: "which proposals need
 * attention, in what order" is governance policy that a headless runtime needs
 * too, and a policy that lives in a React hook can only ever serve the TUI.
 *
 * A DAO that fails to load stays in the result as an unavailable row. It is
 * never dropped, because a missing DAO looks like Gavel forgot about it.
 */
import { useCallback, useEffect, useState } from 'react';
import { buildGovernanceInbox, type GovernanceInbox } from '@gavel/core';
import { fetchProposalsForDaos, type DaoFetchFailure } from '../data/governanceIndex.js';
import { fetchProposals as fetchNounsSubgraphProposals } from '../data/subgraph.js';
import { usePolling } from './usePolling.js';
import { POLL_INTERVALS } from '../constants.js';
import type { Proposal } from '../types.js';
import { useServices } from './AppContext.js';

const EMPTY: GovernanceInbox = {
  needsAttention: [],
  proposals: [],
  daos: [],
  counts: { followed: 0, available: 0, unavailable: 0, needsAttention: 0 },
};

export function useInbox(focused: boolean, idle: boolean) {
  const { config } = useServices();
  const followedDaos = config.gavel.followedDaos;
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [inbox, setInbox] = useState<GovernanceInbox>(EMPTY);
  const [failures, setFailures] = useState<DaoFetchFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number>(0);

  const load = useCallback(async () => {
    if (followedDaos.length === 0) {
      setProposals([]);
      setInbox(EMPTY);
      setLoading(false);
      return;
    }
    // The index is authoritative: it fails closed on a stalled sync rather
    // than silently falling back to a different view of the chain. The
    // subgraph path stays available only as the explicit per-DAO opt-out.
    const result = config.indexApiUrl
      ? await fetchProposalsForDaos(config, followedDaos)
      : await fetchLegacySubgraph(config, followedDaos);
    setProposals(result.proposals);
    setFailures(result.failures);
    setInbox(
      buildGovernanceInbox({
        followedDaos,
        proposals: result.proposals.map((proposal) => ({
          dao: proposal.dao,
          id: proposal.id,
          title: proposal.title,
          state: proposal.status,
          endTime: proposal.endTimestamp,
          createdAt: proposal.createdTimestamp,
        })),
        daoErrors: result.failures,
      }) as GovernanceInbox,
    );
    setLastUpdated(Date.now());
    setLoading(false);
  }, [config, followedDaos]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(load, POLL_INTERVALS.proposalList, focused && !idle);

  return { inbox, proposals, failures, loading, lastUpdated, refresh: load };
}

/**
 * The pre-index path, kept for the one DAO that has a public subgraph.
 *
 * Every other DAO reports as unavailable rather than silently missing: an
 * explicit "no source configured" is the honest answer, and it tells the user
 * exactly which setting to change.
 */
async function fetchLegacySubgraph(
  config: Parameters<typeof fetchNounsSubgraphProposals>[0],
  daos: string[],
): Promise<{ proposals: Proposal[]; failures: DaoFetchFailure[] }> {
  const proposals: Proposal[] = [];
  const failures: DaoFetchFailure[] = [];
  for (const dao of daos) {
    if (dao !== 'nouns') {
      failures.push({
        dao,
        message: `No governance index is configured, and ${dao} has no direct source. Set GAVEL_INDEX_API_URL.`,
      });
      continue;
    }
    try {
      proposals.push(...(await fetchNounsSubgraphProposals(config)));
    } catch (error) {
      failures.push({ dao, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { proposals, failures };
}
