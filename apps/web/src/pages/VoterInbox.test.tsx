import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoterInbox } from './VoterInbox';
import { App } from '../App';
import { useNavigate } from 'react-router-dom';
import { renderApp, stubApi, stubWallet } from '../test/harness';
import { useSession } from '../session';
import { ApiError } from '../http';
import type { InboxItem } from '../types';
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

  it('reuses the header connection and asks only for the signature', async () => {
    const { api, calls } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: sessionChallenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: inboxSession },
      { method: 'GET', match: LIST, status: 200, body: listBody },
    ]);
    const wallet = stubWallet({
      eth_accounts: () => [VOTER],
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={wallet} />, { walletAddress: VOTER });

    // The connected wallet is named, and the control asks to unlock, not to
    // connect something that is already connected.
    expect(screen.queryByRole('button', { name: /connect governance wallet/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /sign to unlock inbox/i }));
    await waitFor(() => expect(calls.some((call) => LIST.test(call))).toBe(true));

    // One signature, and no second connection prompt anywhere in the flow.
    expect(wallet.calls.map((call) => call.method)).toEqual([
      'eth_accounts',
      'eth_signTypedData_v4',
    ]);
    // Sharing the connection shares no authority: the inbox still opened on a
    // dao_inbox session it signed for on this page.
    const challenge = wallet.calls.find((call) => call.method === 'eth_signTypedData_v4');
    expect(JSON.stringify(challenge?.params)).toContain('dao_inbox');
  });

  it('will not mint an inbox session for an account the header never showed', async () => {
    const { api, calls } = stubApi([]);
    const other = `0x${'77'.repeat(20)}`;
    const wallet = stubWallet({
      eth_accounts: () => [other],
      eth_requestAccounts: () => [other],
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={wallet} />, { walletAddress: VOTER });
    await user.click(screen.getByRole('button', { name: /sign to unlock inbox/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer on the account/i);
    // Nothing was signed and no challenge was even requested.
    expect(calls).toEqual([]);
    expect(wallet.calls.map((call) => call.method)).toEqual(['eth_accounts']);
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
    // A person reads a time, not an ISO-8601 string. The exact instant stays
    // reachable as the title of the line that summarizes it.
    expect(item).toHaveTextContent('18 Sep 2026, 00:10 UTC');
    expect(item.textContent).not.toContain('2026-09-18T00:10:00.000Z');
    expect(item.querySelector('.inbox-meta')).toHaveAttribute(
      'title',
      '2026-09-18T00:10:00.000Z',
    );
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

/** Inbox identity comes from the authenticated wallet, never a local ENS lookup. */
describe('VoterInbox identity', () => {
  it('shows the signed-in wallet shortened', async () => {
    const { api } = stubApi([{ method: 'GET', match: LIST, status: 200, body: listBody }]);
    const { container } = renderApp(<VoterInbox api={api} wallet={stubWallet()} />, {
      session: inboxSession,
    });
    expect(await screen.findByText('0x4444…4444')).toBeInTheDocument();
    expect(container.textContent).not.toContain(VOTER);
  });

  it('keeps the authenticated wallet in every signed payload and request', async () => {
    const { api, calls } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: sessionChallenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: inboxSession },
      { method: 'GET', match: LIST, status: 200, body: listBody },
    ]);
    const wallet = signedWallet();
    const user = userEvent.setup();
    renderApp(<VoterInbox api={api} wallet={wallet} />);
    await user.click(screen.getByRole('button', { name: /connect governance wallet/i }));
    await screen.findByText('0x4444…4444');
    const signed = wallet.calls.find((call) => call.method === 'eth_signTypedData_v4');
    expect(JSON.stringify(signed?.params)).toContain(VOTER);
    expect(calls.join(' ')).not.toContain('.eth');
  });
});

/**
 * F3: private inbox state belongs to the exact `dao_inbox` session that
 * fetched it. A session change drops it, and a response that lands for the
 * previous session is discarded rather than stored or rendered.
 */
describe('VoterInbox session transitions', () => {
  const OTHER_WALLET = '0x6666666666666666666666666666666666666666';
  const sessionB = {
    token: 'j'.repeat(43),
    session: { ...inboxSession.session, wallet: OTHER_WALLET },
  };
  const itemB: InboxItem = {
    ...proposalInboxItem,
    id: 'inbox-b',
    pitch: 'Wallet B private pitch.',
    canonicalFacts: { ...proposalInboxItem.canonicalFacts, proposalId: '999', targetId: 'proposal:999' },
  };

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  function Controls() {
    const { session, setSession, clearSession } = useSession();
    return (
      <>
        <output data-testid="session-token">{session?.token ?? 'none'}</output>
        <button type="button" onClick={() => setSession(sessionB)}>
          test-switch-to-b
        </button>
        <button type="button" onClick={clearSession}>
          test-sign-out
        </button>
      </>
    );
  }

  function renderInbox(api: ReturnType<typeof stubApi>['api']) {
    return renderApp(
      <>
        <VoterInbox api={api} wallet={stubWallet()} />
        <Controls />
      </>,
      { session: inboxSession },
    );
  }

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  it("wallet A's late inbox list is discarded after switching to wallet B", async () => {
    const { api } = stubApi([]);
    const heldA = deferred<InboxItem[]>();
    vi.spyOn(api, 'listInbox').mockImplementation((token: string) =>
      token === inboxSession.token ? heldA.promise : Promise.resolve([itemB]),
    );
    const user = userEvent.setup();
    renderInbox(api);
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledWith(inboxSession.token));

    await user.click(screen.getByRole('button', { name: 'test-switch-to-b' }));
    expect(await screen.findByText(/proposal 999/i)).toBeInTheDocument();

    act(() => heldA.resolve([candidateInboxItem, proposalInboxItem]));
    await settle();

    expect(screen.queryByText(/proposal 812/i)).toBeNull();
    expect(screen.queryByText(/candidate/i)).toBeNull();
    expect(screen.getAllByRole('button', { name: /open request/i })).toHaveLength(1);
  });

  it("wallet A's late inbox list is discarded after signing out, and never shown after signing in again", async () => {
    const { api } = stubApi([]);
    const heldA = deferred<InboxItem[]>();
    const heldB = deferred<InboxItem[]>();
    vi.spyOn(api, 'listInbox').mockImplementation((token: string) =>
      token === inboxSession.token ? heldA.promise : heldB.promise,
    );
    const user = userEvent.setup();
    renderInbox(api);
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'test-sign-out' }));
    act(() => heldA.resolve([candidateInboxItem, proposalInboxItem]));
    await settle();
    expect(screen.queryByText(/proposal 812/i)).toBeNull();
    expect(screen.getByRole('button', { name: /connect governance wallet/i })).toBeEnabled();

    // Wallet B signs in; while B's own list is still loading, nothing of A's shows.
    await user.click(screen.getByRole('button', { name: 'test-switch-to-b' }));
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledWith(sessionB.token));
    expect(screen.queryByText(/proposal 812/i)).toBeNull();
    expect(screen.queryAllByRole('button', { name: /open request/i })).toHaveLength(0);
    act(() => heldB.resolve([itemB]));
    expect(await screen.findByText(/proposal 999/i)).toBeInTheDocument();
    expect(screen.queryByText(/proposal 812/i)).toBeNull();
  });

  it("wallet A's late item detail is never shown to wallet B", async () => {
    const { api } = stubApi([]);
    vi.spyOn(api, 'listInbox').mockImplementation((token: string) =>
      Promise.resolve(token === inboxSession.token ? [candidateInboxItem] : [itemB]),
    );
    const heldDetail = deferred<InboxItem | null>();
    vi.spyOn(api, 'getInboxItem').mockImplementation((token: string) =>
      token === inboxSession.token ? heldDetail.promise : Promise.resolve(itemB),
    );
    const user = userEvent.setup();
    renderInbox(api);
    await user.click(await screen.findByRole('button', { name: /open request/i }));
    await waitFor(() => expect(api.getInboxItem).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'test-switch-to-b' }));
    await screen.findByText(/proposal 999/i);
    act(() => heldDetail.resolve(candidateInboxItem));
    await settle();

    expect(screen.queryByRole('article', { name: /inbox item/i })).toBeNull();
    expect(screen.queryByText(/sponsor this candidate/i)).toBeNull();
  });

  it("an open item of wallet A is dropped the moment the session changes", async () => {
    const { api } = stubApi([]);
    vi.spyOn(api, 'listInbox').mockImplementation((token: string) =>
      Promise.resolve(token === inboxSession.token ? [candidateInboxItem] : [itemB]),
    );
    vi.spyOn(api, 'getInboxItem').mockResolvedValue(candidateInboxItem);
    const user = userEvent.setup();
    renderInbox(api);
    await user.click(await screen.findByRole('button', { name: /open request/i }));
    expect(await screen.findByRole('article', { name: /inbox item/i })).toHaveTextContent(/sponsor this candidate/i);

    await user.click(screen.getByRole('button', { name: 'test-switch-to-b' }));
    expect(screen.queryByRole('article', { name: /inbox item/i })).toBeNull();
    expect(screen.queryByText(/sponsor this candidate/i)).toBeNull();
  });

  it("a late 401 for wallet A does not sign wallet B out", async () => {
    const { api } = stubApi([]);
    const heldA = deferred<InboxItem[]>();
    vi.spyOn(api, 'listInbox').mockImplementation((token: string) =>
      token === inboxSession.token ? heldA.promise : Promise.resolve([itemB]),
    );
    const user = userEvent.setup();
    renderInbox(api);
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'test-switch-to-b' }));
    await screen.findByText(/proposal 999/i);

    act(() => heldA.reject(new ApiError('gate', 401, 'UNAUTHORIZED', 'expired', null)));
    await settle();

    expect(screen.getByTestId('session-token')).toHaveTextContent(sessionB.token);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});


/**
 * N4: leaving the inbox ends the authority of everything it had in flight. A
 * late list, detail or archive response — success, 401 or 403 — may not
 * store data, report an error, or clear the session the app now holds.
 */
describe('VoterInbox after it unmounts', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  function Probe() {
    const navigate = useNavigate();
    const { session } = useSession();
    return (
      <>
        <output data-testid="session-token">{session?.token ?? 'none'}</output>
        <button type="button" onClick={() => navigate('/daos')}>
          test-leave
        </button>
      </>
    );
  }

  function renderInboxRoute(api: ReturnType<typeof stubApi>['api']) {
    return renderApp(
      <>
        <App />
        <Probe />
      </>,
      { gate: api, route: '/gate/inbox', session: inboxSession },
    );
  }

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const expired = () => new ApiError('gate', 401, 'UNAUTHORIZED', 'expired', null);
  const notEnrolled = () => new ApiError('gate', 403, 'FORBIDDEN', 'not enrolled', null);

  it('a late 401 on the inbox list does not clear the session after leaving', async () => {
    const { api } = stubApi([]);
    const list = deferred<InboxItem[]>();
    vi.spyOn(api, 'listInbox').mockImplementation(() => list.promise);
    const user = userEvent.setup();
    renderInboxRoute(api);
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'test-leave' }));
    act(() => list.reject(expired()));
    await settle();

    expect(screen.getByTestId('session-token')).toHaveTextContent(inboxSession.token);
    expect(screen.queryByText(/inbox session expired/i)).toBeNull();
  });

  it('a late 403 on an item detail does not clear the session after leaving', async () => {
    const { api } = stubApi([]);
    vi.spyOn(api, 'listInbox').mockResolvedValue([candidateInboxItem]);
    const detail = deferred<InboxItem | null>();
    vi.spyOn(api, 'getInboxItem').mockImplementation(() => detail.promise);
    const user = userEvent.setup();
    renderInboxRoute(api);
    await user.click(await screen.findByRole('button', { name: /open request/i }));
    await waitFor(() => expect(api.getInboxItem).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'test-leave' }));
    act(() => detail.reject(notEnrolled()));
    await settle();

    expect(screen.getByTestId('session-token')).toHaveTextContent(inboxSession.token);
    expect(screen.queryByText(/not enrolled as a Gate voter/i)).toBeNull();
  });

  it('a late 401 on archive does not clear the session after leaving', async () => {
    const { api } = stubApi([]);
    vi.spyOn(api, 'listInbox').mockResolvedValue([candidateInboxItem]);
    vi.spyOn(api, 'getInboxItem').mockResolvedValue(candidateInboxItem);
    const archive = deferred<{ id: string; archived: boolean }>();
    vi.spyOn(api, 'archiveInboxItem').mockImplementation(() => archive.promise as never);
    const user = userEvent.setup();
    renderInboxRoute(api);
    await user.click(await screen.findByRole('button', { name: /open request/i }));
    await user.click(await screen.findByRole('button', { name: /archive/i }));
    await waitFor(() => expect(api.archiveInboxItem).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'test-leave' }));
    act(() => archive.reject(expired()));
    await settle();

    expect(screen.getByTestId('session-token')).toHaveTextContent(inboxSession.token);
  });

  it('late private data after leaving is neither rendered nor shown on return', async () => {
    const { api } = stubApi([]);
    const first = deferred<InboxItem[]>();
    let calls = 0;
    vi.spyOn(api, 'listInbox').mockImplementation(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve([]);
    });
    const user = userEvent.setup();
    renderInboxRoute(api);
    await waitFor(() => expect(api.listInbox).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'test-leave' }));
    act(() => first.resolve([candidateInboxItem, proposalInboxItem]));
    await settle();

    expect(screen.queryByText(/proposal 812/i)).toBeNull();
    expect(screen.queryByText(/sponsor this candidate/i)).toBeNull();
    expect(screen.getByTestId('session-token')).toHaveTextContent(inboxSession.token);
  });
});
