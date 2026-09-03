/**
 * viem clients. The public client reads chain state; the wallet client — created
 * only when a session key is present — signs and broadcasts.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import type { Config } from '../config.js';

export function makePublicClient(config: Config): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl),
  });
}

export interface Signer {
  walletClient: WalletClient;
  address: `0x${string}`;
}

/** Returns a signer, or null when no session key is set. */
export function makeSigner(config: Config): Signer | null {
  if (!config.privateKey) return null;
  const account = privateKeyToAccount(config.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(config.rpcUrl),
  });
  return { walletClient, address: account.address };
}

