/**
 * Delegation action — the first signed tx in the build order. Builds and signs
 * a `delegate()` tx via the session key. No clientId (delegation is not a
 * rewards-eligible function).
 */
import type { PublicClient } from 'viem';
import { ADDRESSES } from '../constants.js';
import { nounsTokenAbi } from '../chain/abis.js';
import type { Signer } from '../chain/clients.js';
import type { TxResult } from './vote.js';

export async function delegateTo(
  publicClient: PublicClient,
  signer: Signer,
  delegatee: `0x${string}`,
): Promise<TxResult> {
  const hash = await signer.walletClient.writeContract({
    account: signer.walletClient.account!,
    chain: signer.walletClient.chain,
    address: ADDRESSES.NounsToken as `0x${string}`,
    abi: nounsTokenAbi,
    functionName: 'delegate',
    args: [delegatee],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return {
    hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
  };
}

export async function currentDelegate(
  publicClient: PublicClient,
  account: `0x${string}`,
): Promise<`0x${string}`> {
  return (await publicClient.readContract({
    address: ADDRESSES.NounsToken as `0x${string}`,
    abi: nounsTokenAbi,
    functionName: 'delegates',
    args: [account],
  })) as `0x${string}`;
}

