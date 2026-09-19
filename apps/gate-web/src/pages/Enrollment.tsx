import { useCallback, useState } from 'react';
import { GateApiError, type GateApi } from '../api';
import { useSession } from '../session';
import { useWalletConnection } from '../wallet-connection';
import { openWalletSession } from '../wallet-session';
import { ensureChain, isContractAccount, signTypedData, type Eip1193Provider } from '../wallet';
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
 * An externally owned account signs twice: the `dao_profile` session, then the
 * GateEnrollment payload. A contract wallet — a Safe — signs the same two, and
 * a third: the server holds a contract wallet to a Base payout-control proof
 * whenever it enrolls or moves back to `accepting_now`, because the Gate wallet
 * is the payout wallet and Gavel records the Base code hash it was proved
 * against. This page mirrors that rule rather than guessing at it: the account's
 * own code decides, and the proof is requested only when the server would
 * require it — sending one it did not ask for is itself a rejection.
 *
 * Nothing here decides that a Safe controls anything. The signature goes to the
 * server exactly as the wallet returned it and the account's own ERC-1271
 * `isValidSignature` answers on chain. An owner's EOA signature is never
 * accepted as the Safe's: the enrolled identity is the connected account, and
 * only that account's contract can authorize for it.
 *
 * The fact that the enrolling wallet is the payout wallet is stated as helper
 * text at the control it applies to rather than as paragraphs above the form: a
 * voter should reach the price and the stage switches immediately, and meet
 * each limitation where it bites.
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

/** The chain the SERVER bound a challenge to, never a constant in this file. */
function chainOf(domain: { chainId: number | string }): number {
  const chainId = Number(domain.chainId);
  if (!Number.isSafeInteger(chainId) || chainId < 1) {
    throw new Error('The server issued a challenge for a chain this app cannot read.');
  }
  return chainId;
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

  /**
   * The Base payout-control proof a contract wallet owes, and only when it owes
   * it.
   *
   * The server requires it on a first enrollment and on every transition back
   * into `accepting_now`, and refuses an update that carries one it did not
   * ask for — so the condition is read from the same published availability the
   * server compares against rather than assumed either way.
   */
  const proveBasePayoutControl = useCallback(
    async ({ account, requested }: { account: string; requested: Availability }) => {
      const existing = await api.getGate(account);
      const required =
        !existing || (requested === 'accepting_now' && existing.availability !== 'accepting_now');
      if (!required) return undefined;
      const challenge = await api.requestChallenge({
        proofType: 'BasePayoutControl',
        wallet: account,
        dao: 'nouns',
      });
      // Payout control is a Base fact and is signed under the Base domain the
      // server issued, which means moving the wallet to that chain first.
      await ensureChain(wallet, chainOf(challenge.domain));
      const signature = await signTypedData(wallet, account, {
        domain: challenge.domain,
        types: challenge.types,
        primaryType: challenge.primaryType,
        message: challenge.message,
      });
      return {
        typedData: {
          primaryType: challenge.primaryType,
          domain: challenge.domain,
          message: challenge.message,
        },
        signature,
      };
    },
    [api, wallet],
  );

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
          // A wallet already connected in the header is reused: this page asks
          // for signatures, never for a second connection.
          account: address,
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
        // The DAO chain is the server's, carried in the challenge it signed
        // over — never a constant here. Being on it is what makes both the
        // signature and the code read below answer for the right chain.
        await ensureChain(wallet, chainOf(enrollmentChallenge.domain));
        const enrollmentSignature = await signTypedData(wallet, account, {
          domain: enrollmentChallenge.domain,
          types: enrollmentChallenge.types,
          primaryType: enrollmentChallenge.primaryType,
          message: enrollmentChallenge.message,
        });

        // 3. A contract wallet also proves control of the Base payout address,
        //    on exactly the transitions the server demands it: a first
        //    enrollment, or a move back into `accepting_now`. An EOA is asked
        //    for nothing more, and an unrequested proof is refused by the
        //    server, so this asks the same question the server asks.
        const basePayoutControlProof = (await isContractAccount(wallet, account))
          ? await proveBasePayoutControl({ account, requested: availability })
          : undefined;

        const updated = await api.updateProfile(verified.token, {
          gateEnrollmentProof: {
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
          ...(basePayoutControlProof ? { basePayoutControlProof } : {}),
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
    [
      api,
      wallet,
      address,
      price,
      availability,
      acceptPreVote,
      acceptVoting,
      tags,
      setSession,
      noteConnected,
      proveBasePayoutControl,
    ],
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
          A contract wallet enrolls as itself: the Gate identity is the account you connect, proved
          by that account's own on-chain authority (ERC-1271). An owner's personal signature never
          stands in for it. A contract wallet is also asked for one extra signature, proving control
          of the same address on Base — where it will be paid — so it needs to be deployed there too.
        </p>
      </form>
    </div>
  );
}
