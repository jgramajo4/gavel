import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getAddress } from 'ethers';
import { connect, type Eip1193Provider } from './wallet';

/**
 * Global wallet *connection* — identity only, never authorization.
 *
 * This holds one thing: which account the browser wallet has authorized for
 * this tab. It is what the header renders and what every workflow can read
 * before it starts.
 *
 * What it deliberately is NOT:
 *
 *  - It is not a session. No token, challenge, signature, or nonce is stored
 *    here, and connecting signs nothing.
 *  - It does not collapse the three WalletSession roles. `dao_profile`,
 *    `dao_inbox`, and `base_sender` are still obtained separately, per
 *    workflow, through `openWalletSession`, and the server still scopes every
 *    route to exactly one of them. A connected wallet grants no route access.
 *  - It persists nothing. Like the session token, the connected address lives
 *    in React state for the life of the tab. There is no `localStorage`
 *    handshake and no silent `eth_accounts` probe on mount, so the app never
 *    touches the wallet until a person asks it to.
 *
 * When the wallet switches accounts the connection follows it; the role
 * sessions issued for the previous account are dropped by `WalletControl`,
 * because a token minted for one wallet must never sit behind another one's
 * identity in the header.
 */

export interface WalletConnectionValue {
  /** Checksummed account the wallet authorized, or `null`. */
  address: string | null;
  connecting: boolean;
  /** Last connection failure, in one readable sentence. */
  error: string | null;
  /** Prompts the wallet. Resolves to the connected address, or `null`. */
  connect(): Promise<string | null>;
  /**
   * Records an account a role-specific flow already authorized, so signing in
   * from enrollment or the inbox lights up the global header too.
   */
  noteConnected(address: string): void;
  disconnect(): void;
}

const WalletConnectionContext = createContext<WalletConnectionValue | null>(null);

function normalize(address: unknown): string | null {
  if (typeof address !== 'string') return null;
  try {
    return getAddress(address);
  } catch {
    return null;
  }
}

export function WalletConnectionProvider({
  provider,
  children,
  initialAddress = null,
}: {
  provider: Eip1193Provider;
  children: ReactNode;
  initialAddress?: string | null;
}) {
  const [address, setAddress] = useState<string | null>(() => normalize(initialAddress));
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The wallet is the source of truth for which account is live. A switch or a
  // revoke in the wallet is reflected here immediately rather than leaving a
  // stale identity in the header.
  useEffect(() => {
    if (!provider.on || !provider.removeListener) return;
    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? args[0] : [];
      setAddress(normalize(accounts[0]));
    };
    provider.on('accountsChanged', onAccountsChanged);
    return () => provider.removeListener?.('accountsChanged', onAccountsChanged);
  }, [provider]);

  const requestConnection = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const account = await connect(provider);
      setAddress(account);
      return account;
    } catch (cause: unknown) {
      // A user who dismissed the wallet prompt is not an error worth shouting
      // about; anything else gets the wallet's own sentence.
      setError(cause instanceof Error ? cause.message : 'The wallet did not authorize an account.');
      return null;
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const noteConnected = useCallback((account: string) => {
    const normalized = normalize(account);
    if (normalized) {
      setAddress(normalized);
      setError(null);
    }
  }, []);

  const disconnect = useCallback(() => {
    // Only this app's view of the connection is dropped. A browser wallet has
    // no revoke method a page may call, so nothing is claimed beyond that.
    setAddress(null);
    setError(null);
  }, []);

  const value = useMemo<WalletConnectionValue>(
    () => ({ address, connecting, error, connect: requestConnection, noteConnected, disconnect }),
    [address, connecting, error, requestConnection, noteConnected, disconnect],
  );

  return (
    <WalletConnectionContext.Provider value={value}>{children}</WalletConnectionContext.Provider>
  );
}

export function useWalletConnection(): WalletConnectionValue {
  const value = useContext(WalletConnectionContext);
  if (!value) throw new Error('useWalletConnection requires a WalletConnectionProvider');
  return value;
}
