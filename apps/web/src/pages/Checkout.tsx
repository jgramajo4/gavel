import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError } from '../http';
import { freezeQuote, type GateApi } from '../gate-api';
import { useSession } from '../session';
import { useWalletConnection } from '../wallet-connection';
import { baseSenderState, openWalletSession, type BaseSenderState } from '../wallet-session';
import { SettlementState } from '../components/SettlementState';
import { formatExpiryDateTime, formatUsdc, sumAtomic } from '../format';
import { isQuotePayable, payQuote, resolveAccount, type Eip1193Provider, type PaymentPhase } from '../wallet';
import type { IssuedQuote, PublicReceiptState, SubmissionReceipt } from '../types';

/**
 * Checkout over an immutable, server-issued quote.
 *
 * Everything shown and everything signed comes from the persisted quote. There
 * is no editable field, no refresh, no expiry extension, and no way for this
 * page to alter the voter, fee, token, splitter, amount, quote ID, or
 * submission hash — those are covered by the server's EIP-712 signature and any
 * change would simply fail on chain.
 *
 * Payment is a single EIP-3009 `receiveWithAuthorization` authorization
 * consumed by a single `settle` call on the splitter. There is no ERC-20
 * approve path, and no USDC ever moves to a Gavel-operated server address.
 *
 * Posting the transaction hash returns 202 and means only that the hint was
 * recorded. Acceptance is displayed strictly when the public status endpoint
 * says `accepted`.
 *
 * React state and `history.state` are display caches, never payment authority.
 * Pressing Pay re-fetches the owner-bound persisted quote from the frozen
 * resume endpoint and pays THAT object, so a tampered tab cannot get a mutated
 * amount, splitter, or chain in front of the wallet. Resume issues nothing,
 * signs nothing, and extends nothing.
 *
 * Every settlement step — resume, sign, broadcast, record — runs only for an
 * explicit Base sender: a live `base_sender` WalletSession for the account the
 * wallet is connected to right now, which must also be the quote's payer. The
 * target voter, an enrollment or inbox session, a bare connected address, or a
 * session left behind by a switched or disconnected wallet never stands in for
 * it; each of those renders a correction state and touches neither the API nor
 * the wallet. The server enforces the same role and ownership independently.
 */

const TERMINAL: PublicReceiptState[] = ['accepted', 'expired', 'rejected_by_policy', 'malformed'];

/**
 * Thrown inside a payment attempt whose authority changed while it was in
 * flight. Never shown to the user directly and never treated as a server or
 * wallet verdict.
 */
class AttemptCancelled extends Error {
  constructor() {
    super('payment attempt cancelled');
    this.name = 'AttemptCancelled';
  }
}

const CANCELLED_MESSAGE =
  'The wallet or session changed, so this payment attempt was cancelled. Nothing was signed or sent. Sign in again to continue.';

/*
 * Once the wallet has been asked to send the transaction, nothing this page
 * does can recall it, and "nothing was sent" is no longer a safe statement:
 * the wallet may submit it whether or not it ever answers, and an error after
 * the request does not prove it never reached the network. These say so.
 */
const BROADCAST_CANCELLED_MESSAGE =
  'The wallet or session changed after your wallet was asked to send the payment transaction. It may still be sent; this page cannot recall it. Gavel was not notified from this page, and Gate verifies settlement on chain. Check your wallet’s activity before paying again.';
const LATE_HASH_MESSAGE =
  'The wallet or session changed after your wallet was asked to send the payment, so Gavel was not notified from this page. Your wallet then returned the transaction hash below; keep it. Gate verifies settlement on chain.';
const OUTCOME_UNKNOWN_MESSAGE =
  'Your wallet did not confirm whether the payment transaction was sent. It may or may not have reached the network. Check your wallet’s activity before paying again; Gate verifies settlement on chain, and this quote can be settled only once.';
const DECLINED_AFTER_REQUEST_MESSAGE =
  'Your wallet reported that you declined the transaction, so it was not sent.';

/**
 * The last transaction this page asked the wallet to send, kept as evidence.
 * `requested`: asked, no answer yet — the outcome is unknown and may stay so.
 * `sent`: the wallet returned this hash. `unknown`: the request ended without
 * a hash and without a user rejection. `declined`: the wallet answered with an
 * EIP-1193 user rejection (4001), the one answer that establishes it was not
 * sent. Settlement itself is only ever what Gate verifies on chain.
 */
interface BroadcastRecord {
  attempt: number;
  status: 'requested' | 'sent' | 'unknown' | 'declined';
  txHash?: string;
}

/** EIP-1193 user rejection: the wallet established that it did not send. */
function isWalletRejectionCode(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 4001 || code === 'ACTION_REJECTED';
}

function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const message = error instanceof Error ? error.message : '';
  return /user (rejected|denied)|rejected the request|cancell?ed/i.test(message);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Why settlement cannot proceed yet, in one correctable sentence. */
function senderProblem(state: BaseSenderState, payer: string | null): string | null {
  const who = payer ? `the Base sender wallet ${payer}` : 'the Base sender wallet that requested this quote';
  switch (state.status) {
    case 'disconnected':
      return `Checkout needs ${who}. Connect it to continue.`;
    case 'unsigned':
      return `Sign in with ${who} to continue. A voter, enrollment, or inbox session cannot pay a quote.`;
    case 'expired':
      return `Your Base sender session expired. Sign in with ${who} again to continue.`;
    case 'mismatch':
      return `The connected wallet is not the Base sender you signed in with (${state.sender}). Switch back to it, or sign in again.`;
    case 'ready':
      return payer && !sameAddress(payer, state.sender)
        ? `This quote was issued to ${payer}, not the signed-in Base sender ${state.sender}. Switch your wallet to ${payer} and sign in again.`
        : null;
  }
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="field-row" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export interface CheckoutProps {
  api: GateApi;
  wallet: Eip1193Provider;
  receipt?: SubmissionReceipt;
  publicId?: string;
  onResume?(receipt: SubmissionReceipt): void;
  pollIntervalMs?: number;
  /** Injectable clock in milliseconds, so expiry behaviour is deterministic. */
  now?: () => number;
}

export function Checkout({
  api,
  wallet,
  receipt,
  publicId,
  onResume,
  pollIntervalMs = 4000,
  now = Date.now,
}: CheckoutProps) {
  const { session, setSession, clearSession } = useSession();
  const { address, connect, noteConnected } = useWalletConnection();
  const [quote, setQuote] = useState<IssuedQuote | null>(receipt?.quote ? freezeQuote(receipt.quote) : null);
  const [id, setId] = useState<string | null>(receipt?.publicId ?? publicId ?? null);
  const [state, setState] = useState<PublicReceiptState>(receipt?.state ?? 'payment_required');
  const [phase, setPhase] = useState<PaymentPhase>('idle');
  const [broadcast, setBroadcastState] = useState<BroadcastRecord | null>(null);
  // Mirrors `broadcast` so async continuations can check which attempt owns it.
  const broadcastRef = useRef<BroadcastRecord | null>(null);
  const setBroadcast = useCallback((next: BroadcastRecord) => {
    broadcastRef.current = next;
    setBroadcastState(next);
  }, []);
  const txHash = broadcast?.txHash;
  const [acceptedAt, setAcceptedAt] = useState<string | undefined>(receipt?.acceptedAt);
  const [error, setError] = useState<string | null>(null);
  const [notRecoverable, setNotRecoverable] = useState(false);
  const [busy, setBusy] = useState(false);
  const polling = useRef(false);

  const sender = baseSenderState(session, address, Math.floor(now() / 1000));
  const payer = quote?.message.payer ?? null;
  const problem = senderProblem(sender, payer);
  // Only an explicit, live Base sender that owns this quote may resume or pay.
  const senderSession = sender.status === 'ready' && problem === null ? sender.session : null;
  const senderToken = senderSession?.token ?? null;

  /*
   * Attempt cancellation. A payment attempt captures the authority it started
   * with (session token, connected account, payer) and then awaits the server
   * and the wallet. If that authority changes in the meantime — disconnect,
   * wallet lock, account switch, session cleared or replaced, a different
   * payer, unmount — the attempt is dead: it may not request a signature,
   * broadcast, record a settlement hint, or report success.
   *
   * `generation` is bumped synchronously on every such change; an attempt
   * checks it after each await and immediately before signing and
   * broadcasting. The backend stays authoritative; this only stops a stale
   * continuation from acting after the user withdrew or changed authority.
   */
  const generation = useRef(0);
  const inFlight = useRef<{ generation: number; sender: string; broadcastRequested: boolean } | null>(null);
  const mounted = useRef(true);
  const invalidate = useCallback(() => {
    generation.current += 1;
    if (inFlight.current && mounted.current) {
      const requested = inFlight.current.broadcastRequested;
      inFlight.current = null;
      // The stale attempt may still be awaiting a response that never comes;
      // give the user a recoverable state now rather than when it resolves.
      setBusy(false);
      if (requested) {
        // Past the point of no return: keep the "waiting for the wallet"
        // state and never claim nothing was sent.
        setError(BROADCAST_CANCELLED_MESSAGE);
      } else {
        setPhase('idle');
        setError(CANCELLED_MESSAGE);
      }
    }
    inFlight.current = null;
  }, []);
  const authority = senderSession
    ? `${senderSession.token}|${senderSession.session.wallet.toLowerCase()}|${(address ?? '').toLowerCase()}|${(payer ?? '').toLowerCase()}`
    : null;
  // Layout effect: commits run synchronously with the change that caused them,
  // so no awaited continuation can observe the old authority in between.
  useLayoutEffect(() => {
    invalidate();
  }, [authority, invalidate]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [invalidate]);
  // Wallet events reach React through a scheduled render. Listen directly as
  // well, so a lock or switch cancels the attempt at the moment it happens.
  useEffect(() => {
    if (!wallet.on || !wallet.removeListener) return;
    const onAccounts = (accounts: unknown) => {
      const attempt = inFlight.current;
      if (!attempt) return;
      const next = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
      if (!next || !sameAddress(next, attempt.sender)) invalidate();
    };
    const onDisconnect = () => {
      if (inFlight.current) invalidate();
    };
    wallet.on('accountsChanged', onAccounts);
    wallet.on('disconnect', onDisconnect);
    return () => {
      wallet.removeListener?.('accountsChanged', onAccounts);
      wallet.removeListener?.('disconnect', onDisconnect);
    };
  }, [wallet, invalidate]);

  // Recovery path: a reload, or a duplicate, lands here with only a public ID.
  // Resume returns the ORIGINAL quote; it issues nothing and refreshes nothing.
  useEffect(() => {
    if (quote || !publicId || !senderToken) return;
    let cancelled = false;
    api
      .resumeSubmission(senderToken, `/v1/submissions/${publicId}/resume`)
      .then((resumed) => {
        if (cancelled) return;
        if (!resumed) {
          // Owner-bound resume answers 404 for a quote this Base sender did
          // not request (or that does not exist). Say so instead of spinning.
          setNotRecoverable(true);
          return;
        }
        setNotRecoverable(false);
        setError(null);
        setId(resumed.publicId);
        setState(resumed.state);
        if (resumed.acceptedAt) setAcceptedAt(resumed.acceptedAt);
        if (resumed.quote) setQuote(freezeQuote(resumed.quote));
        onResume?.(resumed);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) {
          clearSession();
          setError('Your Base sender session is no longer valid. Sign in with wallet again to continue.');
          return;
        }
        setError(cause instanceof ApiError ? cause.message : 'This quote could not be recovered.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, senderToken, publicId, quote, onResume, clearSession]);

  const signIn = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      // The intended and only way to establish a Base sender: sign this
      // role's own challenge with the connected wallet.
      const { account, verified } = await openWalletSession({
        api,
        provider: wallet,
        role: 'base_sender',
        account: address,
      });
      noteConnected(account);
      setSession(verified);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Wallet sign-in failed. No session was created.');
    } finally {
      setBusy(false);
    }
  }, [api, wallet, address, noteConnected, setSession]);

  // A ready Base sender that is not this quote's payer: the only correction
  // is a base_sender session for the payer itself. Resolve the wallet account
  // first and refuse to sign unless it IS the payer, so this can never mint a
  // session for yet another account.
  const signInAsPayer = useCallback(async () => {
    if (!payer) return;
    setError(null);
    setBusy(true);
    try {
      let account: string;
      try {
        account = await resolveAccount(wallet, payer);
      } catch {
        setError(`Switch your wallet to ${payer}, then press "Sign in as payer" again. Nothing was signed.`);
        return;
      }
      if (!sameAddress(account, payer)) {
        noteConnected(account);
        setError(`The wallet authorized ${account}, not the payer ${payer}. Switch to ${payer} and try again. Nothing was signed.`);
        return;
      }
      const { account: signed, verified } = await openWalletSession({
        api,
        provider: wallet,
        role: 'base_sender',
        account,
      });
      noteConnected(signed);
      // openWalletSession resolves the account again, so the wallet may have
      // moved between the check above and the signature. Only a base_sender
      // session for the payer itself may become the Checkout sender; anything
      // else is dropped, never reinterpreted as the payer.
      const signedWallet = verified?.session?.wallet;
      if (
        verified?.session?.role !== 'base_sender' ||
        typeof signedWallet !== 'string' ||
        !sameAddress(signedWallet, payer)
      ) {
        setError(
          `The wallet signed in as ${typeof signedWallet === 'string' ? signedWallet : 'another account'}, not the payer ${payer}. That session was discarded. Switch your wallet to ${payer} and press "Sign in as payer" again. Nothing was paid.`,
        );
        return;
      }
      setSession(verified);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Wallet sign-in failed. No session was created.');
    } finally {
      setBusy(false);
    }
  }, [api, wallet, payer, noteConnected, setSession]);

  const pollStatus = useCallback(async () => {
    if (!id || polling.current) return;
    polling.current = true;
    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        // Wait first: the server needs time to observe and verify the
        // transaction, and a status read taken the instant after broadcast is
        // just the pre-payment state read back.
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        const status = await api.getStatus(id);
        if (status) {
          setState(status.state);
          if (status.acceptedAt) setAcceptedAt(status.acceptedAt);
          if (TERMINAL.includes(status.state)) return;
        }
      }
    } catch {
      // A polling failure is not a verdict. The coarse state simply stands.
    } finally {
      polling.current = false;
    }
  }, [api, id, pollIntervalMs]);

  const pay = useCallback(async () => {
    if (!quote || !id) return;
    if (!senderSession) {
      setError(problem ?? 'Sign in with the Base sender wallet before paying. Nothing was signed or sent.');
      return;
    }
    const baseSender = senderSession.session.wallet;
    const attempt = generation.current;
    inFlight.current = { generation: attempt, sender: baseSender, broadcastRequested: false };
    let broadcastRequested = false;
    /** True while the retained broadcast record still belongs to this attempt. */
    const ownsRecord = () => broadcastRef.current?.attempt === attempt && mounted.current;
    /** Throws once this attempt's authority has changed. */
    const live = () => {
      if (generation.current !== attempt) throw new AttemptCancelled();
    };
    let broadcastHash: string | null = null;
    setError(null);
    setBusy(true);
    try {
      // 1. Re-authorize. The rendered quote is a display cache; the persisted,
      //    owner-bound quote is the only thing that may reach the wallet.
      const authoritative = await api.resumeSubmission(senderSession.token, `/v1/submissions/${id}/resume`);
      live();
      if (!authoritative) {
        setPhase('failed');
        setError('This quote could not be confirmed with the server. Nothing was signed or sent.');
        return;
      }
      setState(authoritative.state);
      if (authoritative.acceptedAt) setAcceptedAt(authoritative.acceptedAt);
      if (!authoritative.quote || authoritative.state !== 'payment_required') {
        // Expired or otherwise non-payable. Never reissue, refresh, or extend.
        setPhase('idle');
        return;
      }
      const payable = freezeQuote(authoritative.quote);
      setQuote(payable);
      // The persisted quote names the account that must sign. It must be the
      // explicit Base sender, and the wallet must still be on that account —
      // never whichever account it has drifted to since sign-in.
      if (!sameAddress(payable.message.payer, baseSender)) {
        setPhase('failed');
        setError('This quote was issued to a different Base sender. Nothing was signed or sent.');
        return;
      }
      const account = await resolveAccount(wallet, baseSender);
      live();
      if (!sameAddress(account, baseSender)) {
        setPhase('failed');
        setError('The wallet is no longer on the Base sender account. Nothing was signed or sent.');
        return;
      }

      // 2. Pay the server's object. payQuote re-checks version and expiry
      //    before it touches the wallet, and calls `live` before every wallet
      //    step, immediately before the signature, and before the broadcast.
      const result = await payQuote(
        wallet,
        payable,
        (next) => {
          if (generation.current === attempt) setPhase(next);
        },
        {
          now,
          guard: live,
          // Synchronous with the eth_sendTransaction request, right after the
          // last `live()` check: from here on the outcome may be unknown.
          onBroadcastRequested: () => {
            broadcastRequested = true;
            if (inFlight.current?.generation === attempt) inFlight.current.broadcastRequested = true;
            setBroadcast({ attempt, status: 'requested' });
          },
        },
      );
      broadcastHash = result.txHash;
      // The hash is evidence of a sent transaction: kept whatever happens next.
      if (ownsRecord()) setBroadcast({ attempt, status: 'sent', txHash: result.txHash });
      live(); // a settlement hint is only recorded under unchanged authority
      // 3. 202: the hash is recorded as a hint. Not payment, not acceptance.
      const hint = await api.recordSettlementHint(senderSession.token, id, result.txHash, result.chainId);
      live();
      setState(hint.state);
      void pollStatus();
    } catch (cause: unknown) {
      if (cause instanceof AttemptCancelled || generation.current !== attempt) {
        // A stale attempt never touches the UI of whatever is current now —
        // except to report what became of a transaction it asked the wallet
        // to send, and only while that record is still this attempt's.
        if (!broadcastRequested || !ownsRecord()) return;
        if (broadcastHash) {
          setPhase('broadcast');
          setError(LATE_HASH_MESSAGE);
        } else if (isWalletRejectionCode(cause)) {
          setBroadcast({ attempt, status: 'declined' });
          setPhase('rejected');
          setError(DECLINED_AFTER_REQUEST_MESSAGE);
        } else {
          setBroadcast({ attempt, status: 'unknown' });
          setPhase('outcome_unknown');
          setError(OUTCOME_UNKNOWN_MESSAGE);
        }
        return;
      }
      if (broadcastRequested && !broadcastHash) {
        // The wallet was asked to send and answered without a hash. Only an
        // EIP-1193 user rejection establishes that nothing was sent.
        if (isWalletRejectionCode(cause)) {
          if (ownsRecord()) setBroadcast({ attempt, status: 'declined' });
          setPhase('rejected');
        } else {
          if (ownsRecord()) setBroadcast({ attempt, status: 'unknown' });
          setPhase('outcome_unknown');
          setError(OUTCOME_UNKNOWN_MESSAGE);
        }
        return;
      }
      if (broadcastHash) {
        // Sent, but the hint could not be recorded from here. The transaction
        // stands; Gate's own on-chain scan is the authority on settlement.
        setPhase('broadcast');
        if (cause instanceof ApiError && cause.status === 401) {
          clearSession();
        } else if (cause instanceof ApiError && cause.state === 'expired') {
          setState('expired');
        }
        setError(
          `Your transaction was sent (hash below), but Gavel could not be notified from this page${
            cause instanceof ApiError ? `: ${cause.message}` : ''
          }. Gate verifies settlement on chain; keep the transaction hash.`,
        );
        return;
      }
      setPhase(isUserRejection(cause) ? 'rejected' : 'failed');
      if (cause instanceof ApiError && cause.status === 401) {
        clearSession();
        setError('Your Base sender session is no longer valid. Sign in with wallet again to continue.');
      } else if (cause instanceof ApiError) {
        if (cause.state === 'expired') setState('expired');
        setError(cause.message);
      } else if (!isUserRejection(cause)) {
        setError(cause instanceof Error ? cause.message : 'The payment could not be completed.');
      }
    } finally {
      if (generation.current === attempt) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }, [api, wallet, quote, id, senderSession, problem, pollStatus, now, clearSession, setBroadcast]);

  const senderControl =
    problem === null ? null : (
      <section className="notice" aria-label="Base sender required" data-testid="base-sender-required">
        <p>{problem}</p>
        {sender.status === 'disconnected' ? (
          <button type="button" disabled={busy} onClick={() => void connect()}>
            Connect wallet
          </button>
        ) : sender.status === 'ready' ? (
          payer ? (
            <button type="button" disabled={busy} onClick={() => void signInAsPayer()}>
              {busy ? 'Waiting for your wallet…' : 'Sign in as payer'}
            </button>
          ) : null
        ) : (
          <button type="button" disabled={busy} onClick={() => void signIn()}>
            {busy ? 'Waiting for your wallet…' : 'Sign in with wallet'}
          </button>
        )}
      </section>
    );

  if (!quote) {
    return (
      <div className="page page-checkout">
        <h1>Checkout</h1>
        {senderControl}
        {notRecoverable && !senderControl ? (
          <section className="notice" aria-label="Base sender required" data-testid="base-sender-required">
            <p role="alert">
              {`No quote with this ID belongs to the signed-in Base sender ${senderSession?.session.wallet ?? ''}. Switch your wallet to the account that requested it, then sign in again.`}
            </p>
            <button type="button" disabled={busy} onClick={() => void signIn()}>
              {busy ? 'Waiting for your wallet…' : 'Sign in with wallet'}
            </button>
          </section>
        ) : error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : senderControl ? null : (
          <p className="notice">Loading your quote…</p>
        )}
      </div>
    );
  }

  const total = sumAtomic(quote.message.attentionAmount, quote.message.gavelFeeAmount);
  // An expired or unsupported quote offers no pay control at all: the splitter
  // would revert, so asking for a signature would only waste the user's gas.
  const quotePayable = isQuotePayable(quote, Math.floor(now() / 1000));
  // A transaction the wallet may still send, or did send, withholds another
  // payment for this quote. After an unknown or declined outcome a manual
  // retry is offered: the splitter settles a quote at most once.
  const outstanding = broadcast?.status === 'requested' || broadcast?.status === 'sent';
  const payable =
    quotePayable &&
    state === 'payment_required' &&
    !outstanding &&
    phase !== 'broadcast' &&
    phase !== 'broadcasting';
  // Only an unpaid quote goes stale. Once the server has moved the submission
  // on — pending settlement, or accepted — its state outranks the clock.
  const displayState = !quotePayable && state === 'payment_required' ? 'expired' : state;

  return (
    <div className="page page-checkout">
      <h1>Checkout</h1>
      <section className="quote-summary" aria-label="Quote summary">
        <h2>Quote summary</h2>
        <dl>
          <Row label="Attention to voter" value={formatUsdc(quote.message.attentionAmount)} testId="attention-amount" />
          <Row label="Gavel service fee" value={formatUsdc(quote.message.gavelFeeAmount)} testId="gavel-fee" />
          <Row label="Total" value={formatUsdc(total)} testId="total-amount" />
          <Row label="Submission" value={`${id ?? '—'} · Nouns proposal via this Gate`} testId="submission-context" />
          <Row label="Voter payout wallet" value={quote.message.voter} testId="voter-payout" />
          <Row label="Payer" value={quote.message.payer} testId="payer" />
          <Row label="Chain ID" value={String(quote.domain.chainId)} testId="chain-id" />
          <Row label="Token" value={quote.message.token} testId="token" />
          <Row label="Splitter" value={quote.domain.verifyingContract} testId="splitter" />
          <Row label="Quote expires" value={formatExpiryDateTime(quote.message.expiry)} testId="quote-expiry" />
        </dl>
        <p className="quote-note">
          The voter receives the full attention amount. The Gavel service fee is fixed and charged
          separately. These values are fixed by the server and cannot be edited here.
        </p>
      </section>

      {payable ? senderControl : null}
      {payable && senderSession ? (
        <button type="button" onClick={pay} disabled={busy}>
          Authorize and pay {formatUsdc(total)}
        </button>
      ) : null}

      <SettlementState
        state={displayState}
        phase={phase}
        txHash={txHash}
        acceptedAt={acceptedAt}
      />

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
