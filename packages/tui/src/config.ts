/**
 * Runtime configuration. `.env` supplies only non-secret endpoints; signing is disabled during the monorepo migration. Canonical execution will be injected later.
 */
import dotenv from 'dotenv';
import { DEFAULTS } from './constants.js';

dotenv.config();

export interface Config {
  rpcUrl: string;
  subgraphUrl: string;
  /** Governance index base URL; empty opts the proposal list back to the subgraph. */
  indexApiUrl: string;
  easGraphqlUrl: string;
  predictionUrl: string;
  /** Reserved for a future canonical wallet handoff; never loaded from environment here. */
  privateKey?: `0x${string}`;
}

export function loadConfig(): Config {
  return {
    rpcUrl: process.env.RPC_URL?.trim() || DEFAULTS.RPC_URL,
    subgraphUrl: process.env.SUBGRAPH_URL?.trim() || DEFAULTS.SUBGRAPH_URL,
    // Unset means the public index. Set but empty is the explicit opt-out back
    // to the subgraph, mirroring the CLI's `--endpoint`.
    indexApiUrl:
      process.env.GAVEL_INDEX_API_URL === undefined
        ? DEFAULTS.INDEX_API_URL
        : process.env.GAVEL_INDEX_API_URL.trim(),
    easGraphqlUrl: process.env.EAS_GRAPHQL_URL?.trim() || DEFAULTS.EAS_GRAPHQL_URL,
    predictionUrl: process.env.PREDICTION_URL?.trim() || DEFAULTS.PREDICTION_URL,
    privateKey: undefined,
  };
}

/** Direct signing is intentionally unavailable during the migration. */
export function canSign(config: Config): boolean {
  return Boolean(config.privateKey);
}

