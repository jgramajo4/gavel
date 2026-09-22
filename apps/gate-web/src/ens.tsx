import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { JsonRpcProvider, getAddress } from 'ethers';

/**
 * ENS reverse resolution — presentation only.
 *
 * Rules this module exists to enforce:
 *
 *  - **ENS is never identity.** Nothing here is used for authorization, API
 *    paths, quote material, or any security decision. Every route, every
 *    request body, and every signed payload keeps the canonical checksummed
 *    wallet address; a name is a label drawn next to it and nothing more.
 *  - **The server's value wins.** `PublicGateProfile.label` is the generic,
 *    server-owned display field. When it is present nothing is resolved in the
 *    browser at all. Frontend resolution is the fallback for addresses the
 *    server has no name for (the connected wallet in the header, for example).
 *  - **No secret key reaches the browser.** Resolution is opt-in deployment
 *    configuration (`VITE_ENS_RPC_URL`, a mainnet JSON-RPC endpoint the
 *    operator is willing to publish). With the variable unset the resolver is
 *    null, nothing is fetched, and every address simply renders shortened.
 *  - **No new dependency.** `ethers` is already the app's chain library.
 *
 * `lookupAddress` performs the reverse record *and* the forward check, so a
 * name is only returned when `name → address` agrees with `address → name`. A
 * reverse record alone is attacker-controlled text.
 */

export interface EnsResolver {
  lookup(address: string): Promise<string | null>;
}

/**
 * A conservative shape gate on the resolved label.
 *
 * Even a forward-verified name is a string an outsider chose. Restricting the
 * rendered set to lowercase ASCII labels keeps homoglyph and bidi-override
 * tricks out of a surface whose whole job is telling a payer who they are about
 * to pay. A name that fails this renders as the shortened address instead —
 * never as unverified text dressed up as an identity.
 */
const RENDERABLE_ENS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function isRenderableEnsName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 100 && RENDERABLE_ENS.test(name);
}

/**
 * Builds a resolver over a mainnet JSON-RPC endpoint, or `null` when none is
 * configured. Results — including misses — are cached for the tab so a
 * directory of twenty Gates costs at most twenty lookups, and concurrent
 * lookups for one address share a single request.
 */
export function createEnsResolver(rpcUrl?: string | null): EnsResolver | null {
  const url = typeof rpcUrl === 'string' ? rpcUrl.trim() : '';
  if (!/^https:\/\//i.test(url)) return null;
  // ENS lives on Ethereum mainnet. The chain is pinned so a misconfigured
  // endpoint cannot silently resolve names against some other network.
  const provider = new JsonRpcProvider(url, 1, { staticNetwork: true });
  const cache = new Map<string, Promise<string | null>>();
  return {
    lookup(address: string): Promise<string | null> {
      let key: string;
      try {
        key = getAddress(address);
      } catch {
        return Promise.resolve(null);
      }
      const cached = cache.get(key);
      if (cached) return cached;
      const pending = provider
        .lookupAddress(key)
        .then((name) => (isRenderableEnsName(name) ? name : null))
        // A resolution failure is a display miss, never an error a user sees.
        .catch(() => null);
      cache.set(key, pending);
      return pending;
    },
  };
}

const EnsContext = createContext<EnsResolver | null>(null);

export function EnsProvider({
  resolver = null,
  children,
}: {
  resolver?: EnsResolver | null;
  children: ReactNode;
}) {
  const value = useMemo(() => resolver, [resolver]);
  return <EnsContext.Provider value={value}>{children}</EnsContext.Provider>;
}

/**
 * The display name for an address, or `null`.
 *
 * `provided` is the server's own value and short-circuits everything: when the
 * indexed projection already carries a name, the browser resolves nothing.
 */
export function useEnsName(
  address: string | null | undefined,
  provided?: string | null,
): string | null {
  const resolver = useContext(EnsContext);
  const serverName = isRenderableEnsName(provided) ? provided : null;
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    setResolved(null);
    if (serverName || !address || !resolver) return;
    let cancelled = false;
    void resolver.lookup(address).then((name) => {
      if (!cancelled) setResolved(isRenderableEnsName(name) ? name : null);
    });
    return () => {
      cancelled = true;
    };
  }, [address, serverName, resolver]);

  return serverName ?? resolved;
}
