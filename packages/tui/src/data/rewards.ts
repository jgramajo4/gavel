/**
 * Rewards contract reads. `clientBalance(38)` is free to read, so Gavel surfaces
 * the accumulated balance early — even though there's no withdraw UI until
 * clientId 38 is approved by a DAO proposal.
 */
import type { PublicClient } from 'viem';
import { ADDRESSES, CLIENT_ID } from '../constants.js';
import { rewardsAbi } from '../chain/abis.js';
import type { RewardsBalance } from '../types.js';

export async function fetchRewardsBalance(client: PublicClient): Promise<RewardsBalance> {
  const balance = (await client.readContract({
    address: ADDRESSES.Rewards as `0x${string}`,
    abi: rewardsAbi,
    functionName: 'clientBalance',
    args: [CLIENT_ID],
  })) as bigint;
  return {
    clientId: CLIENT_ID,
    balance,
    approved: false, // flips true once setClientApproval(38, true) lands
  };
}

