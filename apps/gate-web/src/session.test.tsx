import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionProvider, useSession } from './session';

function Probe() {
  const { session, setSession, clearSession } = useSession();
  return (
    <div>
      <span data-testid="wallet">{session?.session.wallet ?? 'none'}</span>
      <button
        type="button"
        onClick={() =>
          setSession({
            token: 'z'.repeat(43),
            session: {
              wallet: '0x3333333333333333333333333333333333333333',
              role: 'base_sender',
              chainId: '84532',
              audience: 'gate',
              issuedAt: '1',
              expiry: '9999999999',
            },
          })
        }
      >
        sign in
      </button>
      <button type="button" onClick={clearSession}>
        sign out
      </button>
    </div>
  );
}

describe('session storage boundary', () => {
  it('never persists session material to browser storage', async () => {
    const user = userEvent.setup();
    render(
      <SessionProvider initialSession={null}>
        <Probe />
      </SessionProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'sign in' }));
    expect(screen.getByTestId('wallet')).toHaveTextContent('0x3333333333333333333333333333333333333333');

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');

    await user.click(screen.getByRole('button', { name: 'sign out' }));
    expect(screen.getByTestId('wallet')).toHaveTextContent('none');
  });
});
