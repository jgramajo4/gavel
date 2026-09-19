import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoterInbox } from './VoterInbox';
import { renderApp, stubApi, stubWallet } from '../test/harness';
import {
  VOTER,
  candidateInboxItem,
  inboxSession,
  proposalInboxItem,
  profileSession,
} from '../test/fixtures';

/**
 * The private inbox is owner-bound and `dao_inbox`-only, and everything it
 * renders came from an advocate who paid to be read. These tests hold both
 * lines: the authentication path, and the refusal to give advocate-controlled
 * content any reach beyond inert text.
 */

const LIST = /\/v1\/gate\/me\/inbox$/;
const ITEM = /\/v1\/gate\/me\/inbox\/[^/]+$/;
const ARCHIVE = /\/v1\/gate\/me\/inbox\/[^/]+\/archive$/;

const listBody = { items: [candidateInboxItem, proposalInboxItem] };

const sessionChallenge = {
  proofType: 'WalletSession',
  primaryType: 'WalletSession',
  domain: { name: 'GavelGate', version: '1', chainId: 1, verifyingContract: VOTER },
  types: { WalletSession: [{ name: 'wallet', type: 'address' }] },
  message: { wallet: VOTER, role: 'dao_inbox' },
  nonceHash: `0x${'aa'.repeat(32)}`,
  payloadHash: `0x${'bb'.repeat(32)}`,
};

function signedWallet() {
  return stubWallet({
    eth_requestAccounts: () => [VOTER],
    eth_chainId: () => '0x1',
    eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
  });
}

describe('VoterInbox authentication', () => {
  it('asks for a dao_inbox session and issues no inbox request until it has one', async () => {
    const { api, calls } = stubApi([{ method: 'GET', match: LIST, status: 200, body: listBody }]);
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />);
    expect(await screen.findByRole('button', { name: /connect governance wallet/i })).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it('runs challenge → signature → session for the dao_inbox role only', async () => {
    const { api, calls } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: sessionChallenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: inboxSession },
      { method: 'GET', match: LIST, status: 200, body: listBody },
    ]);
    const wallet = signedWallet();
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={wallet} />);

    await user.click(screen.getByRole('button', { name: /connect governance wallet/i }));
    await waitFor(() => expect(calls.some((call) => LIST.test(call))).toBe(true));

    const challenge = wallet.calls.find((call) => call.method === 'eth_signTypedData_v4');
    expect(JSON.stringify(challenge?.params)).toContain('dao_inbox');
    // No advocate role is ever requested from this page.
    expect(JSON.stringify(wallet.calls)).not.toContain('base_sender');
  });

  it('refuses a session the server issued for another role', async () => {
    const { api, calls } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: sessionChallenge },
      // The server hands back a dao_profile session for a dao_inbox request.
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: profileSession },
    ]);
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={signedWallet()} />);
    await user.click(screen.getByRole('button', { name: /connect governance wallet/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/dao_inbox session/i);
    expect(calls.some((call) => LIST.test(call))).toBe(false);
  });

  it('reports a signature failure without claiming a session', async () => {
    const { api } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: sessionChallenge },
    ]);
    const wallet = stubWallet({
      eth_requestAccounts: () => [VOTER],
      eth_signTypedData_v4: () => {
        throw new Error('User rejected the request');
      },
    });
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={wallet} />);
    await user.click(screen.getByRole('button', { name: /connect governance wallet/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
    expect(screen.getByRole('button', { name: /connect governance wallet/i })).toBeInTheDocument();
  });

  it('treats a 401 as an expired session and asks the voter to sign in again', async () => {
    const { api } = stubApi([
      {
        method: 'GET',
        match: LIST,
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'authentication required' } },
      },
    ]);
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
    expect(screen.getByRole('button', { name: /connect governance wallet/i })).toBeInTheDocument();
  });

  it('tells an unenrolled wallet it has no inbox', async () => {
    const { api } = stubApi([
      {
        method: 'GET',
        match: LIST,
        status: 403,
        body: { error: { code: 'FORBIDDEN', message: 'forbidden' } },
      },
    ]);
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    expect(await screen.findByRole('alert')).toHaveTextContent(/not enrolled/i);
  });
});

describe('VoterInbox list', () => {
  it('labels a proposal candidate "Seeking sponsorship" and never as an active proposal', async () => {
    const { api } = stubApi([{ method: 'GET', match: LIST, status: 200, body: listBody }]);
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });

    const candidate = await screen.findByText(/seeking sponsorship/i);
    expect(candidate).toHaveAttribute('data-kind', 'candidate');
    expect(screen.getByText(/Candidate “fund nouns”/)).toBeInTheDocument();
    expect(screen.getByText(/PRE_VOTE sponsorship request/i)).toBeInTheDocument();

    // The active proposal keeps the server's own stage vocabulary.
    expect(screen.getByText(/Proposal 812/)).toBeInTheDocument();
    const proposalBadge = screen.getByText('VOTING', { selector: '[data-kind="proposal"]' });
    expect(proposalBadge).toBeInTheDocument();
  });

  it('shows an empty inbox as empty rather than as a failure', async () => {
    const { api } = stubApi([{ method: 'GET', match: LIST, status: 200, body: { items: [] } }]);
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    expect(await screen.findByRole('status')).toHaveTextContent(/no requests yet/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports an unavailable inbox API in plain words, with no backend detail', async () => {
    const { api } = stubApi([
      { method: 'GET', match: LIST, status: 503, body: { error: { code: 'X', message: 'pg: FATAL role missing' } } },
    ]);
    const { container } = renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable right now/i);
    expect(container.textContent).not.toMatch(/pg:|FATAL/);
  });

  it('turns a malformed projection into a readable error instead of a half-drawn item', async () => {
    const { api } = stubApi([{ method: 'GET', match: LIST, status: 200, body: { notItems: [] } }]);
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot read/i);
  });
});

describe('VoterInbox detail', () => {
  async function openCandidate() {
    const { api, calls } = stubApi([
      { method: 'GET', match: LIST, status: 200, body: listBody },
      { method: 'GET', match: ITEM, status: 200, body: candidateInboxItem },
      { method: 'POST', match: ARCHIVE, status: 200, body: { id: candidateInboxItem.id, archived: true } },
    ]);
    const user = userEvent.setup();
    const rendered = renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    const buttons = await screen.findAllByRole('button', { name: /open request/i });
    await user.click(buttons[0]);
    await screen.findByRole('article', { name: /inbox item/i });
    return { user, calls, rendered };
  }

  it('fetches the individual item and shows message, stage, DAO, and time', async () => {
    const { calls } = await openCandidate();
    expect(calls.some((call) => call.includes('/v1/gate/me/inbox/inbox-candidate'))).toBe(true);
    const item = screen.getByRole('article', { name: /inbox item/i });
    expect(item).toHaveTextContent(/sponsor this candidate/i);
    expect(item).toHaveTextContent(/nouns/i);
    expect(item).toHaveTextContent(/PRE_VOTE/);
    expect(item).toHaveTextContent(/2026-09-18T00:10:00.000Z/);
    expect(item).toHaveTextContent(/not an active governance proposal/i);
  });

  it('renders advocate Markdown through the allowlist and never as HTML', async () => {
    const script = '<script>window.__pwned = 1</script> <img src="https://evil.example.com/x.png">';
    const { api } = stubApi([
      { method: 'GET', match: LIST, status: 200, body: { items: [candidateInboxItem] } },
      { method: 'GET', match: ITEM, status: 200, body: { ...candidateInboxItem, pitch: script } },
    ]);
    const user = userEvent.setup();
    const { container } = renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    await user.click(await screen.findByRole('button', { name: /open request/i }));
    await screen.findByRole('article', { name: /inbox item/i });

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('links HTTPS evidence only, never fetches it, and opens nothing on its own', async () => {
    const { calls } = await openCandidate();
    const item = screen.getByRole('article', { name: /inbox item/i });
    const links = Array.from(item.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(links).toContain('https://example.com/evidence');
    expect(links.every((href) => href?.startsWith('https://'))).toBe(true);

    // The non-HTTPS evidence URL is visible but inert: no href, no navigation.
    const blocked = item.querySelector('[data-blocked-url="true"]');
    expect(blocked).toHaveTextContent('http://insecure.example.com/leak');
    expect(blocked?.tagName).toBe('SPAN');

    // Nothing resolved, previewed, or unfurled an advocate URL: every request
    // this page made went to a Gate route, and none carried an evidence URL.
    expect(calls.every((call) => call.includes('/v1/gate/me/inbox'))).toBe(true);
    expect(calls.join(' ')).not.toContain('example.com');
    for (const anchor of item.querySelectorAll('a')) {
      expect(anchor.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('archives through the server and reflects what the server answered', async () => {
    const { user, calls } = await openCandidate();
    await user.click(screen.getByRole('button', { name: /archive this request/i }));
    await waitFor(() =>
      expect(calls.some((call) => call.includes('/inbox/inbox-candidate/archive'))).toBe(true),
    );
    expect(await screen.findByText('Archived', { selector: '.inbox-archived' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archive this request/i })).toBeNull();
  });

  it('keeps the item when archiving fails', async () => {
    const { api } = stubApi([
      { method: 'GET', match: LIST, status: 200, body: { items: [candidateInboxItem] } },
      { method: 'GET', match: ITEM, status: 200, body: candidateInboxItem },
      { method: 'POST', match: ARCHIVE, status: 500, body: null },
    ]);
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    await user.click(await screen.findByRole('button', { name: /open request/i }));
    await user.click(await screen.findByRole('button', { name: /archive this request/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable right now/i);
    expect(screen.getByRole('button', { name: /archive this request/i })).toBeInTheDocument();
  });

  it('reports a missing item without implying it exists elsewhere', async () => {
    const { api } = stubApi([
      { method: 'GET', match: LIST, status: 200, body: { items: [candidateInboxItem] } },
      { method: 'GET', match: ITEM, status: 404, body: { error: { code: 'NOT_FOUND', message: 'Not found' } } },
    ]);
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={stubWallet()} />, { session: inboxSession });
    await user.click(await screen.findByRole('button', { name: /open request/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer in your inbox/i);
  });

  it('returns to the list from an open item', async () => {
    const { user } = await openCandidate();
    await user.click(screen.getByRole('button', { name: /back to inbox/i }));
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
    expect(screen.getAllByRole('button', { name: /open request/i }).length).toBeGreaterThan(0);
  });

  it('never renders a reply or follow-up control the backend does not serve', async () => {
    await openCandidate();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /repl(y|ies)|follow.?up/i })).toBeNull();
  });
});
