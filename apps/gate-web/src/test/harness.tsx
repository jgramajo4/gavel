import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session';
import { WalletConnectionProvider } from '../wallet-connection';
import { createGateApi, type GateApi } from '../api';
import type { Eip1193Provider } from '../wallet';
import type { VerifiedSession } from '../types';

export interface StubRoute {
  method?: string;
  match: RegExp;
  status: number;
  body?: unknown | ((request: StubRequest) => unknown);
}

/** One request as it reached the wire: method, URL, headers, parsed JSON body. */
export interface StubRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stub that fails loudly on any request no test declared. */
export function stubFetch(
  routes: StubRoute[],
): typeof fetch & { calls: string[]; requests: StubRequest[] } {
  const calls: string[] = [];
  const requests: StubRequest[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    requests.push({
      method,
      url,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find(
      (candidate) => (candidate.method ?? 'GET').toUpperCase() === method && candidate.match.test(url),
    );
    if (!route) throw new Error(`unstubbed request: ${method} ${url}`);
    const request = requests[requests.length - 1];
    const responseBody = typeof route.body === 'function' ? route.body(request) : route.body;
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      json: async () => responseBody ?? null,
    } as Response;
  }) as typeof fetch & { calls: string[]; requests: StubRequest[] };
  impl.calls = calls;
  impl.requests = requests;
  return impl;
}

export function stubApi(routes: StubRoute[]): { api: GateApi; calls: string[]; requests: StubRequest[] } {
  const fetchImpl = stubFetch(routes);
  return { api: createGateApi('', fetchImpl), calls: fetchImpl.calls, requests: fetchImpl.requests };
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

export interface RenderAppOptions {
  route?: string;
  session?: VerifiedSession | null;
  /** Seeds the global wallet connection as if the header had connected. */
  walletAddress?: string | null;
  /** Wallet the global connection prompts. Defaults to one that refuses. */
  provider?: Eip1193Provider;
}

const NO_WALLET: Eip1193Provider = {
  async request() {
    throw new Error('No Ethereum wallet is available in this browser.');
  },
};

export function renderApp(ui: ReactElement, options: RenderAppOptions = {}): RenderResult {
  return render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <SessionProvider initialSession={options.session ?? null}>
        <WalletConnectionProvider
          provider={options.provider ?? NO_WALLET}
          initialAddress={options.walletAddress ?? null}
        >
          {ui}
        </WalletConnectionProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}
