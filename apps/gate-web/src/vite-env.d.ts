/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATE_API_URL?: string;
  /**
   * Optional mainnet JSON-RPC endpoint used for ENS reverse resolution only.
   * Public by construction — it ships in the browser bundle — so it must never
   * carry a secret key. Unset disables frontend resolution entirely.
   */
  readonly VITE_ENS_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
