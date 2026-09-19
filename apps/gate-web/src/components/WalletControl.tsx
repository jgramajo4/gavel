import { useCallback, useEffect, useRef, useState } from 'react';
import { useEnsName } from '../ens';
import { shortenAddress } from '../format';
import { useSession } from '../session';
import { useWalletConnection } from '../wallet-connection';

/**
 * The global wallet control in the application header.
 *
 * Disconnected → `Connect wallet`.
 * Connected    → `voter.eth`, or `0x650C…50e1` when there is no ENS name.
 *                Never the full address: the header has no room for one and a
 *                reader gains nothing from it.
 *
 * Connecting here establishes wallet *identity* and nothing else. The panel
 * says so out loud, and names which role-scoped session — if any — the tab
 * currently holds, because `dao_profile`, `dao_inbox`, and `base_sender` are
 * separate grants that each workflow still has to obtain by signing its own
 * challenge.
 *
 * Disconnecting drops the in-memory role session with the connection. So does
 * switching accounts in the wallet: a token issued for one address must never
 * outlive it behind another address's name.
 */
export function WalletControl() {
  const { address, connecting, error, connect, disconnect } = useWalletConnection();
  const { session, clearSession } = useSession();
  const name = useEnsName(address);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const sessionWallet = session?.session?.wallet ?? null;

  // A role session belongs to the account it was issued for. If the wallet
  // moves to another account, the token for the previous one is dropped rather
  // than left sitting behind a new identity. An absent connection is not a
  // mismatch — the explicit Disconnect below clears the session itself.
  useEffect(() => {
    if (!sessionWallet || !address) return;
    if (address.toLowerCase() !== sessionWallet.toLowerCase()) clearSession();
  }, [address, sessionWallet, clearSession]);

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
        aria-label={`Connected wallet ${name ?? shortenAddress(address)}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="wallet-control-dot" aria-hidden="true" />
        <span className="wallet-control-label">{name ?? shortenAddress(address)}</span>
      </button>
      {open ? (
        <div className="wallet-control-panel">
          {name ? <p className="wallet-control-name">{name}</p> : null}
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
