/**
 * The Gavel Web route model. Every internal link is built here, so a route
 * move is one edit and a test, never a grep across pages.
 *
 *   /                                   Home
 *   /daos                               DAO index
 *   /daos/:dao                          DAO overview
 *   /daos/:dao/:capability              A DAO capability (see daos.ts)
 *   /daos/:dao/proposals/:id            A proposal
 *   /gate                               Gate directory
 *   /gate/voters/:wallet                Gate voter profile
 *   /gate/voters/:wallet/compose        Paid submission composer
 *   /gate/checkout/:publicId            Checkout
 *   /gate/inbox                         Private voter inbox
 *   /gate/enroll                        Voter enrollment
 *   /install                            How to use Gavel
 *
 * Reserved, not built: /me (My Governance), /feed (global cross-DAO feed).
 */

export const paths = {
  home: '/',
  daos: '/daos',
  dao: (dao: string) => `/daos/${encodeURIComponent(dao)}`,
  daoCapability: (dao: string, capability: string) =>
    `/daos/${encodeURIComponent(dao)}/${encodeURIComponent(capability)}`,
  proposal: (dao: string, id: string) => `/daos/${encodeURIComponent(dao)}/proposals/${encodeURIComponent(id)}`,
  gate: '/gate',
  gateVoter: (wallet: string) => `/gate/voters/${wallet}`,
  gateCompose: (wallet: string) => `/gate/voters/${wallet}/compose`,
  gateCheckout: (publicId: string) => `/gate/checkout/${encodeURIComponent(publicId)}`,
  gateInbox: '/gate/inbox',
  gateEnroll: '/gate/enroll',
  install: '/install',
} as const;

/** Route params are untrusted strings; a malformed wallet never reaches an API. */
export const WALLET_PARAM = /^0x[0-9a-fA-F]{40}$/;

/** Gate submission public id, the same shape the Gate server enforces. */
export const PUBLIC_ID_PARAM = /^[A-Za-z0-9_-]{22}$/;

/**
 * Maps a path from the retired Gate frontend (gate.0773h.com) to its canonical
 * Gavel Web route, or `null` when the path was never a Gate route.
 *
 * The edge redirect for the old host swaps the host and keeps path + query;
 * the old paths then land here on the canonical origin. Deterministic, pure,
 * and the only implementation of the mapping.
 *
 *   /                       -> /gate        (edge rule; the canonical / is Home)
 *   /gates/:wallet          -> /gate/voters/:wallet
 *   /gates/:wallet/compose  -> /gate/voters/:wallet/compose
 *   /checkout/:publicId     -> /gate/checkout/:publicId
 *   /inbox                  -> /gate/inbox
 *   /enroll                 -> /gate/enroll
 *
 * The query string is carried over unchanged. No Gate route reads it, and it
 * holds nothing secret (sessions never travel in URLs), so carrying it keeps
 * campaign links intact without granting anything.
 */
export function legacyGateTarget(pathname: string, search = ''): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const query = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : '';
  let match: RegExpMatchArray | null;
  if ((match = path.match(/^\/gates\/([^/]+)\/compose$/)) && WALLET_PARAM.test(match[1])) {
    return paths.gateCompose(match[1]) + query;
  }
  if ((match = path.match(/^\/gates\/([^/]+)$/)) && WALLET_PARAM.test(match[1])) {
    return paths.gateVoter(match[1]) + query;
  }
  if ((match = path.match(/^\/checkout\/([^/]+)$/)) && PUBLIC_ID_PARAM.test(match[1])) {
    return paths.gateCheckout(match[1]) + query;
  }
  if (path === '/inbox') return paths.gateInbox + query;
  if (path === '/enroll') return paths.gateEnroll + query;
  return null;
}
