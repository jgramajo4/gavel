/** Navigation route model — a simple screen stack, no router lib needed. */
import type { Proposal, Attestation } from './types.js';

export type Route =
  | { screen: 'list' }
  | { screen: 'detail'; proposal: Proposal }
  | { screen: 'delegateLookup' }
  | { screen: 'delegateSwitch' }
  | { screen: 'passportFeed' }
  | { screen: 'passportDetail'; attestation: Attestation }
  | { screen: 'passportValidate' };

export type Screen = Route['screen'];

