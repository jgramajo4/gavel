import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveConfig } from './src/config';

// `@gavel/gate` is the frozen CommonJS domain package. The browser build reuses
// it verbatim — the Markdown allowlist and the EIP-3009 authorization derivation
// must never be reimplemented here — so it is pre-bundled explicitly.
export default defineConfig(({ command, mode }) => {
  // A built bundle must never ship without valid service origins: fail the
  // build, not the visitor. Every `vite build` is held to the production rule,
  // whatever `--mode` says, because any built bundle can be deployed. Same
  // validation the app runs at startup.
  if (command === 'build') {
    // Read env files from this app's root, the same place Vite inlines them
    // from, so validation and the bundle can never see different files.
    const root = fileURLToPath(new URL('.', import.meta.url));
    resolveConfig(loadEnv(mode, root, 'VITE_'), { production: true });
  }
  return {
    plugins: [react()],
    optimizeDeps: {
      include: ['@gavel/gate/src/markdown.js', '@gavel/gate/src/quote.js', '@gavel/gate/src/constants.js'],
    },
    // `@gavel/gate` resolves through a workspace symlink, so it lands outside
    // node_modules and the CommonJS plugin must be told to transform it.
    build: {
      commonjsOptions: {
        include: [/node_modules/, /packages[\\/]gate/],
        transformMixedEsModules: true,
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      server: { deps: { inline: [/packages[\\/]gate/] } },
    },
  };
});
