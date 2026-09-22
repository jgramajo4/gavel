#!/usr/bin/env node
/**
 * Gavel TUI entry.
 *
 * Loads the shared Gavel configuration, resolves a wallet view from it, and
 * hands off to Ink. Onboarding is decided by the config, not by a flag: a
 * runtime with no config lands in the wizard, and one that has been set up
 * lands in the inbox.
 *
 * The RPC preflight is advisory. A failing RPC is a degraded client, not a
 * refusal to start -- proposals come from the governance index, and settings
 * are exactly where a user needs to be when an endpoint is wrong.
 */
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { listWalletMethods, shortAddress } from '@gavel/core';
import { loadConfig, persistConfig, type Config } from './config.js';
import { makePublicClient } from './chain/clients.js';
import { App } from './App.js';
import type { WalletView } from './hooks/AppContext.js';

meow(
  `
  Usage
    $ gavel-tui

  Configuration
    Followed DAOs, wallet, execution mode and inference live in the shared
    Gavel config under GAVEL_DATA_DIR. The same settings are reachable from
    the CLI: gavel daos, gavel wallet, gavel readiness, gavel config.

  Environment
    GAVEL_DATA_DIR      Private data directory (default: ./data/private)
    RPC_URL             Ethereum RPC (default: https://eth.drpc.org)
    GAVEL_INDEX_API_URL Governance index base URL
    EAS_GRAPHQL_URL     EAS indexer override (optional)
`,
  { importMeta: import.meta, flags: {} },
);

/**
 * The wallet, as the UI sees it.
 *
 * Derived from config references only. Nothing here reads a key, a keystore
 * or a session secret: an address that was persisted is displayed, and
 * anything requiring authority is resolved at the point of use.
 */
function walletView(config: Config): WalletView {
  const wallet = config.gavel.wallet;
  const method = listWalletMethods({ env: process.env }).find((entry) => entry.type === wallet.type);
  const session = wallet.walletconnect?.session ?? null;
  const address = session?.account ?? config.gavel.identity.address ?? null;
  const expired = Boolean(session?.expiresAt && Date.parse(session.expiresAt) <= Date.now());
  return {
    type: wallet.type,
    label: method?.label ?? wallet.type,
    state: wallet.type === 'read-only' ? 'connected' : expired ? 'expired' : session || wallet.local ? 'connected' : 'disconnected',
    address: address ? shortAddress(address) : null,
    chainId: session?.chainId ?? null,
    canSign: wallet.type !== 'read-only' && !expired,
    sessionExpired: expired,
  };
}

async function main() {
  let config = await loadConfig();
  const publicClient = makePublicClient(config);

  try {
    await publicClient.getChainId();
  } catch (err) {
    process.stderr.write(
      `\n⚠ Could not reach RPC at ${config.rpcUrl}\n  ${err instanceof Error ? err.message : String(err)}\n` +
        `  Proposals still load from the governance index. Set RPC_URL to fix chain reads.\n\n`,
    );
  }

  const services = {
    config,
    publicClient,
    wallet: walletView(config),
    signer: null,
    updateConfig: async (next: Parameters<typeof persistConfig>[1]) => {
      config = await persistConfig(config, next);
      services.config = config;
      services.wallet = walletView(config);
      rerender();
    },
  };

  const { rerender: inkRerender } = render(<App services={services} />);
  function rerender() {
    inkRerender(<App services={{ ...services }} />);
  }
}

main().catch((err) => {
  process.stderr.write(`\nGavel crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
