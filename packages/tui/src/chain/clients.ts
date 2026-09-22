/**
 * viem clients.
 *
 * The public client reads chain state. There is deliberately no signer factory
 * here any more: the old `makeSigner()` built a wallet client from a private
 * key in configuration, which is exactly the pattern the wallet-provider
 * boundary replaces. Signing authority now comes from a wallet provider in
 * `@gavel/core`, which holds a reference to a signer the host already has.
 */
import { createPublicClient, http, type PublicClient, type WalletClient } from 'viem';
import { mainnet } from 'viem/chains';
import type { Config } from '../config.js';

export function makePublicClient(config: Config): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: http(config.rpcUrl),
  });
}

/**
 * A signer, once one has been attached.
 *
 * Supplied by the wallet layer; never constructed from configuration. The type
 * stays here because screens describe what they would do with one.
 */
export interface Signer {
  walletClient: WalletClient;
  address: `0x${string}`;
}

