/** Navigation route model — a simple screen stack, no router lib needed. */
import type { Proposal, Attestation } from './types.js';

/**
 * `inbox` is the home route, not a DAO's proposal list.
 *
 * `daoProposals` carries which DAO it is scoped to, so opening one DAO is a
 * filter on the unified view rather than a different application.
 */
export type Route =
  | { screen: 'inbox' }
  | { screen: 'daoProposals'; dao: string }
  | { screen: 'detail'; proposal: Proposal }
  | { screen: 'settings' }
  | { screen: 'delegateLookup'; dao: string }
  | { screen: 'delegateSwitch'; dao: string }
  | { screen: 'passportFeed' }
  | { screen: 'passportDetail'; attestation: Attestation }
  | { screen: 'passportValidate' };

export type Screen = Route['screen'];
