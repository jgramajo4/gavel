import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoterInbox } from './VoterInbox';
import { renderApp, stubApi } from '../test/harness';
import { PRIVATE_FIXTURE_FIELDS, VOTER, inboxItem } from '../test/fixtures';

const session = {
  token: 'b'.repeat(43),
  session: {
    wallet: VOTER,
    role: 'dao_profile' as const,
    chainId: '1',
    audience: 'gate',
    issuedAt: '1',
    expiry: '9999999999',
  },
};

const inboxRoute = (items: unknown[], status = 200) => [
  { method: 'GET', match: /\/v1\/gate\/me\/inbox$/, status, body: { items } },
];

describe('VoterInbox', () => {
  it('shows the immutable raw pitch, disclosures, and evidence links', async () => {
    const { api, calls } = stubApi(inboxRoute([inboxItem]));
    renderApp(<VoterInbox api={api} />, { session });
    await screen.findByRole('heading', { name: /fund the client/i });

    expect(screen.getByText(/pays/i).tagName).toBe('STRONG');
    expect(screen.getByText('I am paid by the proposer.')).toBeInTheDocument();
    const evidence = screen.getByRole('list', { name: /evidence/i });
    const links = within(evidence).getAllByRole('link');
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    }
    expect(within(evidence).getByText(/advocate-provided/i)).toBeInTheDocument();
    // Evidence is never dereferenced by the inbox either.
    expect(calls.some((call) => call.includes('example.org'))).toBe(false);
  });

  it('distinguishes canonical, decoded, and enriched facts', async () => {
    const { api } = stubApi(inboxRoute([inboxItem]));
    renderApp(<VoterInbox api={api} />, { session });
    await screen.findByRole('heading', { name: /fund the client/i });
    expect(screen.getByRole('group', { name: /canonical/i })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /decoded/i })).toBeInTheDocument();
    const enriched = screen.getByRole('group', { name: /enriched/i });
    expect(within(enriched).getByText(/display only/i)).toBeInTheDocument();
  });

  it('keeps raw unknown actions visible', async () => {
    const { api } = stubApi(inboxRoute([inboxItem]));
    renderApp(<VoterInbox api={api} />, { session });
    await screen.findByRole('heading', { name: /fund the client/i });
    expect(screen.getByText('0xdeadbeef')).toBeInTheDocument();
    expect(screen.getByText(/unknownCall\(bytes\)/)).toBeInTheDocument();
  });

  it('shows both lifecycle states when the proposal changed after issuance', async () => {
    const { api } = stubApi(inboxRoute([inboxItem]));
    renderApp(<VoterInbox api={api} />, { session });
    const lifecycle = await screen.findByTestId('lifecycle');
    expect(lifecycle).toHaveTextContent(/at quote/i);
    expect(lifecycle).toHaveTextContent('VOTING');
    expect(lifecycle).toHaveTextContent(/now/i);
    expect(lifecycle).toHaveTextContent('CLOSED');
  });

  it('shows one lifecycle state when nothing changed', async () => {
    const unchanged = { ...inboxItem, currentLifecycle: 'VOTING', lifecycleChanged: false };
    const { api } = stubApi(inboxRoute([unchanged]));
    renderApp(<VoterInbox api={api} />, { session });
    const lifecycle = await screen.findByTestId('lifecycle');
    expect(lifecycle).toHaveTextContent('VOTING');
    expect(lifecycle).not.toHaveTextContent(/at quote/i);
  });

  it('renders no advocate notification state, delivery setting, or capacity', async () => {
    const polluted = { ...inboxItem, ...PRIVATE_FIXTURE_FIELDS };
    const { api } = stubApi(inboxRoute([polluted]));
    const { container } = renderApp(<VoterInbox api={api} />, { session });
    await screen.findByRole('heading', { name: /fund the client/i });
    for (const value of Object.values(PRIVATE_FIXTURE_FIELDS)) {
      expect(container.textContent).not.toContain(String(value));
    }
    expect(container.textContent).not.toMatch(
      /notification|delivered|destination|channel|capacity|remaining|sender receipt|retry/i,
    );
  });

  it('offers no reply or follow-up control in the MVP', async () => {
    const { api } = stubApi(inboxRoute([inboxItem]));
    renderApp(<VoterInbox api={api} />, { session });
    await screen.findByRole('heading', { name: /fund the client/i });
    expect(screen.queryByRole('button', { name: /repl(y|ies)|follow.?up|message back/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('archives through the server when the backend supports it', async () => {
    const { api, calls } = stubApi([
      ...inboxRoute([inboxItem]),
      { method: 'POST', match: /\/archive$/, status: 204, body: null },
    ]);
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} />, { session });
    await screen.findByRole('heading', { name: /fund the client/i });
    await user.click(screen.getByRole('button', { name: /archive/i }));
    await waitFor(() => expect(calls.some((call) => call.endsWith('/archive'))).toBe(true));
  });

  it('reports an unserved inbox endpoint instead of inventing data', async () => {
    const { api } = stubApi(inboxRoute([], 404));
    renderApp(<VoterInbox api={api} />, { session });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/does not serve/i);
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('requires a voter session before requesting anything', async () => {
    const { api, calls } = stubApi(inboxRoute([inboxItem]));
    renderApp(<VoterInbox api={api} />, { session: null });
    expect(await screen.findByRole('alert')).toHaveTextContent(/sign in|connect/i);
    expect(calls).toHaveLength(0);
  });

  it('exposes the inbox as a keyboard-navigable labelled list', async () => {
    const { api } = stubApi([
      ...inboxRoute([inboxItem]),
      { method: 'POST', match: /\/archive$/, status: 204, body: null },
    ]);
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} />, { session });
    await screen.findByRole('heading', { name: /fund the client/i });
    expect(screen.getByRole('region', { name: /voter inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveAccessibleName();
    await user.tab();
    expect(screen.getByRole('button', { name: /archive/i })).toHaveFocus();
  });
});
