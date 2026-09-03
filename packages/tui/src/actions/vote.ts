/**
 * Vote actions — the first rewards-eligible signed flow. Every call passes
 * clientId 38 for reward attribution. Refundable votes rebate gas for the first
 * N votes on a proposal.
 */
import type { PublicClient } from 'viem';
import { ADDRESSES, CLIENT_ID, MAINNET_CHAIN_ID } from '../constants.js';
import { nounsDaoAbi } from '../chain/abis.js';
import type { Signer } from '../chain/clients.js';
import type { VoteSupport } from '../types.js';

export interface TxResult {
  hash: `0x${string}`;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  blockNumber: bigint;
}

/**
 * Cast a refundable vote. If `reason` is non-empty, uses
 * castRefundableVoteWithReason; otherwise castRefundableVote. Both include
 * clientId 38 as the trailing arg.
 */
export async function castVote(
  publicClient: PublicClient,
  signer: Signer,
  proposalId: number,
  support: VoteSupport,
  reason?: string,
): Promise<TxResult> {
  const trimmed = reason?.trim();
  const hash = trimmed
    ? await signer.walletClient.writeContract({
        account: signer.walletClient.account!,
        chain: signer.walletClient.chain,
        address: ADDRESSES.NounsDAO as `0x${string}`,
        abi: nounsDaoAbi,
        functionName: 'castRefundableVoteWithReason',
        args: [BigInt(proposalId), support, trimmed, CLIENT_ID],
      })
    : await signer.walletClient.writeContract({
        account: signer.walletClient.account!,
        chain: signer.walletClient.chain,
        address: ADDRESSES.NounsDAO as `0x${string}`,
        abi: nounsDaoAbi,
        functionName: 'castRefundableVote',
        args: [BigInt(proposalId), support, CLIENT_ID],
      });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return {
    hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
  };
}

/** Estimate gas for a vote — shown on the confirmation screen. */
export async function estimateVoteGas(
  publicClient: PublicClient,
  signer: Signer,
  proposalId: number,
  support: VoteSupport,
  reason?: string,
): Promise<bigint> {
  const trimmed = reason?.trim();
  try {
    if (trimmed) {
      return await publicClient.estimateContractGas({
        account: signer.address,
        address: ADDRESSES.NounsDAO as `0x${string}`,
        abi: nounsDaoAbi,
        functionName: 'castRefundableVoteWithReason',
        args: [BigInt(proposalId), support, trimmed, CLIENT_ID],
      });
    }
    return await publicClient.estimateContractGas({
      account: signer.address,
      address: ADDRESSES.NounsDAO as `0x${string}`,
      abi: nounsDaoAbi,
      functionName: 'castRefundableVote',
      args: [BigInt(proposalId), support, CLIENT_ID],
    });
  } catch {
    return 0n; // estimation can fail if not eligible; UI handles zero gracefully
  }
}

export const _chainId = MAINNET_CHAIN_ID;

