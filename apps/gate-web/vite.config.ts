import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `@gavel/gate` is the frozen CommonJS domain package. The browser build reuses
// it verbatim — the Markdown allowlist and the EIP-3009 authorization derivation
// must never be reimplemented here — so it is pre-bundled explicitly.
export default defineConfig({
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
});
