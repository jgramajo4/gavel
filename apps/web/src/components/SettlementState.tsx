import type { PublicReceiptState } from '../types';
import type { PaymentPhase } from '../wallet';
import { formatDateTime, formatTimestamp } from '../format';
import { CopyBlock } from './CopyBlock';

/**
 * The single place that turns wallet phase + public receipt state into words.
 *
 * The rule PR6 froze: a broadcast transaction, a local receipt, one
 * confirmation, and a 202 from the settlement endpoint all mean "recorded as a
 * pending hint" and nothing more. Only the public status endpoint reporting
 * `accepted` — which the server sets after verified settlement and synchronous
 * inbox creation — may say the submission was accepted.
 *
 * Nothing here surfaces RPC, provider, gas, or log internals.
 */

interface Copy {
  tone: 'neutral' | 'progress' | 'good' | 'bad';
  headline: string;
  detail: string;
}

function copyFor(state: PublicReceiptState, phase: PaymentPhase): Copy {
  if (state === 'expired') {
    return {
      tone: 'bad',
      headline: 'Quote expired',
      detail: 'This quote can no longer be paid. Compose a new submission to get a new quote.',
    };
  }
  if (phase === 'rejected') {
    return {
      tone: 'bad',
      headline: 'Payment cancelled in your wallet',
      detail: 'Nothing was sent. Your quote is unchanged and still payable until it expires.',
    };
  }
  if (phase === 'outcome_unknown') {
    return {
      tone: 'bad',
      headline: 'Payment outcome unknown',
      detail:
        'Your wallet was asked to send the payment transaction but did not confirm it. It may or may not have been sent. Gate verifies settlement on chain.',
    };
  }
  if (phase === 'failed') {
    return {
      tone: 'bad',
      headline: 'The payment did not go through',
      detail: 'No settlement was recorded. Your quote is unchanged and still payable until it expires.',
    };
  }
  if (state === 'accepted') {
    return {
      tone: 'good',
      headline: 'Accepted',
      detail: 'Gavel verified settlement on chain and created the voter’s private inbox item.',
    };
  }
  if (state === 'pending_settlement') {
    return {
      tone: 'progress',
      headline: 'Pending settlement',
      detail:
        phase === 'broadcast'
          ? 'Your transaction was broadcast and its hash is recorded as a hint. Gavel is verifying it on chain. This is not yet an acceptance.'
          : 'Your transaction hash is recorded as a hint. Gavel is verifying settlement on chain. This is not yet an acceptance.',
    };
  }
  if (phase === 'authorizing') {
    return { tone: 'progress', headline: 'Awaiting your signature', detail: 'Confirm the payment authorization in your wallet.' };
  }
  if (phase === 'broadcasting') {
    return {
      tone: 'progress',
      headline: 'Waiting for your wallet to send the transaction',
      detail:
        'Your wallet was asked to send the payment. Until it answers, it may or may not have been sent. Gavel has not verified settlement. This is not an acceptance.',
    };
  }
  if (phase === 'broadcast') {
    return {
      tone: 'progress',
      headline: 'Transaction sent',
      detail: 'Gavel has not verified settlement yet. This is not an acceptance.',
    };
  }
  if (state === 'rejected_by_policy' || state === 'malformed' || state === 'duplicate') {
    return { tone: 'bad', headline: 'Not quoted', detail: 'The server did not issue a payable quote for this submission.' };
  }
  return { tone: 'neutral', headline: 'Payment required', detail: 'Authorize the payment to submit this pitch.' };
}

export interface SettlementStateProps {
  state: PublicReceiptState;
  phase: PaymentPhase;
  txHash?: string;
  acceptedAt?: string;
}

export function SettlementState({ state, phase, txHash, acceptedAt }: SettlementStateProps) {
  const copy = copyFor(state, phase);
  return (
    <>
      <div role="status" aria-live="polite" aria-label="Payment status" className={`settlement settlement-${copy.tone}`}>
        <p className="settlement-headline">{copy.headline}</p>
        <p className="settlement-detail">{copy.detail}</p>
        {state === 'accepted' && acceptedAt ? (
          <p className="settlement-tx" title={formatTimestamp(acceptedAt)}>
            Accepted at {formatDateTime(acceptedAt)}
          </p>
        ) : null}
      </div>
      {txHash ? (
        // Evidence of a sent transaction: shown in full and copyable in every
        // state, including failures and cancellations, never shortened. Kept
        // outside the live status region so its Copy feedback is not nested.
        <section className="settlement-tx" aria-label="Transaction hash" data-testid="settlement-tx">
          <p>Transaction hash</p>
          <CopyBlock text={txHash} label="transaction hash" />
        </section>
      ) : null}
    </>
  );
}
