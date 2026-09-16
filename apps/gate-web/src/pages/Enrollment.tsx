import { useCallback, useState } from 'react';
import { GateApiError, type GateApi } from '../api';
import { useSession } from '../session';
import { connect, signTypedData, type Eip1193Provider } from '../wallet';
import type { Availability, PublicGateProfile } from '../types';

/**
 * Wallet enrollment and Gate policy updates.
 *
 * The flow is exactly the merged server flow: a one-time challenge, a typed-data
 * wallet proof exchanged for a short-lived session, then a typed-data
 * GateEnrollment payload. There is no fallback authentication path: if the
 * server rejects a step, the rejection is shown and the flow stops.
 *
 * The MVP path proven end to end by the merged backend is an externally owned
 * account. Safe / ERC-1271 enrollment and the separate Base payout-control
 * proof exist in the server contract but are not offered here, because claiming
 * Safe support before the actual backend path succeeds would be a lie a voter
 * could lose money to.
 */

const USDC_SCALE = 1_000_000n;

function toAtomic(input: string): string | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const atomic = BigInt(whole) * USDC_SCALE + BigInt(fraction.padEnd(6, '0'));
  return atomic < USDC_SCALE ? null : atomic.toString();
}

export function Enrollment({ api, wallet }: { api: GateApi; wallet: Eip1193Provider }) {
  const { setSession } = useSession();
  const [availability, setAvailability] = useState<Availability>('accepting_now');
  const [price, setPrice] = useState('');
  const [tags, setTags] = useState('');
  const [profile, setProfile] = useState<PublicGateProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setProfile(null);
      const attentionAmount = toAtomic(price);
      if (!attentionAmount) {
        setError('Enter an attention price of at least 1.00 USDC, with at most six decimals.');
        return;
      }
      setBusy(true);
      try {
        const account = await connect(wallet);

        // 1. Session challenge, signed on the DAO chain.
        const sessionChallenge = await api.requestChallenge({
          proofType: 'WalletSession',
          wallet: account,
          role: 'dao_profile',
        });
        const sessionSignature = await signTypedData(wallet, account, {
          domain: sessionChallenge.domain,
          types: sessionChallenge.types,
          primaryType: sessionChallenge.primaryType,
          message: sessionChallenge.message,
        });
        const verified = await api.verifyProof({
          proofType: 'WalletSession',
          typedData: {
            primaryType: sessionChallenge.primaryType,
            domain: sessionChallenge.domain,
            message: sessionChallenge.message,
          },
          signature: sessionSignature,
        });
        setSession(verified);

        // 2. GateEnrollment challenge and proof.
        const enrollmentChallenge = await api.requestChallenge({
          proofType: 'GateEnrollment',
          wallet: account,
          availability,
          dao: 'nouns',
          daoChainId: '1',
          acceptPreVote: false,
          acceptVoting: true,
          attentionAmount,
        });
        const enrollmentSignature = await signTypedData(wallet, account, {
          domain: enrollmentChallenge.domain,
          types: enrollmentChallenge.types,
          primaryType: enrollmentChallenge.primaryType,
          message: enrollmentChallenge.message,
        });

        const updated = await api.updateProfile(verified.token, {
          gateEnrollmentProof: {
            proofType: 'GateEnrollment',
            typedData: {
              primaryType: enrollmentChallenge.primaryType,
              domain: enrollmentChallenge.domain,
              message: enrollmentChallenge.message,
            },
            signature: enrollmentSignature,
            publicTags: tags
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
          },
        });
        setProfile(updated);
      } catch (cause: unknown) {
        setError(
          cause instanceof GateApiError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : 'Enrollment failed.',
        );
      } finally {
        setBusy(false);
      }
    },
    [api, wallet, price, availability, tags, setSession],
  );

  return (
    <div className="page page-enrollment">
      <h1>Enroll your Gate</h1>
      <p className="page-intro">
        Your Gate wallet is your payout wallet. The full attention price is paid to the wallet you
        enroll with, and it cannot be redirected to another address.
      </p>
      <p className="page-intro">
        This experimental deployment enrolls externally owned accounts (EOA) only. Contract wallets,
        including Safe, are not enabled here.
      </p>

      <form className="enrollment" aria-label="Gate enrollment" onSubmit={submit}>
        <div className="field">
          <label htmlFor="enroll-availability">Availability</label>
          <select
            id="enroll-availability"
            value={availability}
            onChange={(event) => setAvailability(event.target.value as Availability)}
          >
            <option value="accepting_now">Accepting now</option>
            <option value="paused">Paused</option>
            <option value="closed">Closed</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="enroll-price">Attention price (USDC)</label>
          <input id="enroll-price" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="enroll-tags">Public tags (comma separated)</label>
          <input id="enroll-tags" value={tags} onChange={(event) => setTags(event.target.value)} />
        </div>

        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : null}
        {profile ? (
          <p role="status" className="notice notice-info">
            Gate updated. Availability: {profile.availability}.
          </p>
        ) : null}

        <button type="submit" disabled={busy}>
          Enroll Gate
        </button>
      </form>
    </div>
  );
}
