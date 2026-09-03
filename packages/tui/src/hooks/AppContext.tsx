/** App-wide context: config, viem clients, optional signer. */
import React, { createContext, useContext } from 'react';
import type { PublicClient } from 'viem';
import type { Config } from '../config.js';
import type { Signer } from '../chain/clients.js';

export interface AppServices {
  config: Config;
  publicClient: PublicClient;
  signer: Signer | null;
}

const AppContext = createContext<AppServices | null>(null);

export function AppProvider({
  services,
  children,
}: {
  services: AppServices;
  children: React.ReactNode;
}) {
  return <AppContext.Provider value={services}>{children}</AppContext.Provider>;
}

export function useServices(): AppServices {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useServices must be used within AppProvider');
  return ctx;
}

