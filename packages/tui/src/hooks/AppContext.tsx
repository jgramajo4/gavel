/** App-wide context: config, viem clients, wallet status. */
import React, { createContext, useContext } from 'react';
import type { PublicClient } from 'viem';
import type { GavelConfig } from '@gavel/core';
import type { Config } from '../config.js';
import type { Signer } from '../chain/clients.js';

/**
 * What the wallet looks like from a screen's point of view.
 *
 * A view model, not a provider: components render connection state and never
 * hold anything that can sign. The signing path is core's wallet provider,
 * reached through the execution adapter, not through a component.
 */
export interface WalletView {
  type: string;
  label: string;
  state: string;
  address: string | null;
  chainId: number | null;
  canSign: boolean;
  sessionExpired: boolean;
}

export interface AppServices {
  config: Config;
  /** Persist a config change and refresh every screen reading it. */
  updateConfig: (next: GavelConfig) => Promise<void>;
  publicClient: PublicClient;
  wallet: WalletView;
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
