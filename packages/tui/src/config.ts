/**
 * Runtime configuration for the TUI.
 *
 * Two layers, deliberately separate:
 *
 *   Endpoints come from the environment. They are not secrets and they are not
 *   user preferences -- they are how this machine reaches the network.
 *
 *   Everything else comes from the Gavel config in GAVEL_DATA_DIR, loaded
 *   through `@gavel/core`. Followed DAOs, wallet type, execution mode,
 *   inference and notifications are configuration *semantics*, and they are
 *   shared with the CLI so a headless runtime sees exactly what the TUI sees.
 *
 * No key is ever loaded here. The old `privateKey` field is gone: signing is
 * reached through a wallet provider, which holds a reference to a signer the
 * host already has, never material of its own.
 */
import dotenv from 'dotenv';
import {
  loadGavelConfig,
  resolveIndexApiEndpoint,
  saveGavelConfig,
  type GavelConfig,
  type IndexApiEndpointMetadata,
} from '@gavel/core';
import { DEFAULTS } from './constants.js';

dotenv.config();

export interface Endpoints {
  rpcUrl: string;
  subgraphUrl: string;
  /** Governance index base URL; empty opts a DAO back to its own public source. */
  indexApiUrl: string;
  easGraphqlUrl: string;
  predictionUrl: string;
}

export interface Config extends Endpoints {
  /** The shared Gavel client configuration -- the same document the CLI reads. */
  gavel: GavelConfig;
  configPath: string;
  dataDir: string;
  /** Safe-to-render endpoint provenance. The effective URL is never included. */
  indexApiEndpoint: IndexApiEndpointMetadata;
  /** Migration notes from a legacy config, shown once on first launch. */
  migrationNotes: Array<{ at: string; code: string; message: string }>;
}

export function loadEndpoints(): Omit<Endpoints, 'indexApiUrl'> {
  return {
    rpcUrl: process.env.RPC_URL?.trim() || DEFAULTS.RPC_URL,
    subgraphUrl: process.env.SUBGRAPH_URL?.trim() || DEFAULTS.SUBGRAPH_URL,
    easGraphqlUrl: process.env.EAS_GRAPHQL_URL?.trim() || DEFAULTS.EAS_GRAPHQL_URL,
    predictionUrl: process.env.PREDICTION_URL?.trim() || DEFAULTS.PREDICTION_URL,
  };
}

function resolveTuiIndexEndpoint(config: GavelConfig): {
  url: string;
  metadata: IndexApiEndpointMetadata;
} {
  try {
    return resolveIndexApiEndpoint(config, process.env);
  } catch (error) {
    const metadata = error && typeof error === 'object' && 'metadata' in error
      ? (error.metadata as IndexApiEndpointMetadata)
      : { source: 'default', variable: null, status: 'invalid' } as const;
    return { url: '', metadata };
  }
}

export async function loadConfig(): Promise<Config> {
  const endpoints = loadEndpoints();
  const loaded = await loadGavelConfig({});
  const indexEndpoint = resolveTuiIndexEndpoint(loaded.config);
  return {
    ...endpoints,
    indexApiUrl: indexEndpoint.url,
    indexApiEndpoint: indexEndpoint.metadata,
    gavel: loaded.config,
    configPath: loaded.path,
    dataDir: loaded.dataDir,
    migrationNotes: loaded.notes,
  };
}

/** Persist a changed Gavel config and return the updated TUI config. */
export async function persistConfig(config: Config, next: GavelConfig): Promise<Config> {
  const saved = await saveGavelConfig(next, { dataDir: config.dataDir, file: config.configPath });
  const indexEndpoint = resolveTuiIndexEndpoint(saved.config);
  return {
    ...config,
    indexApiUrl: indexEndpoint.url,
    indexApiEndpoint: indexEndpoint.metadata,
    gavel: saved.config,
    migrationNotes: [],
  };
}

/** Whether onboarding still has to run before the main UI opens. */
export function needsOnboarding(config: Config): boolean {
  return !config.gavel.onboarding.completed;
}
