import { useCallback, useEffect, useRef, useState } from 'react';
import { shortenAddress } from '../format';
import { useSession } from '../session';
import { useWalletConnection } from '../wallet-connection';

/**
 * The global wallet control in the application header.
 *
 * Disconnected → `Connect wallet`.
 * Connected    → shortened wallet address. The server's verified Gate label is
 *                rendered only on Gate profiles, never independently resolved
 *                in the header.
 *
 * Connecting here establishes wallet *identity* and nothing else. The panel
 * says so out loud, and names which role-scoped session — if any — the tab
 * currently holds, because `dao_profile`, `dao_inbox`, and `base_sender` are
 * separate grants that each workflow still has to obtain by signing its own
 * challenge.
 *
 * Disconnecting drops the in-memory role session with the connection. Account
 * switches and wallet locks are handled app-wide by `SessionWalletBinding`.
 */
export function WalletControl() {
  const { address, connecting, error, connect, disconnect } = useWalletConnection();
  const { session, clearSession } = useSession();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Session-to-wallet binding (account switch, wallet lock) lives in
  // `SessionWalletBinding`, mounted once by the shell.

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const onConnect = useCallback(async () => {
    await connect();
  }, [connect]);

  const onDisconnect = useCallback(() => {
    clearSession();
    disconnect();
    setOpen(false);
  }, [clearSession, disconnect]);

  if (!address) {
    return (
      <div className="wallet-control" ref={rootRef}>
        <button
          type="button"
          className="wallet-control-trigger wallet-control-connect"
          onClick={onConnect}
          disabled={connecting}
        >
          {connecting ? 'Connecting…' : 'Connect wallet'}
        </button>
        {error ? (
          <p role="alert" className="wallet-control-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="wallet-control" ref={rootRef}>
      <button
        type="button"
        className="wallet-control-trigger wallet-control-connected"
        aria-expanded={open}
        aria-label={`Connected wallet ${shortenAddress(address)}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="wallet-control-dot" aria-hidden="true" />
        <span className="wallet-control-label">{shortenAddress(address)}</span>
      </button>
      {open ? (
        <div className="wallet-control-panel">
          <p className="wallet-control-address">{shortenAddress(address)}</p>
          <p className="wallet-control-note">
            {session
              ? `Signed in for ${session.session.role} on this wallet.`
              : 'Wallet connected. Each workflow still asks you to sign for its own session.'}
          </p>
          <button type="button" className="wallet-control-disconnect" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      ) : null}
    </div>
  );
}
