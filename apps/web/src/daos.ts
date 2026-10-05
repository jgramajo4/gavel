/**
 * The DAO registry and capability model.
 *
 * A DAO is a first-class object addressed at /daos/:dao. What appears under it
 * is decided per DAO by its `capabilities` list:
 *
 *  - A `section` capability is a tab and a route (/daos/:dao/:segment).
 *  - A `feature` capability changes what a section shows (for example the
 *    Gate entry point on the overview); it gets no tab of its own.
 *
 * A capability a DAO does not list has no tab, no route, and no empty page.
 *
 * Adding a DAO: append an entry to DAOS. Global navigation, the DAO index, the
 * DAO shell, and the homepage preview all read this list; none of them names
 * a DAO.
 *
 * Adding a capability (Feed, Contracts, Streams, Delegates, ...): add it to
 * `CapabilityId` and `CAPABILITIES`, give it a renderer in `pages/DaoPage.tsx`,
 * and list it only on the DAOs whose backing Governance Indexer data exists.
 * Listing a capability before its data exists is how fake tabs happen.
 *
 * `indexId` is the Governance Indexer's DAO id and the only key used to fetch
 * data; the frontend never reads DAO contracts directly.
 */

export type CapabilityId = 'overview' | 'proposals' | 'gate';

export interface Capability {
  id: CapabilityId;
  label: string;
  kind: 'section' | 'feature';
  /** Path segment under /daos/:dao for sections. `null` is the DAO root. */
  segment: string | null;
}

export const CAPABILITIES: Record<CapabilityId, Capability> = {
  overview: { id: 'overview', label: 'Overview', kind: 'section', segment: null },
  proposals: { id: 'proposals', label: 'Recent proposals', kind: 'section', segment: 'proposals' },
  gate: { id: 'gate', label: 'Gate', kind: 'feature', segment: null },
};

export interface DaoDefinition {
  /** Route id. Lowercase, URL-safe, stable. */
  id: string;
  /** Governance Indexer DAO id. */
  indexId: string;
  name: string;
  /** One honest line about how this DAO governs. */
  summary: string;
  chainId: number;
  governance: string;
  /**
   * How the index orders this DAO's proposal ids. `sequential` ids are
   * creation order; `hashed` ids (OpenZeppelin Governor) are not, so newest-
   * first needs a full page. See `newestFirst` in index-api.ts.
   */
  proposalIds: 'sequential' | 'hashed';
  /** Ordered; the first entry must be `overview`. */
  capabilities: CapabilityId[];
}

export const DAOS: readonly DaoDefinition[] = [
  {
    id: 'nouns',
    indexId: 'nouns',
    name: 'Nouns',
    summary: 'Nouns DAO governor on Ethereum. One Noun, one vote.',
    chainId: 1,
    governance: 'Nouns governor',
    proposalIds: 'sequential',
    capabilities: ['overview', 'proposals', 'gate'],
  },
  {
    id: 'ens',
    indexId: 'ens',
    name: 'ENS',
    summary: 'ENS DAO OpenZeppelin Governor on Ethereum. Delegated $ENS voting.',
    chainId: 1,
    governance: 'OpenZeppelin Governor',
    proposalIds: 'hashed',
    capabilities: ['overview', 'proposals'],
  },
  {
    id: 'railgun',
    indexId: 'railgun-eth',
    name: 'Railgun',
    summary: 'Railgun voting contract on Ethereum. Staked RAIL governance.',
    chainId: 1,
    governance: 'Railgun voting',
    proposalIds: 'sequential',
    capabilities: ['overview', 'proposals'],
  },
];

const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Resolves a route param to a DAO, or `null`. Unknown ids never reach an API. */
export function findDao(id: string | undefined): DaoDefinition | null {
  if (!id || !ROUTE_ID.test(id)) return null;
  return DAOS.find((dao) => dao.id === id) ?? null;
}

export function hasCapability(dao: DaoDefinition, id: CapabilityId): boolean {
  return dao.capabilities.includes(id);
}

/** The tabs a DAO shows, in order. */
export function sectionsOf(dao: DaoDefinition): Capability[] {
  return dao.capabilities.map((id) => CAPABILITIES[id]).filter((capability) => capability.kind === 'section');
}

/** Resolves a section segment for a DAO, honouring what the DAO supports. */
export function findSection(dao: DaoDefinition, segment: string | undefined): Capability | null {
  if (segment === undefined) return CAPABILITIES.overview;
  return sectionsOf(dao).find((capability) => capability.segment === segment) ?? null;
}

/**
 * How many proposals the Recent proposals section shows. It is a bounded,
 * non-paginated recent view — never labelled as the complete list.
 */
export const RECENT_PROPOSALS = 25;

/** Page size that yields a correct newest-first view for this DAO. */
export function newestPageSize(dao: DaoDefinition, wanted: number): number {
  return dao.proposalIds === 'hashed' ? 100 : wanted;
}
