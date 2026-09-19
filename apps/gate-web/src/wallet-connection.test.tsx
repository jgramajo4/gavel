import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletConnectionProvider, useWalletConnection } from './wallet-connection';
import { stubWallet } from './test/harness';
import type { Eip1193Provider } from './wallet';

const LOWER = '0x650c1b4d2f5b9e3a0f8c7d6e5a4b3c2d1e0f50e1';
const CHECKSUMMED = '0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1';

function Probe() {
  const { address, connecting, error, connect, noteConnected, disconnect } = useWalletConnection();
  return (
    <div>
      <span data-testid="address">{address ?? 'disconnected'}</span>
      <span data-testid="connecting">{String(connecting)}</span>
      <span data-testid="error">{error ?? 'none'}</span>
      <button type="button" onClick={() => void connect()}>
        connect
      </button>
      <button type="button" onClick={() => noteConnected(LOWER)}>
        note
      </button>
      <button type="button" onClick={disconnect}>
        disconnect
      </button>
    </div>
  );
}

function renderProbe(provider: Eip1193Provider, initialAddress: string | null = null) {
  return render(
    <WalletConnectionProvider provider={provider} initialAddress={initialAddress}>
      <Probe />
    </WalletConnectionProvider>,
  );
}

describe('WalletConnectionProvider', () => {
  it('starts disconnected and touches the wallet for nothing on mount', () => {
    // No silent `eth_accounts` probe: the page never talks to a wallet until a
    // person asks it to, and nothing is restored from storage.
    const provider = stubWallet({ eth_requestAccounts: () => [LOWER] });
    renderProbe(provider);
    expect(screen.getByTestId('address')).toHaveTextContent('disconnected');
    expect(provider.calls).toEqual([]);
  });

  it('connects through eth_requestAccounts and checksums the result', async () => {
    const provider = stubWallet({ eth_requestAccounts: () => [LOWER] });
    const user = userEvent.setup();
    renderProbe(provider);
    await user.click(screen.getByRole('button', { name: 'connect' }));
    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(CHECKSUMMED));
    expect(provider.calls.map((call) => call.method)).toEqual(['eth_requestAccounts']);
  });

  it('signs nothing while connecting', async () => {
    const provider = stubWallet({ eth_requestAccounts: () => [LOWER] });
    const user = userEvent.setup();
    renderProbe(provider);
    await user.click(screen.getByRole('button', { name: 'connect' }));
    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(CHECKSUMMED));
    expect(provider.calls.some((call) => call.method.startsWith('eth_signTypedData'))).toBe(false);
    expect(provider.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(false);
  });

  it('reports a refused connection in one sentence and stays disconnected', async () => {
    const provider: Eip1193Provider = {
      async request() {
        throw new Error('User rejected the request.');
      },
    };
    const user = userEvent.setup();
    renderProbe(provider);
    await user.click(screen.getByRole('button', { name: 'connect' }));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('User rejected'));
    expect(screen.getByTestId('address')).toHaveTextContent('disconnected');
    expect(screen.getByTestId('connecting')).toHaveTextContent('false');
  });

  it('records an account a role-specific flow already authorized', async () => {
    const provider = stubWallet({});
    const user = userEvent.setup();
    renderProbe(provider);
    await user.click(screen.getByRole('button', { name: 'note' }));
    expect(screen.getByTestId('address')).toHaveTextContent(CHECKSUMMED);
    // Enrollment and the inbox already hold an authorized account; recording it
    // must not prompt the wallet a second time.
    expect(provider.calls).toEqual([]);
  });

  it('ignores an address the wallet could not have produced', async () => {
    const provider = stubWallet({ eth_requestAccounts: () => ['not-an-address'] });
    const user = userEvent.setup();
    renderProbe(provider);
    await user.click(screen.getByRole('button', { name: 'connect' }));
    await waitFor(() => expect(screen.getByTestId('error')).not.toHaveTextContent('none'));
    expect(screen.getByTestId('address')).toHaveTextContent('disconnected');
  });

  it('drops the connection on disconnect', async () => {
    const user = userEvent.setup();
    renderProbe(stubWallet({}), CHECKSUMMED);
    expect(screen.getByTestId('address')).toHaveTextContent(CHECKSUMMED);
    await user.click(screen.getByRole('button', { name: 'disconnect' }));
    expect(screen.getByTestId('address')).toHaveTextContent('disconnected');
  });

  it('follows the wallet when it switches or revokes accounts', async () => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const provider: Eip1193Provider = {
      async request() {
        throw new Error('unused');
      },
      on(event, listener) {
        listeners[event] = listener;
      },
      removeListener(event) {
        delete listeners[event];
      },
    };
    renderProbe(provider, CHECKSUMMED);
    await waitFor(() => expect(listeners.accountsChanged).toBeTypeOf('function'));

    listeners.accountsChanged(['0x4444444444444444444444444444444444444444']);
    await waitFor(() =>
      expect(screen.getByTestId('address')).toHaveTextContent(
        '0x4444444444444444444444444444444444444444',
      ),
    );

    listeners.accountsChanged([]);
    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent('disconnected'));
  });

  it('persists nothing anywhere a later tab could read it', async () => {
    const provider = stubWallet({ eth_requestAccounts: () => [LOWER] });
    const user = userEvent.setup();
    renderProbe(provider);
    await user.click(screen.getByRole('button', { name: 'connect' }));
    await waitFor(() => expect(screen.getByTestId('address')).toHaveTextContent(CHECKSUMMED));
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('refuses to be used outside a provider', () => {
    // A workflow that reads the connection without the provider is a wiring
    // bug, not something to paper over with a null address.
    expect(() => render(<Probe />)).toThrow(/requires a WalletConnectionProvider/);
  });
});
