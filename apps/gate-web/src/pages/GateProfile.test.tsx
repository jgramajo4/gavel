import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { GateProfile } from './GateProfile';
import { renderApp, stubApi } from '../test/harness';
import { PRIVATE_FIXTURE_FIELDS, closedProfile, pollutedProfile } from '../test/fixtures';

const profileRoute = (body: unknown, status = 200) => [
  { method: 'GET', match: /\/v1\/gates\/0x/, status, body },
];

describe('GateProfile', () => {
  it('shows only public data for an accepting Gate', async () => {
    const { api } = stubApi(profileRoute(pollutedProfile));
    renderApp(<GateProfile api={api} wallet={pollutedProfile.wallet} />);
    await screen.findByText('voter.eth');
    expect(screen.getByText(/nouns/i)).toBeInTheDocument();
    expect(screen.getByText('VOTING')).toBeInTheDocument();
    expect(screen.getByText('treasury')).toBeInTheDocument();
    expect(screen.getByText(/5\.00 USDC/)).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getByText(/as of/i)).toHaveTextContent('As of 16 Sep 2026, 09:45 UTC');
  });

  it('leads with the name and publishes the canonical address once, as detail', async () => {
    const { api } = stubApi(profileRoute(pollutedProfile));
    const { container } = renderApp(<GateProfile api={api} wallet={pollutedProfile.wallet} />);
    const name = await screen.findByText('voter.eth');
    expect(name).toHaveClass('wallet-identity-primary');
    expect(screen.getByText('0x4444…4444')).toHaveClass('wallet-identity-secondary');
    // This IS the detail view, so the full address is published — exactly once,
    // as a labelled row rather than as the page's headline.
    const full = container.querySelectorAll('.profile-wallet');
    expect(full).toHaveLength(1);
    expect(full[0]).toHaveTextContent(pollutedProfile.wallet);
    expect(screen.getByText('Wallet')).toBeInTheDocument();
  });

  it('publishes the voter price and not the Gavel service fee', async () => {
    const { api } = stubApi(profileRoute(pollutedProfile));
    const { container } = renderApp(<GateProfile api={api} wallet={pollutedProfile.wallet} />);
    await screen.findByText('voter.eth');
    // The advocate pays the fee and is told about it at the composer and the
    // checkout quote. A voter's public page shows what THEY charge.
    expect(screen.getByText('Attention price')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/service fee|0\.25 USDC/i);
  });

  it('uses a shortened address as the headline when there is no name', async () => {
    const { api } = stubApi(profileRoute(closedProfile));
    renderApp(<GateProfile api={api} wallet={closedProfile.wallet} />);
    expect(await screen.findByText('0x7777…7777')).toHaveClass('wallet-identity-primary');
  });

  it('renders no private field from a polluted profile payload', async () => {
    const { api } = stubApi(profileRoute(pollutedProfile));
    const { container } = renderApp(<GateProfile api={api} wallet={pollutedProfile.wallet} />);
    await screen.findByText('voter.eth');
    for (const value of Object.values(PRIVATE_FIXTURE_FIELDS)) {
      expect(container.textContent).not.toContain(String(value));
    }
    expect(container.textContent).not.toMatch(
      /notification|destination|xmtp|telegram|capacity|remaining|inbox|read at|session|nonce|ip address/i,
    );
  });

  it('stays a durable public page when the Gate is closed', async () => {
    const { api } = stubApi(profileRoute(closedProfile));
    renderApp(<GateProfile api={api} wallet={closedProfile.wallet} />);
    await screen.findByText(closedProfile.wallet);
    expect(screen.getByText(/not currently accepting new submissions/i)).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /compose|submit/i })).toBeNull();
    // No count, reset time, or reason is ever published.
    expect(screen.queryByText(/capacity|resets|try again at/i)).toBeNull();
  });

  it('offers composition only when the server says the Gate accepts submissions', async () => {
    const { api } = stubApi(profileRoute(pollutedProfile));
    renderApp(<GateProfile api={api} wallet={pollutedProfile.wallet} />);
    expect(await screen.findByRole('link', { name: /submit a paid pitch/i })).toBeInTheDocument();
  });

  it('reports a missing Gate without inventing one', async () => {
    const { api } = stubApi(profileRoute(null, 404));
    renderApp(<GateProfile api={api} wallet={closedProfile.wallet} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/i);
  });
});
