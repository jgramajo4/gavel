import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WalletIdentity } from './components/WalletIdentity';

const ADDRESS = '0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1';
const SHORT = '0x650C…50E1';

describe('server-provided Gate wallet identity', () => {
  it('renders a verified label with its canonical wallet address', () => {
    render(<WalletIdentity address={ADDRESS} ens="voter.eth" />);
    expect(screen.getByText('voter.eth')).toHaveClass('wallet-identity-primary');
    expect(screen.getByText('voter.eth')).toHaveAttribute('title', ADDRESS);
    expect(screen.getByText(SHORT)).toHaveClass('wallet-identity-secondary');
  });

  it('renders only the address for a verified miss or missing label', () => {
    for (const ens of [null, undefined, 'vоter.eth']) {
      const view = render(<WalletIdentity address={ADDRESS} ens={ens} />);
      expect(screen.getByText(SHORT)).toHaveClass('wallet-identity-primary');
      expect(view.container.querySelector('.wallet-identity-secondary')).toBeNull();
      view.unmount();
    }
  });

  it('never carries a stale label across wallet changes', () => {
    const view = render(<WalletIdentity address={ADDRESS} ens="voter.eth" />);
    const next = '0x2222222222222222222222222222222222222222';
    view.rerender(<WalletIdentity address={next} ens={null} />);
    expect(screen.queryByText('voter.eth')).toBeNull();
    expect(screen.getByText('0x2222…2222')).toHaveAttribute('title', next);
  });
});
