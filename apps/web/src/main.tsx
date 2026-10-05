import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './session';
import { WalletConnectionProvider } from './wallet-connection';
import { createGateApi } from './gate-api';
import { createIndexApi } from './index-api';
import { ConfigError, resolveConfig, type GavelWebConfig } from './config';
import { ServicesProvider } from './services';
import type { Eip1193Provider } from './wallet';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

// The one place service origins are resolved. vite.config.ts already refuses
// to build a production bundle without valid origins; this is the runtime
// backstop, so a bad bundle shows an error instead of quietly talking to
// same-origin, staging, or a historical host. Chains never come from config:
// every chain-bound action reads it from the server (quote, challenge domain).
let config: GavelWebConfig;
try {
  config = resolveConfig(import.meta.env, { production: import.meta.env.PROD });
} catch (cause: unknown) {
  root.textContent = `Gavel Web is misconfigured: ${cause instanceof ConfigError ? cause.message : 'invalid configuration.'}`;
  throw cause;
}

const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;

const missingWallet: Eip1193Provider = {
  async request() {
    throw new Error('No Ethereum wallet is available in this browser.');
  },
};

// One wallet provider for the whole app. Every surface reads the connected
// account from WalletConnectionProvider; role sessions stay separate (session.tsx).
const wallet = injected ?? missingWallet;

const services = {
  gate: createGateApi(config.gateApiUrl),
  index: createIndexApi(config.indexApiUrl),
  wallet,
};

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ServicesProvider services={services}>
        <SessionProvider>
          <WalletConnectionProvider provider={wallet}>
            <App />
          </WalletConnectionProvider>
        </SessionProvider>
      </ServicesProvider>
    </BrowserRouter>
  </StrictMode>,
);
