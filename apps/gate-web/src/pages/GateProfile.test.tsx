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
    expect(screen.getByText(pollutedProfile.wallet)).toBeInTheDocument();
    expect(screen.getByText(/nouns/i)).toBeInTheDocument();
    expect(screen.getByText('VOTING')).toBeInTheDocument();
    expect(screen.getByText('treasury')).toBeInTheDocument();
    expect(screen.getByText(/5\.00 USDC/)).toBeInTheDocument();
    expect(screen.getByText('37')).toBeInTheDocument();
    expect(screen.getByText(/as of/i)).toHaveTextContent('2026-09-16');
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
