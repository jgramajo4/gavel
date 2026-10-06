import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettlementState } from './SettlementState';

const ACCEPTED_WORDS = /\b(accepted|paid|delivered|complete)\b/i;

describe('SettlementState', () => {
  it('shows a broadcast transaction as pending, never accepted', () => {
    render(<SettlementState state="pending_settlement" phase="broadcast" txHash={`0x${'ab'.repeat(32)}`} />);
    expect(screen.getByRole('status', { name: /payment status/i })).toHaveTextContent(/pending/i);
    expect(screen.getByRole('status', { name: /payment status/i }).textContent).not.toMatch(ACCEPTED_WORDS);
  });

  it('treats a 202 settlement receipt as a recorded hint only', () => {
    render(<SettlementState state="pending_settlement" phase="idle" />);
    const status = screen.getByRole('status', { name: /payment status/i });
    expect(status).toHaveTextContent(/recorded/i);
    expect(status.textContent).not.toMatch(ACCEPTED_WORDS);
  });

  it('shows accepted only when the public API reports accepted', () => {
    render(<SettlementState state="accepted" phase="broadcast" acceptedAt="2026-09-16T10:05:00.000Z" />);
    const status = screen.getByRole('status', { name: /payment status/i });
    expect(status).toHaveTextContent(/accepted/i);
    // The acceptance time reads as a time, with the exact instant on the title.
    expect(status).toHaveTextContent('Accepted at 16 Sep 2026, 10:05 UTC');
    expect(status.textContent).not.toContain('2026-09-16T10:05:00.000Z');
  });

  it('does not show accepted when the wallet rejected the transaction', () => {
    render(<SettlementState state="payment_required" phase="rejected" />);
    const status = screen.getByRole('status', { name: /payment status/i });
    expect(status).toHaveTextContent(/not (sent|submitted)|cancell?ed|rejected/i);
    expect(status.textContent).not.toMatch(ACCEPTED_WORDS);
  });

  it('does not show accepted when the transaction failed or reverted', () => {
    render(<SettlementState state="payment_required" phase="failed" />);
    expect(screen.getByRole('status', { name: /payment status/i }).textContent).not.toMatch(ACCEPTED_WORDS);
  });

  it('exposes no RPC or provider internals', () => {
    const { container } = render(
      <SettlementState state="pending_settlement" phase="failed" txHash={`0x${'ab'.repeat(32)}`} />,
    );
    expect(container.textContent).not.toMatch(/rpc|eth_|jsonrpc|provider|nonce|gas|receipt log|alchemy|infura/i);
  });

  it('shows a known transaction hash in full and copyable, even in a failure tone', () => {
    const hash = `0x${'cd'.repeat(32)}`;
    render(<SettlementState state="payment_required" phase="failed" txHash={hash} />);
    expect(screen.getByLabelText('transaction hash')).toHaveTextContent(hash);
    expect(screen.getByRole('button', { name: /copy transaction hash/i })).toBeInTheDocument();
  });

  it('never claims a requested broadcast was sent or not sent while its outcome is unknown', () => {
    const { unmount } = render(<SettlementState state="payment_required" phase="broadcasting" />);
    const pending = screen.getByRole('status', { name: /payment status/i });
    expect(pending).toHaveTextContent(/may or may not have been sent/i);
    expect(pending.textContent).not.toMatch(/transaction sent|nothing was sent|not sent/i);
    unmount();
    render(<SettlementState state="payment_required" phase="outcome_unknown" />);
    const unknown = screen.getByRole('status', { name: /payment status/i });
    expect(unknown).toHaveTextContent(/outcome unknown/i);
    expect(unknown.textContent).not.toMatch(/nothing was sent|did not go through/i);
    expect(unknown.textContent).not.toMatch(ACCEPTED_WORDS);
  });
});
