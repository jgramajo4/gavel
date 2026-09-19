import { describe, expect, it, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { renderApp, stubApi, stubEnsResolver, stubWallet, type RenderAppOptions } from './test/harness';
import { acceptingProfile, VOTER, profileSession } from './test/fixtures';

const routes = [
  { method: 'GET', match: /\/v1\/gates\?/, status: 200, body: { items: [acceptingProfile] } },
  { method: 'GET', match: /\/v1\/gates\/0x/, status: 200, body: acceptingProfile },
  { method: 'GET', match: /\/v1\/gate\/me\/inbox$/, status: 404, body: null },
];

function renderRoute(route: string, options: RenderAppOptions = {}) {
  const { api } = stubApi(routes);
  const wallet = options.provider ?? stubWallet();
  return {
    wallet,
    ...renderApp(<App api={api} wallet={wallet} />, { ...options, route, provider: wallet }),
  };
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

/** A connected wallet that is not the directory fixture's voter. */
const CONNECTED = '0x650C1B4D2f5B9e3a0f8C7d6E5a4B3c2d1E0f50E1';
const SHORT_CONNECTED = '0x650C…50E1';

const ROUTES: [string, RegExp][] = [
  ['/', /gate directory/i],
  [`/gates/${VOTER}`, /gate profile/i],
  [`/gates/${VOTER}/compose`, /paid submission/i],
  ['/inbox', /voter inbox/i],
  ['/enroll', /enroll/i],
];

describe('App routing smoke tests', () => {
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
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('renders a not-found page for an unknown route', async () => {
    renderRoute('/nope');
    expect(await screen.findByRole('heading', { name: /not found/i, level: 1 })).toBeInTheDocument();
  });
});

/**
 * The global wallet control.
 *
 * It is the header's only job to show WHICH wallet is connected. It must never
 * imply that connecting granted anything: `dao_profile`, `dao_inbox`, and
 * `base_sender` are separate role-scoped sessions, obtained by signing, and
 * this control issues none of them.
 */
describe('global wallet control', () => {
  beforeEach(() => setViewport(1280));

  it('offers a connect control in the header when no wallet is connected', async () => {
    renderRoute('/');
    const header = screen.getByRole('banner');
    expect(await within(header).findByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
  });

  it('is reachable from every page, not only from a wallet workflow', async () => {
    for (const route of ['/', '/enroll', '/inbox']) {
      const view = renderRoute(route);
      const header = screen.getByRole('banner');
      expect(within(header).getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
      view.unmount();
    }
  });

  it('shows a shortened address, never the whole one, when there is no ENS name', async () => {
    renderRoute('/', { walletAddress: CONNECTED });
    const header = screen.getByRole('banner');
    expect(await within(header).findByText(SHORT_CONNECTED)).toBeInTheDocument();
    expect(header.textContent).not.toContain(CONNECTED);
  });

  it('shows the ENS name when one resolves, and still not the whole address', async () => {
    renderRoute('/', { walletAddress: CONNECTED, ens: stubEnsResolver({ [CONNECTED]: 'voter.eth' }) });
    const header = screen.getByRole('banner');
    expect(await within(header).findByText('voter.eth')).toBeInTheDocument();
    expect(header.textContent).not.toContain(CONNECTED);
  });

  it('falls back to the shortened address when ENS resolves to nothing', async () => {
    renderRoute('/', { walletAddress: CONNECTED, ens: stubEnsResolver({}) });
    const header = screen.getByRole('banner');
    expect(await within(header).findByText(SHORT_CONNECTED)).toBeInTheDocument();
    expect(within(header).queryByText(/\.eth$/)).toBeNull();
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
    const { calls } = stubApi(routes);
    renderRoute('/', { provider });
    await user.click(screen.getByRole('button', { name: /connect wallet/i }));
    await screen.findByText(SHORT_CONNECTED);
    // No challenge, no signature, no session exchange.
    expect(provider.calls.some((call) => call.method === 'eth_signTypedData_v4')).toBe(false);
    expect(calls.some((call) => /auth\/(challenge|verify)/.test(call))).toBe(false);

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
    renderRoute('/inbox', { walletAddress: VOTER, session: profileSession });
    await user.click(screen.getByRole('button', { name: /connected wallet/i }));
    await user.click(screen.getByRole('button', { name: /disconnect/i }));
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
  });

  it('keeps the inbox behind its own dao_inbox session even with a wallet connected', async () => {
    renderRoute('/inbox', { walletAddress: VOTER });
    // A globally connected wallet is identity; the inbox still asks for a
    // signature before it will read anything.
    expect(
      await screen.findByRole('button', { name: /connect governance wallet/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /inbox/i })).toBeNull();
  });
});

describe('responsive header', () => {
  it('keeps brand, every nav destination, and the wallet control at phone width', async () => {
    setViewport(390);
    renderRoute('/', { walletAddress: CONNECTED });
    const header = screen.getByRole('banner');
    expect(within(header).getByLabelText(/gavel gate/i)).toBeInTheDocument();
    for (const label of ['Directory', 'Inbox', 'Enroll']) {
      expect(within(header).getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(await within(header).findByText(SHORT_CONNECTED)).toBeInTheDocument();
    // One navigation landmark, one wallet control — nothing duplicated into a
    // second mobile-only copy that could overflow or double-announce.
    expect(within(header).getAllByRole('navigation')).toHaveLength(1);
    expect(header.querySelectorAll('.wallet-control')).toHaveLength(1);
  });
});
