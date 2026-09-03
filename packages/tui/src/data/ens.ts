/** ENS helpers — resolve name↔address via the public client (mainnet). */
import { isAddress, type PublicClient } from 'viem';
import { normalize } from 'viem/ens';

/** Resolve an ENS name or address string to a checksummed address, or null. */
export async function resolveToAddress(
  client: PublicClient,
  input: string,
): Promise<`0x${string}` | null> {
  const trimmed = input.trim();
  if (isAddress(trimmed)) return trimmed as `0x${string}`;
  if (!trimmed.includes('.')) return null;
  try {
    const addr = await client.getEnsAddress({ name: normalize(trimmed) });
    return addr ?? null;
  } catch {
    return null;
  }
}

/** Reverse-resolve an address to a primary ENS name, or null. */
export async function lookupEns(
  client: PublicClient,
  address: `0x${string}`,
): Promise<string | null> {
  try {
    return await client.getEnsName({ address });
  } catch {
    return null;
  }
}

