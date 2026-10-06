import { createContext, useContext, type ReactNode } from 'react';
import type { GateApi } from './gate-api';
import type { IndexApi } from './index-api';
import type { Eip1193Provider } from './wallet';

/**
 * The app's service boundary: one Gate client, one index client, one wallet
 * provider, all built once in `main.tsx` from `config.ts`. Pages read them
 * here; nothing below this line knows a hostname.
 */
export interface Services {
  gate: GateApi;
  index: IndexApi;
  wallet: Eip1193Provider;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const value = useContext(ServicesContext);
  if (!value) throw new Error('useServices requires a ServicesProvider');
  return value;
}
