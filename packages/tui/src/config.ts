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
  saveGavelConfig,
  type GavelConfig,
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
  /** Migration notes from a legacy config, shown once on first launch. */
  migrationNotes: Array<{ at: string; code: string; message: string }>;
}

export function loadEndpoints(): Endpoints {
  return {
    rpcUrl: process.env.RPC_URL?.trim() || DEFAULTS.RPC_URL,
    subgraphUrl: process.env.SUBGRAPH_URL?.trim() || DEFAULTS.SUBGRAPH_URL,
    // Unset means the public index. Set but empty is the explicit opt-out back
    // to a per-DAO source, mirroring the CLI's `--endpoint`.
    indexApiUrl:
      process.env.GAVEL_INDEX_API_URL === undefined
        ? DEFAULTS.INDEX_API_URL
        : process.env.GAVEL_INDEX_API_URL.trim(),
    easGraphqlUrl: process.env.EAS_GRAPHQL_URL?.trim() || DEFAULTS.EAS_GRAPHQL_URL,
    predictionUrl: process.env.PREDICTION_URL?.trim() || DEFAULTS.PREDICTION_URL,
  };
}

export async function loadConfig(): Promise<Config> {
  const endpoints = loadEndpoints();
  const loaded = await loadGavelConfig({});
  return {
    ...endpoints,
    // A config-level index override wins over the environment, so a runtime
    // that configured one in the wizard does not have to also export it.
    indexApiUrl: loaded.config.runtime.indexApiUrl ?? endpoints.indexApiUrl,
    gavel: loaded.config,
    configPath: loaded.path,
    dataDir: loaded.dataDir,
    migrationNotes: loaded.notes,
  };
}

/** Persist a changed Gavel config and return the updated TUI config. */
export async function persistConfig(config: Config, next: GavelConfig): Promise<Config> {
  const saved = await saveGavelConfig(next, { dataDir: config.dataDir, file: config.configPath });
  return { ...config, gavel: saved.config, migrationNotes: [] };
}

/** Whether onboarding still has to run before the main UI opens. */
export function needsOnboarding(config: Config): boolean {
  return !config.gavel.onboarding.completed;
}
