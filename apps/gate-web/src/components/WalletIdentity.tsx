import { useEnsName } from '../ens';
import { shortenAddress } from '../format';

/**
 * One wallet, rendered the same way everywhere.
 *
 * The hierarchy is fixed:
 *
 *   ENS present   →  primary `voter.eth`, secondary `0x650C…50e1`
 *   ENS absent    →  primary `0x650C…50e1`, no secondary
 *
 * The full address is never printed twice, and outside a detail view it is
 * never printed in full at all: a 42-character hex string at the top of a card
 * is noise a reader cannot verify by eye anyway.
 *
 * The name is display only. Callers keep passing the canonical `address` to
 * every route, request, and signature — see `ens.tsx`.
 */
export function WalletIdentity({
  address,
  ens,
  className = '',
  tone = 'card',
}: {
  address: string;
  /** The server's indexed name, when the projection carries one. */
  ens?: string | null;
  className?: string;
  tone?: 'card' | 'header';
}) {
  const name = useEnsName(address, ens);
  const short = shortenAddress(address);
  return (
    <span className={`wallet-identity wallet-identity-${tone} ${className}`.trim()}>
      <span className="wallet-identity-primary" title={address}>
        {name ?? short}
      </span>
      {name ? <span className="wallet-identity-secondary">{short}</span> : null}
    </span>
  );
}
