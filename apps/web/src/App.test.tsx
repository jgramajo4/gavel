import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigate } from 'react-router-dom';
import { App } from './App';
import { renderApp, stubApi, stubFetch, stubIndex, stubWallet, type RenderAppOptions, type StubRoute } from './test/harness';
import { acceptingProfile, VOTER, PAYER, profileSession, inboxSession } from './test/fixtures';
import { useSession } from './session';
import { createIndexApi, type IndexApi, type IndexedProposal } from './index-api';
import { DAOS } from './daos';
import { AGENTS, RECIPES } from './install';

const gateRoutes: StubRoute[] = [
  { method: 'GET', match: /\/v1\/gates\?/, status: 200, body: { items: [acceptingProfile] } },
  { method: 'GET', match: /\/v1\/gates\/0x/, status: 200, body: acceptingProfile },
  { method: 'GET', match: /\/v1\/gate\/me\/inbox$/, status: 404, body: null },
];

/** Shaped like a real index.0773h.com proposal row. */
function proposalRow(dao: string, id: string, title: string, createdAt = '2026-09-28T04:03:35.000Z') {
  return {
    id,
    dao,
    title,
    state: 'ACTIVE',
    sourceState: 'ACTIVE',
    effectiveStatus: 'ACTIVE',
    proposer: '0xae4705dC0816ee6d8a13F1C72780Ec5021915Fed',
    createdAt,
    createdBlock: '26073434',
    forVotes: '8',
    againstVotes: '0',
    abstainVotes: '0',
    quorumVotes: '136',
    description: '# Title\n\n<script>alert(1)</script>',
    identity: { dao, chainId: 1, governorAddress: '0x6f3e6272a167e8accb32072d08e0957f9c79223d', proposalId: id },
  };
}

const indexRoutes: StubRoute[] = [
  { method: 'GET', match: /\/v1\/daos\/nouns\/proposals\/1000$/, status: 200, body: proposalRow('nouns', '1000', 'Approve noun.wtf') },
  { method: 'GET', match: /\/v1\/daos\/nouns\/proposals\/9$/, status: 404, body: { error: 'proposal_not_found' } },
  {
    method: 'GET',
    match: /\/v1\/daos\/nouns\/proposals\?/,
    status: 200,
    body: { items: [proposalRow('nouns', '1001', 'Nouns proposal 1001'), proposalRow('nouns', '1000', 'Approve noun.wtf')], nextCursor: null },
  },
  {
    method: 'GET',
    match: /\/v1\/daos\/ens\/proposals\?/,
    status: 200,
    body: {
      items: [
        proposalRow('ens', '11561586', 'ENS old', '2022-03-21T00:00:00.000Z'),
        proposalRow('ens', '10731397', 'ENS newest', '2026-08-31T00:00:00.000Z'),
      ],
      nextCursor: null,
    },
  },
  { method: 'GET', match: /\/v1\/daos\/railgun-eth\/proposals\?/, status: 200, body: { items: [proposalRow('railgun-eth', '32', 'Railgun 32')], nextCursor: null } },
];

function renderRoute(route: string, options: RenderAppOptions = {}) {
  const gate = stubApi(gateRoutes);
  const index = stubIndex(indexRoutes);
  const wallet = options.provider ?? stubWallet();
  return {
    wallet,
    gateCalls: gate.calls,
    indexCalls: index.calls,
    ...renderApp(<App />, { gate: gate.api, index: index.index, ...options, route, provider: wallet }),
  };
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

/** A connected wallet that is not the directory fixture's voter. */
const CONNECTED = '0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1';
const SHORT_CONNECTED = '0x650C…50E1';

/** Every canonical route a person can load directly (deep link / reload). */
const ROUTES: [string, RegExp][] = [
  ['/', /governance without the tab sprawl/i],
  ['/daos', /governance gavel follows/i],
  ['/daos/nouns', /^nouns$/i],
  ['/daos/ens/proposals', /^ens$/i],
  ['/install', /how do you want to use gavel/i],
  ['/gate', /gate directory/i],
  [`/gate/voters/${VOTER}`, /gate profile/i],
  [`/gate/voters/${VOTER}/compose`, /paid submission/i],
  ['/gate/inbox', /voter inbox/i],
  ['/gate/enroll', /enroll/i],
];

describe('routing: direct loads of every canonical route', () => {
  beforeEach(() => setViewport(1280));

  it.each(ROUTES)('renders %s on desktop', async (route, heading) => {
    renderRoute(route);
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
  });

  it.each(ROUTES)('renders %s on mobile', async (route, heading) => {
    setViewport(390);
    renderRoute(route);
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    // The mobile layout must not depend on a pointer-only control.
    expect(document.querySelector('[data-pointer-only="true"]')).toBeNull();
  });

  it('exposes a skip link and landmark navigation', async () => {
    renderRoute('/');
    expect(await screen.findByRole('link', { name: /skip to main content/i })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('renders a not-found page for an unknown route', async () => {
    renderRoute('/nope');
    expect(await screen.findByRole('heading', { name: /not found/i, level: 1 })).toBeInTheDocument();
  });
});

describe('legacy Gate URLs', () => {
  it.each([
    [`/gates/${VOTER}`, /gate profile/i],
    [`/gates/${VOTER}/compose`, /paid submission/i],
    ['/inbox', /voter inbox/i],
    ['/enroll', /enroll/i],
  ])('forwards %s to its canonical Gate route', async (route, heading) => {
    renderRoute(route);
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
  });

  it('refuses a malformed legacy wallet instead of guessing', async () => {
    const { gateCalls } = renderRoute('/gates/not-a-wallet');
    expect(await screen.findByRole('heading', { name: /not found/i, level: 1 })).toBeInTheDocument();
    expect(gateCalls).toEqual([]);
  });
});

describe('global navigation', () => {
  it('uses the canonical route model for every internal destination', async () => {
    renderRoute('/');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'DAOs' })).toHaveAttribute('href', '/daos');
    expect(within(nav).getByRole('link', { name: 'Gate' })).toHaveAttribute('href', '/gate');
    expect(within(nav).getByRole('link', { name: 'Install' })).toHaveAttribute('href', '/install');
    expect(within(nav).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', expect.stringMatching(/^https:\/\//));
  });

  it('Gate directory links point inside /gate, never at legacy paths', async () => {
    renderRoute('/gate');
    const list = await screen.findByRole('list', { name: 'Gates' });
    expect(within(list).getAllByRole('link')[0]).toHaveAttribute('href', `/gate/voters/${acceptingProfile.wallet}`);
  });

  it('Gate profile links to the canonical composer', async () => {
    renderRoute(`/gate/voters/${VOTER}`);
    expect(await screen.findByRole('link', { name: /submit a paid pitch/i })).toHaveAttribute(
      'href',
      `/gate/voters/${acceptingProfile.wallet}/compose`,
    );
  });

  it('Gate profile → another profile never keeps the first wallet on screen while the next one loads', async () => {
    const OTHER = '0x5555555555555555555555555555555555555555';
    const pending = new Map<string, () => void>();
    const gate = stubApi([]);
    const api = {
      ...gate.api,
      // Ignores abort on purpose so the old response really lands.
      getGate: (wallet: string) =>
        new Promise<typeof acceptingProfile>((resolve) =>
          pending.set(wallet.toLowerCase(), () => resolve({ ...acceptingProfile, wallet })),
        ),
    } as typeof gate.api;
    function GoTo() {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate(`/gate/voters/${OTHER}`)}>go other</button>;
    }
    const user = userEvent.setup();
    renderApp(
      <>
        <App />
        <GoTo />
      </>,
      { route: `/gate/voters/${VOTER}`, gate: api },
    );
    // The full wallet is rendered in the profile's address row.
    const shown = () => Array.from(document.querySelectorAll('.profile-wallet')).map((node) => node.textContent?.toLowerCase());
    await waitFor(() => expect(pending.has(VOTER.toLowerCase())).toBe(true));
    await act(async () => pending.get(VOTER.toLowerCase())!());
    await waitFor(() => expect(shown()).toEqual([VOTER.toLowerCase()]));
    await user.click(screen.getByRole('button', { name: 'go other' }));
    await waitFor(() => expect(pending.has(OTHER)).toBe(true));
    // While OTHER is still loading, VOTER's profile (and its compose link) must be gone.
    expect(shown()).toEqual([]);
    expect(screen.queryByRole('link', { name: /submit a paid pitch/i })).toBeNull();
    await act(async () => pending.get(OTHER)!());
    await waitFor(() => expect(shown()).toEqual([OTHER]));
  });

  it('the mobile menu toggles the primary navigation and closes on navigation', async () => {
    setViewport(390);
    const user = userEvent.setup();
    renderRoute('/');
    const toggle = screen.getByRole('button', { name: 'Menu' });
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(nav).toHaveAttribute('data-open', 'true');
    await user.click(within(nav).getByRole('link', { name: 'Install' }));
    expect(await screen.findByRole('heading', { name: /how do you want to use gavel/i, level: 1 })).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('DAO routing and capabilities', () => {
  it('lists every registered DAO from the registry', async () => {
    renderRoute('/daos');
    const list = screen.getByRole('list', { name: 'DAOs' });
    for (const dao of DAOS) expect(within(list).getByRole('link', { name: dao.name })).toHaveAttribute('href', `/daos/${dao.id}`);
  });

  it('browses a DAO without a wallet and reads the index by its index id', async () => {
    const { wallet, indexCalls } = renderRoute('/daos/railgun');
    expect(await screen.findByRole('link', { name: 'Railgun 32' })).toHaveAttribute('href', '/daos/railgun/proposals/32');
    expect(indexCalls.length).toBeGreaterThan(0);
    expect(indexCalls.every((call) => call.includes('/v1/daos/railgun-eth/'))).toBe(true);
    expect((wallet as ReturnType<typeof stubWallet>).calls).toEqual([]);
  });

  it('shows only the sections a DAO supports', async () => {
    renderRoute('/daos/ens');
    const tabs = screen.getByRole('navigation', { name: /ens sections/i });
    expect(within(tabs).getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview', 'Recent proposals']);
  });

  it('shows the Gate entry point only for DAOs with the Gate capability', async () => {
    const nouns = renderRoute('/daos/nouns');
    expect(await screen.findByRole('link', { name: /open the gate directory/i })).toHaveAttribute('href', '/gate');
    nouns.unmount();
    renderRoute('/daos/ens');
    await screen.findByRole('link', { name: 'ENS newest' });
    expect(screen.queryByRole('link', { name: /open the gate directory/i })).toBeNull();
  });

  it.each(['/daos/unknown', '/daos/NOUNS', '/daos/ens/streams', '/daos/ens/gate', '/daos/nouns/proposals/abc'])(
    'refuses %s without calling the index',
    async (route) => {
      const { indexCalls } = renderRoute(route);
      expect(await screen.findByRole('heading', { name: /not found/i, level: 1 })).toBeInTheDocument();
      expect(indexCalls).toEqual([]);
    },
  );

  it('orders hashed-id DAOs newest first', async () => {
    renderRoute('/daos/ens/proposals');
    const list = await screen.findByRole('list', { name: /ens proposals/i });
    const titles = within(list)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(titles).toEqual(['ENS newest', 'ENS old']);
  });

  it('loads a proposal deep link directly and renders author text inert', async () => {
    renderRoute('/daos/nouns/proposals/1000');
    expect(await screen.findByRole('heading', { name: 'Approve noun.wtf', level: 2 })).toBeInTheDocument();
    expect(document.querySelector('main script')).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.getByText(/onchain fact from the gavel governance indexer/i)).toBeInTheDocument();
  });

  it('reports an unknown proposal as not found', async () => {
    renderRoute('/daos/nouns/proposals/9');
    expect(await screen.findByText(/the index has no nouns proposal #9/i)).toHaveAttribute('data-error-kind', 'not_found');
  });

  it('reports an unavailable index as retryable, without breaking the shell', async () => {
    const index = createIndexApi('', stubFetch([{ method: 'GET', match: /proposals/, status: 503, body: { error: 'unavailable' } }]));
    renderApp(<App />, { route: '/daos/nouns/proposals', index });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-error-kind', 'retryable');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
  });

  it('reports a network failure as retryable with its own code', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    renderApp(<App />, { route: '/daos/nouns/proposals', index: createIndexApi('', failing) });
    expect(await screen.findByRole('alert')).toHaveAttribute('data-error-code', 'NETWORK_UNAVAILABLE');
  });

  it('proposal → proposal in the same mounted page: a late response for the old id never renders', async () => {
    const pending = new Map<string, (title: string) => void>();
    const proposal = (id: string, title: string): IndexedProposal => ({
      dao: 'nouns',
      id,
      title,
      proposer: null,
      createdAt: null,
      effectiveStatus: 'ACTIVE',
      sourceState: null,
      forVotes: null,
      againstVotes: null,
      abstainVotes: null,
      quorumVotes: null,
      description: null,
      provenance: { origin: 'onchain', chainId: 1, sourceContract: null, createdBlock: null },
    });
    const index: IndexApi = {
      listDaos: async () => [],
      listProposals: async () => ({ items: [], nextCursor: null }),
      // Ignores abort on purpose: the old response really does arrive late.
      getProposal: (_dao, id) => new Promise((resolve) => pending.set(id, (title) => resolve(proposal(id, title)))),
    };
    function GoTo({ to }: { to: string }) {
      const navigate = useNavigate();
      return <button type="button" onClick={() => navigate(to)}>go {to}</button>;
    }
    const user = userEvent.setup();
    renderApp(
      <>
        <App />
        <GoTo to="/daos/nouns/proposals/1001" />
      </>,
      { route: '/daos/nouns/proposals/1000', index },
    );
    await waitFor(() => expect(pending.has('1000')).toBe(true));
    await user.click(screen.getByRole('button', { name: /go \/daos\/nouns\/proposals\/1001/ }));
    await waitFor(() => expect(pending.has('1001')).toBe(true));
    await act(async () => pending.get('1000')!('STALE 1000'));
    expect(screen.queryByText('STALE 1000')).toBeNull();
    expect(screen.getByText('Loading proposal…')).toBeInTheDocument();
    await act(async () => pending.get('1001')!('Fresh 1001'));
    expect(await screen.findByRole('heading', { name: 'Fresh 1001', level: 2 })).toBeInTheDocument();
    expect(screen.queryByText('STALE 1000')).toBeNull();
  });

  it('never shows the previous DAO after navigating, even when its response arrives late', async () => {
    let releaseNouns: (() => void) | null = null;
    const row = (dao: string, title: string): IndexedProposal => ({
      dao,
      id: '1',
      title,
      proposer: null,
      createdAt: null,
      effectiveStatus: null,
      sourceState: null,
      forVotes: null,
      againstVotes: null,
      abstainVotes: null,
      quorumVotes: null,
      description: null,
      provenance: { origin: 'onchain', chainId: 1, sourceContract: null, createdBlock: null },
    });
    const index: IndexApi = {
      listDaos: async () => [],
      getProposal: async () => null,
      // Deliberately ignores abort, so the late response really arrives.
      listProposals: (dao) =>
        new Promise((resolve) => {
          if (dao === 'nouns') releaseNouns = () => resolve({ items: [row(dao, 'STALE NOUNS')], nextCursor: null });
          else resolve({ items: [row(dao, 'Fresh ENS')], nextCursor: null });
        }),
    };
    const user = userEvent.setup();
    renderApp(<App />, { route: '/daos/nouns', index });
    await user.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'DAOs' }));
    await user.click(screen.getByRole('link', { name: 'ENS' }));
    expect(await screen.findByRole('link', { name: 'Fresh ENS' })).toBeInTheDocument();
    await act(async () => releaseNouns?.());
    expect(screen.queryByText('STALE NOUNS')).toBeNull();
  });
});

describe('homepage', () => {
  it('shows per-DAO latest proposals from the index, with no wallet', async () => {
    const { wallet } = renderRoute('/');
    for (const dao of DAOS) expect(screen.getByRole('region', { name: `${dao.name} latest proposals` })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Nouns proposal 1001' })).toHaveAttribute('href', '/daos/nouns/proposals/1001');
    expect((wallet as ReturnType<typeof stubWallet>).calls).toEqual([]);
  });

  it('keeps other DAOs visible when one DAO fails', async () => {
    const index = createIndexApi(
      '',
      stubFetch([{ method: 'GET', match: /\/v1\/daos\/ens\//, status: 500, body: null }, ...indexRoutes]),
    );
    renderApp(<App />, { route: '/', index });
    expect(await screen.findByText(/ens is unavailable right now/i)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Railgun 32' })).toBeInTheDocument();
  });
});

describe('install and Governance Brief', () => {
  it('renders every agent integration as a peer, with honest status', async () => {
    renderRoute('/install');
    const agents = screen.getByRole('list', { name: 'Agents' });
    for (const agent of AGENTS) {
      const card = agents.querySelector(`[data-install="${agent.id}"]`) as HTMLElement;
      expect(within(card).getByRole('heading', { name: agent.name })).toBeInTheDocument();
      expect(card).toHaveAttribute('data-status', agent.status);
      // A one-step claim must come with the real command; an unpackaged one must show none.
      if (agent.status === 'one_command') {
        expect(within(card).getByRole('button', { name: new RegExp(`copy ${agent.name}`, 'i') })).toBeInTheDocument();
      }
      if (agent.status === 'not_packaged') expect(within(card).queryByRole('button')).toBeNull();
    }
  });

  it('copies the Governance Brief prompt exactly', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderRoute('/install');
    await user.click(screen.getByRole('button', { name: /copy governance brief prompt/i }));
    expect(writeText).toHaveBeenCalledWith(RECIPES[0].prompt);
    expect(await screen.findByText('Copied.')).toBeInTheDocument();
  });

  it('falls back to selecting the text when the clipboard is refused', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
      configurable: true,
    });
    renderRoute('/');
    await user.click(screen.getByRole('button', { name: /copy governance brief prompt/i }));
    expect(await screen.findByText(/press ctrl\+c/i)).toBeInTheDocument();
  });
});

/**
 * The global wallet control. It shows WHICH wallet is connected and never
 * implies that connecting granted anything: `dao_profile`, `dao_inbox`, and
 * `base_sender` are separate role-scoped sessions, obtained by signing.
 */
describe('global wallet control', () => {
  beforeEach(() => setViewport(1280));

  it('offers a connect control in the header when no wallet is connected', async () => {
    renderRoute('/');
    const header = screen.getByRole('banner');
    expect(await within(header).findByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
  });

  it('is reachable from every surface, public and Gate alike', async () => {
    for (const route of ['/', '/daos/nouns', '/install', '/gate', '/gate/enroll', '/gate/inbox']) {
      const view = renderRoute(route);
      const header = screen.getByRole('banner');
      expect(within(header).getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
      view.unmount();
    }
  });

  it('shows a shortened address, never the whole one, and never resolves a name itself', async () => {
    renderRoute('/', { walletAddress: CONNECTED });
    const header = screen.getByRole('banner');
    expect(await within(header).findByText(SHORT_CONNECTED)).toBeInTheDocument();
    expect(header.textContent).not.toContain(CONNECTED);
  });

  it('connects on request through the injected wallet', async () => {
    const provider = stubWallet({ eth_requestAccounts: () => [CONNECTED] });
    const user = userEvent.setup();
    renderRoute('/', { provider });
    await user.click(screen.getByRole('button', { name: /connect wallet/i }));
    expect(await screen.findByText(SHORT_CONNECTED)).toBeInTheDocument();
    expect(provider.calls.map((call) => call.method)).toEqual(['eth_requestAccounts']);
  });

  it('signs nothing and grants no role session by connecting', async () => {
    const provider = stubWallet({ eth_requestAccounts: () => [CONNECTED] });
    const user = userEvent.setup();
    const { gateCalls } = renderRoute('/', { provider });
    await user.click(screen.getByRole('button', { name: /connect wallet/i }));
    await screen.findByText(SHORT_CONNECTED);
    expect(provider.calls.some((call) => call.method === 'eth_signTypedData_v4')).toBe(false);
    expect(gateCalls.some((call) => /auth\/(challenge|verify)/.test(call))).toBe(false);
    await user.click(screen.getByRole('button', { name: /connected wallet/i }));
    expect(screen.getByText(/each workflow still asks you to sign/i)).toBeInTheDocument();
  });

  it('names the role a signed session was issued for rather than implying access', async () => {
    const user = userEvent.setup();
    renderRoute('/', { walletAddress: VOTER, session: profileSession });
    await user.click(screen.getByRole('button', { name: /connected wallet/i }));
    expect(screen.getByText(/dao_profile/)).toBeInTheDocument();
  });

  it('drops the in-memory role session when the wallet disconnects', async () => {
    const user = userEvent.setup();
    renderRoute('/gate/inbox', { walletAddress: VOTER, session: profileSession });
    await user.click(screen.getByRole('button', { name: /connected wallet/i }));
    await user.click(screen.getByRole('button', { name: /disconnect/i }));
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
  });

  it('keeps the inbox behind its own dao_inbox session even with a wallet connected', async () => {
    renderRoute('/gate/inbox', { walletAddress: VOTER });
    expect(await screen.findByRole('button', { name: /sign to unlock inbox/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect governance wallet/i })).toBeNull();
    expect(screen.queryByRole('list', { name: /inbox/i })).toBeNull();
  });
});

/**
 * Session ↔ wallet binding across the long-lived shell. A session must never
 * outlive the account it was issued for, on any route, and a reconnect must
 * never restore signing readiness by itself.
 */
describe('session follows the live wallet across navigation', () => {
  function listenable(initial: string[]) {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let accounts = initial;
    return Object.assign(stubWallet({ eth_accounts: () => accounts, eth_requestAccounts: () => accounts }), {
      on(event: string, listener: (...args: unknown[]) => void) {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(listener);
      },
      emit(event: string, ...args: unknown[]) {
        if (event === 'accountsChanged') accounts = args[0] as string[];
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    });
  }

  function ActiveSession() {
    const { session } = useSession();
    return <output data-testid="active-session">{session ? `${session.session.role}:${session.session.wallet}` : 'none'}</output>;
  }
  const active = () => screen.getByTestId('active-session').textContent;

  it('Home → DAO → proposal → Gate keeps the session, then an account switch clears it everywhere', async () => {
    const wallet = listenable([VOTER]);
    const user = userEvent.setup();
    renderApp(
      <>
        <App />
        <ActiveSession />
      </>,
      { route: '/', gate: stubApi(gateRoutes).api, index: stubIndex(indexRoutes).index, provider: wallet, walletAddress: VOTER, session: inboxSession },
    );
    expect(active()).toBe(`dao_inbox:${VOTER}`);
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    await user.click(within(primary).getByRole('link', { name: 'DAOs' }));
    await user.click(screen.getByRole('link', { name: 'Nouns' }));
    await user.click(await screen.findByRole('link', { name: 'Approve noun.wtf' }));
    expect(await screen.findByRole('heading', { name: 'Approve noun.wtf', level: 2 })).toBeInTheDocument();
    await user.click(within(primary).getByRole('link', { name: 'Gate' }));
    expect(await screen.findByRole('heading', { name: /gate directory/i, level: 1 })).toBeInTheDocument();
    expect(active()).toBe(`dao_inbox:${VOTER}`);

    act(() => wallet.emit('accountsChanged', [PAYER]));
    await waitFor(() => expect(active()).toBe('none'));
    // Switching back does not resurrect it.
    act(() => wallet.emit('accountsChanged', [VOTER]));
    expect(active()).toBe('none');
  });

  it('clears the session when the wallet locks, and a reconnect does not restore it', async () => {
    const wallet = listenable([VOTER]);
    renderApp(
      <>
        <App />
        <ActiveSession />
      </>,
      { route: '/gate/inbox', gate: stubApi(gateRoutes).api, provider: wallet, walletAddress: VOTER, session: inboxSession },
    );
    expect(active()).toBe(`dao_inbox:${VOTER}`);
    act(() => wallet.emit('accountsChanged', []));
    await waitFor(() => expect(active()).toBe('none'));
    act(() => wallet.emit('accountsChanged', [VOTER]));
    expect(active()).toBe('none');
    // The private inbox is locked again and asks for a fresh signature.
    expect(await screen.findByRole('button', { name: /sign to unlock inbox/i })).toBeInTheDocument();
  });

  it('a chain switch neither clears the session nor blocks public browsing nor forces a chain', async () => {
    const wallet = listenable([VOTER]);
    const user = userEvent.setup();
    renderApp(
      <>
        <App />
        <ActiveSession />
      </>,
      {
        route: '/daos/nouns',
        gate: stubApi(gateRoutes).api,
        index: stubIndex(indexRoutes).index,
        provider: wallet,
        walletAddress: VOTER,
        session: inboxSession,
      },
    );
    act(() => wallet.emit('chainChanged', '0x2105'));
    expect(active()).toBe(`dao_inbox:${VOTER}`);
    await user.click(screen.getByRole('link', { name: 'Recent proposals' }));
    expect(await screen.findByRole('link', { name: 'Nouns proposal 1001' })).toBeInTheDocument();
    expect(wallet.calls.some((call) => call.method === 'wallet_switchEthereumChain')).toBe(false);
  });

  it('a deep-link reload with no wallet connection holds no ambient authority', async () => {
    renderRoute('/gate/inbox');
    expect(await screen.findByRole('button', { name: /connect governance wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /inbox/i })).toBeNull();
  });
});

describe('responsive header', () => {
  it('keeps brand, every nav destination, and the wallet control at phone width', async () => {
    setViewport(390);
    renderRoute('/', { walletAddress: CONNECTED });
    const header = screen.getByRole('banner');
    expect(within(header).getByLabelText(/gavel home/i)).toBeInTheDocument();
    for (const label of ['DAOs', 'Gate', 'Install', 'Docs']) {
      expect(within(header).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(await within(header).findByText(SHORT_CONNECTED)).toBeInTheDocument();
    // One primary navigation landmark, one wallet control: nothing duplicated
    // into a second mobile-only copy that could overflow or double-announce.
    expect(within(header).getAllByRole('navigation')).toHaveLength(1);
    expect(header.querySelectorAll('.wallet-control')).toHaveLength(1);
  });
});
