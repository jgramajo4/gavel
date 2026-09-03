/**
 * Runtime configuration. `.env` supplies only non-secret endpoints; signing is disabled during the monorepo migration. Canonical execution will be injected later.
 */
import dotenv from 'dotenv';
import { DEFAULTS } from './constants.js';

dotenv.config();

export interface Config {
  rpcUrl: string;
  subgraphUrl: string;
  easGraphqlUrl: string;
  predictionUrl: string;
  /** Reserved for a future canonical wallet handoff; never loaded from environment here. */
  privateKey?: `0x${string}`;
}

export function loadConfig(): Config {
  return {
    rpcUrl: process.env.RPC_URL?.trim() || DEFAULTS.RPC_URL,
    subgraphUrl: process.env.SUBGRAPH_URL?.trim() || DEFAULTS.SUBGRAPH_URL,
    easGraphqlUrl: process.env.EAS_GRAPHQL_URL?.trim() || DEFAULTS.EAS_GRAPHQL_URL,
    predictionUrl: process.env.PREDICTION_URL?.trim() || DEFAULTS.PREDICTION_URL,
    privateKey: undefined,
  };
}

/** Direct signing is intentionally unavailable during the migration. */
export function canSign(config: Config): boolean {
  return Boolean(config.privateKey);
}

