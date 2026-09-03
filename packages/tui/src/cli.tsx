#!/usr/bin/env node
/**
 * Gavel TUI entry. Loads read-only config, runs a light RPC preflight, and
 * hands off to Ink. Canonical transaction preparation/wallet handoff is pending.
 */
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { loadConfig } from './config.js';
import { makePublicClient } from './chain/clients.js';
import { App } from './App.js';

const cli = meow(
  `
  Usage
    $ gavel-tui

  Environment
    RPC_URL             Ethereum RPC (default: https://eth.drpc.org)
    SUBGRAPH_URL        Nouns subgraph override (optional)
    EAS_GRAPHQL_URL     EAS indexer override (optional)
`,
  {
    importMeta: import.meta,
    flags: {},
  },
);

async function main() {
  const config = loadConfig();
  const publicClient = makePublicClient(config);
  const signer = null;

  // Light preflight: confirm the RPC answers. Non-fatal — the TUI surfaces
  // per-screen errors too, but a fast fail here is friendlier than a hang.
  try {
    await publicClient.getChainId();
  } catch (err) {
    process.stderr.write(
      `\n⚠ Could not reach RPC at ${config.rpcUrl}\n  ${err instanceof Error ? err.message : String(err)}\n\n` +
        `  Set RPC_URL in packages/tui/.env and retry.\n\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    'ℹ TUI migration mode: read-only. Canonical wallet handoff is not implemented yet.\n\n',
  );

  render(<App services={{ config, publicClient, signer }} />);
}

main().catch((err) => {
  process.stderr.write(`\nGavel crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
