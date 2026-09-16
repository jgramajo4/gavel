import { useCallback, useEffect, useRef, useState } from 'react';
import { GateApiError, freezeQuote, type GateApi } from '../api';
import { useSession } from '../session';
import { SettlementState } from '../components/SettlementState';
import { formatExpiry, formatUsdc, sumAtomic } from '../format';
import { isQuotePayable, payQuote, type Eip1193Provider, type PaymentPhase } from '../wallet';
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
 */

const TERMINAL: PublicReceiptState[] = ['accepted', 'expired', 'rejected_by_policy', 'malformed'];

function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const message = error instanceof Error ? error.message : '';
  return /user (rejected|denied)|rejected the request|cancell?ed/i.test(message);
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
  const { session } = useSession();
  const [quote, setQuote] = useState<IssuedQuote | null>(receipt?.quote ? freezeQuote(receipt.quote) : null);
  const [id, setId] = useState<string | null>(receipt?.publicId ?? publicId ?? null);
  const [state, setState] = useState<PublicReceiptState>(receipt?.state ?? 'payment_required');
  const [phase, setPhase] = useState<PaymentPhase>('idle');
  const [txHash, setTxHash] = useState<string | undefined>(undefined);
  const [acceptedAt, setAcceptedAt] = useState<string | undefined>(receipt?.acceptedAt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const polling = useRef(false);

  // Recovery path: a reload, or a duplicate, lands here with only a public ID.
  // Resume returns the ORIGINAL quote; it issues nothing and refreshes nothing.
  useEffect(() => {
    if (quote || !publicId || !session) return;
    let cancelled = false;
    api
      .resumeSubmission(session.token, `/v1/submissions/${publicId}/resume`)
      .then((resumed) => {
        if (cancelled || !resumed) return;
        setId(resumed.publicId);
        setState(resumed.state);
        if (resumed.acceptedAt) setAcceptedAt(resumed.acceptedAt);
        if (resumed.quote) setQuote(freezeQuote(resumed.quote));
        onResume?.(resumed);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof GateApiError ? cause.message : 'This quote could not be recovered.');
      });
    return () => {
      cancelled = true;
    };
  }, [api, session, publicId, quote, onResume]);

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
    if (!quote || !id || !session) return;
    setError(null);
    setBusy(true);
    try {
      // 1. Re-authorize. The rendered quote is a display cache; the persisted,
      //    owner-bound quote is the only thing that may reach the wallet.
      const authoritative = await api.resumeSubmission(session.token, `/v1/submissions/${id}/resume`);
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

      // 2. Pay the server's object. payQuote re-checks version and expiry
      //    before it touches the wallet.
      const result = await payQuote(wallet, payable, setPhase, { now });
      setTxHash(result.txHash);
      // 3. 202: the hash is recorded as a hint. Not payment, not acceptance.
      const hint = await api.recordSettlementHint(session.token, id, result.txHash, result.chainId);
      setState(hint.state);
      void pollStatus();
    } catch (cause: unknown) {
      setPhase(isUserRejection(cause) ? 'rejected' : 'failed');
      if (cause instanceof GateApiError) {
        if (cause.state === 'expired') setState('expired');
        setError(cause.message);
      } else if (!isUserRejection(cause)) {
        setError(cause instanceof Error ? cause.message : 'The payment could not be completed.');
      }
    } finally {
      setBusy(false);
    }
  }, [api, wallet, quote, id, session, pollStatus, now]);

  if (!quote) {
    return (
      <div className="page page-checkout">
        <h1>Checkout</h1>
        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : (
          <p className="notice">Loading your quote…</p>
        )}
      </div>
    );
  }

  const total = sumAtomic(quote.message.attentionAmount, quote.message.gavelFeeAmount);
  // An expired or unsupported quote offers no pay control at all: the splitter
  // would revert, so asking for a signature would only waste the user's gas.
  const quotePayable = isQuotePayable(quote, Math.floor(now() / 1000));
  const payable =
    quotePayable && state === 'payment_required' && phase !== 'broadcast' && phase !== 'broadcasting';
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
          <Row label="Quote expires" value={formatExpiry(quote.message.expiry)} testId="quote-expiry" />
        </dl>
        <p className="quote-note">
          The voter receives the full attention amount. The Gavel service fee is fixed and charged
          separately. These values are fixed by the server and cannot be edited here.
        </p>
      </section>

      {payable ? (
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
