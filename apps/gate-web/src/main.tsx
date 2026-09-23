import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './session';
import { WalletConnectionProvider } from './wallet-connection';
import { EnsProvider, createEnsResolver } from './ens';
import { createGateApi } from './api';
import type { Eip1193Provider } from './wallet';
import './styles.css';

// The API origin is a deployment concern, not a compile-time constant, so the
// app works against a local server, a testnet deployment, or production with no
// code change. Same for the chain: it always comes from the server's quote.
const apiBaseUrl = import.meta.env.VITE_GATE_API_URL ?? '';

// ENS reverse resolution is display-only and entirely optional. It is on when
// the operator publishes a mainnet JSON-RPC endpoint, off otherwise — no key
// belongs in a browser bundle, and an unresolved address simply renders
// shortened. The server's generic `label` field always wins over this.
const ensResolver = createEnsResolver(import.meta.env.VITE_ENS_RPC_URL);

const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;

const missingWallet: Eip1193Provider = {
  async request() {
    throw new Error('No Ethereum wallet is available in this browser.');
  },
};

const wallet = injected ?? missingWallet;

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <EnsProvider resolver={ensResolver}>
        <SessionProvider>
          <WalletConnectionProvider provider={wallet}>
            <App api={createGateApi(apiBaseUrl)} wallet={wallet} />
          </WalletConnectionProvider>
        </SessionProvider>
      </EnsProvider>
    </BrowserRouter>
  </StrictMode>,
);
