import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GateDirectory } from './GateDirectory';
import { renderApp, stubApi } from '../test/harness';
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

  it('shows exact power and a canonical as-of timestamp', async () => {
    const { api } = stubApi(listRoute([highPowerProfile]));
    renderApp(<GateDirectory api={api} />);
    await screen.findByRole('list', { name: 'Gates' });
    const [card] = within(screen.getByRole('list', { name: 'Gates' })).getAllByRole('listitem');
    expect(within(card).getByText('412')).toBeInTheDocument();
    expect(within(card).getByText(/as of/i)).toHaveTextContent('2026-09-16');
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
