import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GateDirectory } from './GateDirectory';
import { renderApp, stubApi, stubEnsResolver } from '../test/harness';
import {
  PRIVATE_FIXTURE_FIELDS,
  acceptingProfile,
  highPowerProfile,
  pollutedProfile,
  zeroPowerProfile,
} from '../test/fixtures';

const listRoute = (items: unknown[]) => [
  { method: 'GET', match: /\/v1\/gates\?/, status: 200, body: { items } },
];

describe('GateDirectory', () => {
  it('defaults to recent opt-ins among accepting_now Nouns gates', async () => {
    const { api, calls } = stubApi(listRoute([acceptingProfile, highPowerProfile]));
    renderApp(<GateDirectory api={api} />);
    await screen.findByText('voter.eth');
    const [request] = calls;
    expect(request).toContain('dao=nouns');
    expect(request).toContain('availability=accepting_now');
    expect(request).toContain('sort=recent');
    expect(request).not.toContain('minVotingPower');
    expect((screen.getByLabelText(/sort/i) as HTMLSelectElement).value).toBe('recent');
    expect((screen.getByLabelText(/availability/i) as HTMLSelectElement).value).toBe('accepting_now');
  });

  it('never implies that voting power controls availability', async () => {
    const { api } = stubApi(listRoute([acceptingProfile]));
    const { container } = renderApp(<GateDirectory api={api} />);
    await screen.findByText('voter.eth');
    expect(container.textContent).not.toMatch(/power (determines|controls|unlocks|required for)/i);
  });

  it('keeps power sort and minimum power filter optional', async () => {
    const { api, calls } = stubApi(listRoute([highPowerProfile]));
    const user = userEvent.setup();
    renderApp(<GateDirectory api={api} />);
    await screen.findByText('whale.eth');

    await user.selectOptions(screen.getByLabelText(/sort/i), 'power');
    await waitFor(() => expect(calls.at(-1)).toContain('sort=power'));

    await user.type(screen.getByLabelText(/minimum voting power/i), '100');
    await user.click(screen.getByRole('button', { name: /apply/i }));
    await waitFor(() => expect(calls.at(-1)).toContain('minVotingPower=100'));

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    await waitFor(() => expect(calls.at(-1)).not.toContain('minVotingPower'));
  });

  it('renders a zero-power accepting profile as accepting', async () => {
    const { api } = stubApi(listRoute([zeroPowerProfile]));
    renderApp(<GateDirectory api={api} />);
    await screen.findByRole('list', { name: 'Gates' });
    const [card] = within(screen.getByRole('list', { name: 'Gates' })).getAllByRole('listitem');
    expect(within(card).getByText('0')).toBeInTheDocument();
    expect(within(card).getByText(/accepting/i)).toBeInTheDocument();
  });

  it('shows exact power and a human-readable as-of time, never a raw ISO stamp', async () => {
    const { api } = stubApi(listRoute([highPowerProfile]));
    renderApp(<GateDirectory api={api} />);
    await screen.findByRole('list', { name: 'Gates' });
    const [card] = within(screen.getByRole('list', { name: 'Gates' })).getAllByRole('listitem');
    expect(within(card).getByText('412')).toBeInTheDocument();
    const asOf = within(card).getByText(/as of/i);
    expect(asOf).toHaveTextContent('As of 16 Sep 2026, 09:45 UTC');
    // The exact instant is preserved, but as a title rather than body text.
    expect(card.textContent).not.toContain('2026-09-16T09:45:00.000Z');
    expect(asOf).toHaveAttribute('title', '2026-09-16T09:45:00.000Z');
  });

  it('leads with the ENS name and keeps the address secondary and shortened', async () => {
    const { api } = stubApi(listRoute([acceptingProfile]));
    renderApp(<GateDirectory api={api} />);
    const card = (await screen.findByText('voter.eth')).closest('li') as HTMLElement;
    expect(within(card).getByText('0x4444…4444')).toBeInTheDocument();
    // The raw address is never printed in full, let alone twice.
    expect(card.textContent).not.toContain(acceptingProfile.wallet);
    expect(card.textContent?.match(/0x4444…4444/g)).toHaveLength(1);
  });

  it('falls back to a shortened address when no name is available', async () => {
    const { api } = stubApi(listRoute([zeroPowerProfile]));
    renderApp(<GateDirectory api={api} />);
    await screen.findByRole('list', { name: 'Gates' });
    const [card] = within(screen.getByRole('list', { name: 'Gates' })).getAllByRole('listitem');
    expect(within(card).getByText('0x5555…5555')).toBeInTheDocument();
    expect(within(card).queryByText(/\.eth$/)).toBeNull();
    expect(card.textContent).not.toContain(zeroPowerProfile.wallet);
  });

  it('resolves a name in the browser only when the projection has none', async () => {
    const resolver = stubEnsResolver({ [zeroPowerProfile.wallet]: 'quiet.eth' });
    const { api } = stubApi(listRoute([acceptingProfile, zeroPowerProfile]));
    renderApp(<GateDirectory api={api} />, { ens: resolver });
    expect(await screen.findByText('quiet.eth')).toBeInTheDocument();
    // `acceptingProfile` already carries a server-indexed name, so the browser
    // never looks it up: the server's value always wins.
    expect(screen.getByText('voter.eth')).toBeInTheDocument();
    expect(resolver.lookups).toEqual([zeroPowerProfile.wallet]);
  });

  it('shows the price as the card headline fact', async () => {
    const { api } = stubApi(listRoute([acceptingProfile]));
    renderApp(<GateDirectory api={api} />);
    const card = (await screen.findByText('voter.eth')).closest('li') as HTMLElement;
    expect(within(card).getByText(/^attention$/i)).toBeInTheDocument();
    expect(within(card).getByText('5.00 USDC')).toBeInTheDocument();
    expect(within(card).getByText(/accepting now/i)).toBeInTheDocument();
  });

  it('renders no private field from a polluted directory payload', async () => {
    const { api } = stubApi(listRoute([pollutedProfile]));
    const { container } = renderApp(<GateDirectory api={api} />);
    await screen.findByText('voter.eth');
    for (const value of Object.values(PRIVATE_FIXTURE_FIELDS)) {
      expect(container.textContent).not.toContain(String(value));
    }
    expect(container.textContent).not.toMatch(/notification|destination|capacity|inbox|read at|session|nonce/i);
  });

  it('supports keyboard-only operation of every filter', async () => {
    const { api } = stubApi(listRoute([acceptingProfile]));
    const user = userEvent.setup();
    renderApp(<GateDirectory api={api} />);
    await screen.findByText('voter.eth');

    expect(screen.getByRole('search')).toBeInTheDocument();
    await user.tab();
    expect(screen.getByLabelText(/dao/i)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/availability/i)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/sort/i)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/minimum voting power/i)).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: /apply/i })).toHaveFocus();
  });
});
