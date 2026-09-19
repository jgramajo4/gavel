import { useCallback, useState } from 'react';
import { GateApiError, type GateApi } from '../api';
import { useSession } from '../session';
import { useWalletConnection } from '../wallet-connection';
import { openWalletSession } from '../wallet-session';
import { signTypedData, type Eip1193Provider } from '../wallet';
import { formatUsdc } from '../format';
import { WalletIdentity } from '../components/WalletIdentity';
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
 * could lose money to. That restriction, and the fact that the enrolling wallet
 * is the payout wallet, are stated as helper text at the control they apply to
 * rather than as paragraphs above the form: a voter should reach the price and
 * the stage switches immediately, and meet each limitation where it bites.
 *
 * The two stage flags are the voter's opt-in and are signed into the
 * GateEnrollment payload, so this form shows them rather than assuming them.
 * They are exactly the two the server supports (`acceptPreVote`,
 * `acceptVoting`), with the server's own rule that at least one must be on; no
 * other combination is offered, because no other combination exists.
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
  const { address, noteConnected } = useWalletConnection();
  const [availability, setAvailability] = useState<Availability>('accepting_now');
  const [acceptPreVote, setAcceptPreVote] = useState(true);
  const [acceptVoting, setAcceptVoting] = useState(true);
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
      // Mirrors the server rule so a voter learns about it before signing.
      if (!acceptPreVote && !acceptVoting) {
        setError('Choose at least one stage. A Gate that accepts neither stage cannot be enrolled.');
        return;
      }
      setBusy(true);
      try {
        // 1. Session challenge, signed on the DAO chain. Profile edits use the
        //    `dao_profile` role; the private inbox uses `dao_inbox` and the two
        //    are never interchangeable.
        const { account, verified } = await openWalletSession({
          api,
          provider: wallet,
          role: 'dao_profile',
        });
        // The header reflects the wallet that just authorized. The connection
        // is identity only; the `dao_profile` session above is the grant, and
        // it is still obtained by signing this page's own challenge.
        noteConnected(account);
        setSession(verified);

        // 2. GateEnrollment challenge and proof.
        const enrollmentChallenge = await api.requestChallenge({
          proofType: 'GateEnrollment',
          wallet: account,
          availability,
          dao: 'nouns',
          daoChainId: '1',
          acceptPreVote,
          acceptVoting,
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
    [api, wallet, price, availability, acceptPreVote, acceptVoting, tags, setSession, noteConnected],
  );

  return (
    <div className="page page-enrollment">
      <p className="eyebrow">Voter setup</p>
      <h1>Enroll your Gate</h1>
      <p className="page-intro">
        Set your attention price and choose when advocates can reach you. Payment buys your
        attention, never your vote.
      </p>

      <form className="enrollment" aria-label="Gate enrollment" onSubmit={submit}>
        <p className="enrollment-wallet">
          {address ? (
            <>
              <span className="enrollment-wallet-label">Enrolling</span>{' '}
              <WalletIdentity address={address} />
            </>
          ) : (
            <span className="enrollment-wallet-hint">
              Your wallet is asked to connect and sign when you submit.
            </span>
          )}
        </p>
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
          <p className="counter">
            Minimum 1.00 USDC, paid in full to the wallet you enroll with — your Gate wallet is your
            payout wallet and cannot be redirected. Gavel's fee is charged separately to the
            advocate.
          </p>
        </div>

        <fieldset className="field enrollment-stages">
          <legend>Requests you accept</legend>
          <p className="composer-note">Nouns has these two stages. Keep at least one on.</p>
          <label className="checkbox-row" htmlFor="enroll-pre-vote">
            <input
              id="enroll-pre-vote"
              type="checkbox"
              checked={acceptPreVote}
              onChange={(event) => setAcceptPreVote(event.target.checked)}
            />{' '}
            PRE_VOTE — proposal candidates seeking sponsorship
          </label>
          <label className="checkbox-row" htmlFor="enroll-voting">
            <input
              id="enroll-voting"
              type="checkbox"
              checked={acceptVoting}
              onChange={(event) => setAcceptVoting(event.target.checked)}
            />{' '}
            VOTING — proposals already open for a vote
          </label>
        </fieldset>
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
          <div role="status" className="notice notice-info">
            <p>
              Gate updated.{' '}
              {profile.acceptingSubmissions
                ? 'You are accepting paid attention requests now.'
                : 'You are not accepting paid attention requests right now.'}
            </p>
            <p>
              Availability: {profile.availability}
              {profile.policies?.[0]
                ? ` · Attention price ${formatUsdc(profile.policies[0].attentionAmount)} · Accepting ${
                    profile.policies[0].acceptedStages.join(' and ') || 'no stages'
                  }`
                : ''}
              .
            </p>
          </div>
        ) : null}

        <button type="submit" disabled={busy}>
          {busy ? 'Waiting for your wallet…' : 'Enroll Gate'}
        </button>
        <p className="counter enrollment-limits">
          Externally owned accounts (EOA) only. Contract wallets, including Safe, are not enabled in
          this deployment.
        </p>
      </form>
    </div>
  );
}
