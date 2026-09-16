import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './session';
import { stubApi, stubWallet } from './test/harness';
import { acceptingProfile, VOTER } from './test/fixtures';

const routes = [
  { method: 'GET', match: /\/v1\/gates\?/, status: 200, body: { items: [acceptingProfile] } },
  { method: 'GET', match: /\/v1\/gates\/0x/, status: 200, body: acceptingProfile },
  { method: 'GET', match: /\/v1\/gate\/me\/inbox$/, status: 404, body: null },
];

function renderRoute(route: string) {
  const { api } = stubApi(routes);
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SessionProvider initialSession={null}>
        <App api={api} wallet={stubWallet()} />
      </SessionProvider>
    </MemoryRouter>,
  );
}

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  window.dispatchEvent(new Event('resize'));
}

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
