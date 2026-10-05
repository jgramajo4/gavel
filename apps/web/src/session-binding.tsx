import { useEffect, useRef } from 'react';
import { useSession } from './session';
import { useWalletConnection } from './wallet-connection';

/**
 * Binds the in-memory role session to the live wallet connection, once, for
 * the whole app. Mounted by the shell, not by any widget, so it holds on every
 * route whether or not a given page renders the header control.
 *
 * Rules:
 *  - A session for wallet A is dropped as soon as the connection shows any
 *    other account. A token never sits behind another address's identity.
 *  - A session is dropped when a connection that existed goes away (the user
 *    disconnects, or the wallet locks / revokes and emits an empty account
 *    list). Reconnecting the same wallet does NOT restore it: signing
 *    readiness is never manufactured by a reconnect; the workflow signs again.
 *  - A session with no connection ever observed in this tab is left alone.
 *    Pages already refuse to act on it without a live matching account
 *    (Checkout's base_sender check), and this keeps deep-link reloads honest.
 *
 * Chain changes do not clear sessions: a WalletSession is bound to a role,
 * wallet and API audience, not to the wallet's current chain. Every
 * chain-bound action validates the chain it needs at its own boundary.
 *
 * The server stays authoritative; this is hygiene, not authorization.
 */
export function SessionWalletBinding() {
  const { address } = useWalletConnection();
  const { session, clearSession } = useSession();
  const sessionWallet = session?.session?.wallet?.toLowerCase() ?? null;
  const previous = useRef<string | null>(address);

  useEffect(() => {
    const had = previous.current;
    previous.current = address;
    if (!sessionWallet) return;
    if (address) {
      if (address.toLowerCase() !== sessionWallet) clearSession();
    } else if (had) {
      clearSession();
    }
  }, [address, sessionWallet, clearSession]);

  return null;
}
