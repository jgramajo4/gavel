import { ApiError, isRecord, requestJson, type FetchLike } from './http';

/**
 * Domain client for the Governance Indexer's public, read-only API.
 *
 * Gavel Web consumes indexed data; it does not aggregate, scrape, or re-derive
 * governance state. Every field here is projected from the index response
 * and nothing is synthesized. In particular:
 *
 *  - `effectiveStatus` is the index's derived lifecycle verdict. When the index
 *    has none, it stays `null`. Raw source `state` is never promoted into it
 *    (a source may report ACTIVE after a terminal transition).
 *  - `provenance` carries what the index publishes about where a fact came
 *    from. It is deliberately a separate object so a future provenance model
 *    (chain, block, tx, source contract, indexed-at) extends it in one place.
 */

export type FactOrigin = 'onchain' | 'external' | 'analysis';

export interface Provenance {
  /** What kind of statement this is. Index rows are onchain facts. */
  origin: FactOrigin;
  chainId: number | null;
  /** Governor/contract the identity is bound to, lowercase. */
  sourceContract: string | null;
  createdBlock: string | null;
}

export interface IndexedDao {
  id: string;
  name: string;
  chainId: string;
  governanceType: string;
  currentGovernor: string;
  updatedAt: string | null;
}

export interface IndexedProposal {
  dao: string;
  id: string;
  title: string;
  proposer: string | null;
  createdAt: string | null;
  /** Derived lifecycle verdict, or null when the index has not established one. */
  effectiveStatus: string | null;
  /** Raw state as reported by the source. Display-secondary; never authoritative. */
  sourceState: string | null;
  forVotes: string | null;
  againstVotes: string | null;
  abstainVotes: string | null;
  quorumVotes: string | null;
  /** Untrusted proposer-authored text. Render as plain text only. */
  description: string | null;
  provenance: Provenance;
}

export interface ProposalPage {
  items: IndexedProposal[];
  nextCursor: string | null;
}

export interface IndexApi {
  listDaos(signal?: AbortSignal): Promise<IndexedDao[]>;
  listProposals(dao: string, options?: { limit?: number; signal?: AbortSignal }): Promise<ProposalPage>;
  getProposal(dao: string, id: string, signal?: AbortSignal): Promise<IndexedProposal | null>;
}

const PROPOSAL_ID = /^\d{1,78}$/;
const SAFE_DAO = /^[a-z0-9][a-z0-9-]{0,63}$/;

function malformed(): ApiError {
  return new ApiError('index', 200, 'MALFORMED_RESPONSE', 'The governance index returned data this app cannot read.', null);
}

function errorFrom(status: number, body: unknown): ApiError {
  // The index's error shape is `{ error: "code", message? }`.
  const code = isRecord(body) && typeof body.error === 'string' ? body.error.toUpperCase() : 'REQUEST_FAILED';
  const message =
    status === 404
      ? 'The governance index has no record of this.'
      : status === 429 || status >= 500
        ? 'The governance index is unavailable right now. Try again shortly.'
        : `The governance index rejected this request (${code}).`;
  return new ApiError('index', status, code, message, body);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toProposal(row: unknown, dao: string): IndexedProposal {
  if (!isRecord(row)) throw malformed();
  const id = typeof row.id === 'string' ? row.id : typeof row.proposalId === 'string' ? row.proposalId : null;
  const rowDao = str(row.dao) ?? str(row.daoId);
  // A row for another DAO is never relabelled as the requested one.
  if (!id || !PROPOSAL_ID.test(id) || (rowDao !== null && rowDao !== dao)) throw malformed();
  const identity = isRecord(row.identity) ? row.identity : {};
  const chainId = typeof identity.chainId === 'number' ? identity.chainId : typeof row.chainId === 'number' ? row.chainId : null;
  return {
    dao,
    id,
    title: typeof row.title === 'string' && row.title.trim() ? row.title : `Proposal ${id}`,
    proposer: str(row.proposer),
    createdAt: str(row.createdAt),
    effectiveStatus: str(row.effectiveStatus),
    sourceState: str(row.sourceState) ?? str(row.state),
    forVotes: str(row.forVotes),
    againstVotes: str(row.againstVotes),
    abstainVotes: str(row.abstainVotes),
    quorumVotes: str(row.quorumVotes),
    description: typeof row.description === 'string' ? row.description : null,
    provenance: {
      origin: 'onchain',
      chainId,
      sourceContract: str(identity.governorAddress),
      // Some sources index without a creation block and report '0'; that is
      // "unknown", not the genesis block.
      createdBlock: str(row.createdBlock) === '0' ? null : str(row.createdBlock),
    },
  };
}

/**
 * Newest-first view of one bounded index page.
 *
 * TRANSITIONAL. The index orders proposals by proposal ID. For sequential IDs
 * (Nouns, Railgun) that is creation order; ENS proposal IDs are hashes, so its
 * first page is not its newest. This re-sorts ONE page of at most 100 rows by
 * `createdAt`. It is exact while a DAO has at most 100 proposals or sequential
 * IDs (true for every registered DAO today) and is not an aggregation layer.
 * Removed once the index serves `order=created_desc` (see
 * docs/web/ARCHITECTURE.md, "Two index facts").
 */
export function newestFirst(items: IndexedProposal[]): IndexedProposal[] {
  return [...items].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export function createIndexApi(baseUrl = '', fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): IndexApi {
  async function get(path: string, signal?: AbortSignal) {
    return requestJson('index', fetchImpl, baseUrl, 'GET', path, signal ? { signal } : {});
  }

  const PAGE_TTL_MS = 30_000;
  // Short-lived memo of validated proposal pages. ENS needs a full 100-row page
  // for newest-first (see `newestFirst`); without this, Home followed by the
  // DAO overview downloads it twice within seconds.
  const pages = new Map<string, { at: number; page: ProposalPage }>();
  const now = () => Date.now();

  return {
    async listDaos(signal) {
      const { status, body } = await get('/v1/daos', signal);
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      if (!isRecord(body) || !Array.isArray(body.items)) throw malformed();
      return body.items.filter(isRecord).flatMap((row) =>
        typeof row.id === 'string' && SAFE_DAO.test(row.id)
          ? [
              {
                id: row.id,
                name: typeof row.name === 'string' ? row.name : row.id,
                chainId: String(row.chainId ?? ''),
                governanceType: String(row.governanceType ?? ''),
                currentGovernor: String(row.currentGovernor ?? ''),
                updatedAt: str(row.updatedAt),
              },
            ]
          : [],
      );
    },

    async listProposals(dao, { limit = 10, signal } = {}) {
      if (!SAFE_DAO.test(dao)) throw new ApiError('index', 400, 'INVALID_DAO', 'Unknown DAO.', null, undefined, 'not_found');
      const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 10;
      const path = `/v1/daos/${dao}/proposals?limit=${bounded}`;
      const hit = pages.get(path);
      if (hit && now() - hit.at < PAGE_TTL_MS) return hit.page;
      const { status, body } = await get(path, signal);
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      if (!isRecord(body) || !Array.isArray(body.items)) throw malformed();
      const page = {
        items: body.items.map((row) => toProposal(row, dao)),
        nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
      };
      // Only successful, validated pages are kept, and only briefly: the index
      // itself is cached at the edge for ~45s, so this adds no extra staleness.
      pages.set(path, { at: now(), page });
      return page;
    },

    async getProposal(dao, id, signal) {
      if (!SAFE_DAO.test(dao) || !PROPOSAL_ID.test(id)) return null;
      const { status, body } = await get(`/v1/daos/${dao}/proposals/${id}`, signal);
      if (status === 404) return null;
      if (status < 200 || status >= 300) throw errorFrom(status, body);
      const proposal = toProposal(body, dao);
      // The index answered for a different proposal: refuse rather than relabel.
      if (proposal.id !== id) throw malformed();
      return proposal;
    },
  };
}
