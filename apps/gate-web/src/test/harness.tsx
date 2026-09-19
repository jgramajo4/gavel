import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session';
import { WalletConnectionProvider } from '../wallet-connection';
import { EnsProvider, type EnsResolver } from '../ens';
import { createGateApi, type GateApi } from '../api';
import type { Eip1193Provider } from '../wallet';
import type { VerifiedSession } from '../types';

export interface StubRoute {
  method?: string;
  match: RegExp;
  status: number;
  body?: unknown;
}

/** A fetch stub that fails loudly on any request no test declared. */
export function stubFetch(routes: StubRoute[]): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    const route = routes.find(
      (candidate) => (candidate.method ?? 'GET').toUpperCase() === method && candidate.match.test(url),
    );
    if (!route) throw new Error(`unstubbed request: ${method} ${url}`);
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      json: async () => route.body ?? null,
    } as Response;
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

export function stubApi(routes: StubRoute[]): { api: GateApi; calls: string[] } {
  const fetchImpl = stubFetch(routes);
  return { api: createGateApi('', fetchImpl), calls: fetchImpl.calls };
}

export interface StubWallet extends Eip1193Provider {
  calls: { method: string; params?: unknown }[];
}

export function stubWallet(
  handlers: Record<string, (params?: unknown) => unknown> = {},
): StubWallet {
  const calls: { method: string; params?: unknown }[] = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unstubbed wallet method: ${method}`);
      return handler(params);
    },
  };
}

/** A resolver that answers from a fixed table and never touches the network. */
export function stubEnsResolver(names: Record<string, string> = {}): EnsResolver & {
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    async lookup(address: string) {
      lookups.push(address);
      return names[address] ?? names[address.toLowerCase()] ?? null;
    },
  };
}

export interface RenderAppOptions {
  route?: string;
  session?: VerifiedSession | null;
  /** Seeds the global wallet connection as if the header had connected. */
  walletAddress?: string | null;
  /** Wallet the global connection prompts. Defaults to one that refuses. */
  provider?: Eip1193Provider;
  /** Frontend ENS fallback. Absent means no resolution is attempted at all. */
  ens?: EnsResolver | null;
}

const NO_WALLET: Eip1193Provider = {
  async request() {
    throw new Error('No Ethereum wallet is available in this browser.');
  },
};

export function renderApp(ui: ReactElement, options: RenderAppOptions = {}): RenderResult {
  return render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <EnsProvider resolver={options.ens ?? null}>
        <SessionProvider initialSession={options.session ?? null}>
          <WalletConnectionProvider
            provider={options.provider ?? NO_WALLET}
            initialAddress={options.walletAddress ?? null}
          >
            {ui}
          </WalletConnectionProvider>
        </SessionProvider>
      </EnsProvider>
    </MemoryRouter>,
  );
}
