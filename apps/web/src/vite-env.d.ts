/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Gate API origin. Required in production builds. */
  readonly VITE_GAVEL_GATE_API_URL?: string;
  /** Governance Indexer origin. Required in production builds. */
  readonly VITE_GAVEL_INDEX_API_URL?: string;
  /** Removed in Issue 9; a build that still sets it fails (config.ts). */
  readonly VITE_GATE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
