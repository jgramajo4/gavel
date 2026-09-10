/**
 * Read-only client for the self-hosted governance index (`packages/governance-index`).
 * It serves the same normalized proposals the CLI consumes, so the TUI can drop
 * its public-subgraph dependency wherever an operator runs one.
 *
 * The index is a cache of chain state, not an oracle: a stalled or failing sync
 * looks exactly like a DAO that stopped proposing. Every read therefore gates on
 * checkpoint freshness first and fails closed, matching the CLI client.
 */
import type { Config } from '../config.js';
import type { Proposal, ProposalStatus } from '../types.js';
import { INDEX_MAX_STALENESS_MS } from '../constants.js';

/**
 * Normalized proposal document served by `/v1/daos/<dao>/proposals`.
 *
 * `state` is the raw upstream value and can be stale -- the Nouns subgraph
 * reports `ACTIVE` for proposals that lost their vote months ago. Read
 * `effectiveStatus`, which is what the indexer derived from the voting window,
 * the finalized block and the tallies. Both are optional here only so an older
 * index still renders.
 */
interface IndexedProposal {
  id: string;
  title: string;
  description: string;
  proposer: string;
  state: string;
  sourceState?: string;
  effectiveStatus?: string;
  outcome?: string;
  trackingState?: 'HOT' | 'WARM' | 'FINAL';
  startBlock: string;
  endBlock: string;
  quorumVotes: string;
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  createdAt?: string;
  endTime?: string | null;
}

interface SyncCheckpoint {
  sourceId: string;
  updatedAt: string;
  lastError?: string | null;
}

export class IndexStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexStaleError';
  }
}

async function request<T>(config: Config, path: string): Promise<T> {
  if (!/^https?:\/\//.test(config.indexApiUrl)) {
    throw new Error('GAVEL_INDEX_API_URL must be an HTTP(S) URL');
  }
  const res = await fetch(`${config.indexApiUrl.replace(/\/$/, '')}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`governance index ${res.status}: ${res.statusText}`);
  return (await res.json()) as T;
}

function mapStatus(raw: string): ProposalStatus {
  const s = raw.toUpperCase();
  const known: ProposalStatus[] = [
    'PENDING', 'ACTIVE', 'CANCELLED', 'VETOED', 'SUCCEEDED', 'QUEUED',
    'EXECUTED', 'DEFEATED', 'EXPIRED', 'UPDATABLE', 'OBJECTION_PERIOD',
  ];
  return (known.find((k) => k === s) ?? 'PENDING') as ProposalStatus;
}

function seconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/**
 * Refuses to read an index with no checkpoint, a source reporting a sync error,
 * or a newest checkpoint older than the configured staleness limit.
 */
async function assertFresh(config: Config, dao: string): Promise<void> {
  const status = await request<{ sources?: SyncCheckpoint[] }>(
    config,
    `/v1/daos/${dao}/sync-status`,
  );
  const sources = status.sources ?? [];
  if (sources.length === 0) {
    throw new IndexStaleError(`governance index has no sync checkpoint for ${dao}`);
  }
  const failed = sources.find((s) => s.lastError);
  if (failed) {
    throw new IndexStaleError(
      `governance index sync for ${dao} is failing (source ${failed.sourceId})`,
    );
  }
  for (const source of sources) {
    const updatedAt = Date.parse(source.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      throw new IndexStaleError(`governance index checkpoint for ${dao} has no usable updatedAt`);
    }
    const age = Date.now() - updatedAt;
    if (age > INDEX_MAX_STALENESS_MS) {
      throw new IndexStaleError(
        `governance index for ${dao} is ${Math.round(age / 1000)}s stale ` +
          `(limit ${Math.round(INDEX_MAX_STALENESS_MS / 1000)}s)`,
      );
    }
  }
}

export async function fetchProposals(
  config: Config,
  first = 40,
  dao = 'nouns',
): Promise<Proposal[]> {
  await assertFresh(config, dao);
  const limit = Math.min(Math.max(first, 1), 100);
  const page = await request<{ items: IndexedProposal[] }>(
    config,
    `/v1/daos/${dao}/proposals?limit=${limit}`,
  );
  return page.items.map((p) => ({
    id: Number(p.id),
    title: (p.title ?? `Proposal ${p.id}`).trim() || `Proposal ${p.id}`,
    description: p.description ?? '',
    proposer: p.proposer ?? '',
    status: mapStatus(p.effectiveStatus ?? p.outcome ?? p.state),
    forVotes: BigInt(p.forVotes ?? '0'),
    againstVotes: BigInt(p.againstVotes ?? '0'),
    abstainVotes: BigInt(p.abstainVotes ?? '0'),
    quorumVotes: BigInt(p.quorumVotes ?? '0'),
    startBlock: Number(p.startBlock ?? '0'),
    endBlock: Number(p.endBlock ?? '0'),
    endTimestamp: seconds(p.endTime),
    createdTimestamp: seconds(p.createdAt),
  }));
}
