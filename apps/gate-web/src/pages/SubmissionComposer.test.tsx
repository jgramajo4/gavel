import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubmissionComposer } from './SubmissionComposer';
import { renderApp, stubApi, stubWallet } from '../test/harness';
import {
  PAYER,
  VOTER,
  acceptingProfile,
  duplicateReceipt,
  inboxSession,
  profileSession,
  quote,
  quotedReceipt,
  senderSession,
} from '../test/fixtures';
import { MAX_DISCLOSURE_CODE_POINTS, MAX_EVIDENCE_URLS, MAX_PITCH_CODE_POINTS } from '../gate-domain';
import type { Eip1193Provider } from '../wallet';

const session = {
  token: 'a'.repeat(43),
  session: {
    wallet: '0x3333333333333333333333333333333333333333',
    role: 'base_sender' as const,
    chainId: '84532',
    audience: 'gate',
    issuedAt: '1',
    expiry: '9999999999',
  },
};

const baseRoutes = [
  { method: 'GET', match: /\/v1\/gates\/0x/, status: 200, body: acceptingProfile },
];

async function fillValidDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/proposal id/i), '812');
  await user.type(screen.getByLabelText(/position/i), 'FOR');
  await user.type(screen.getByLabelText(/pitch/i), 'This proposal funds a year of client work.');
  await user.type(screen.getByLabelText(/disclosures/i), 'I am paid by the proposer.');
  await user.type(screen.getByLabelText(/evidence url 1/i), 'https://example.org/budget');
}

describe('SubmissionComposer', () => {
  it('enforces the frozen client-side limits before sending a request', async () => {
    const { api, calls } = stubApi(baseRoutes);
    const user = userEvent.setup();
    renderApp(<SubmissionComposer api={api} wallet={VOTER} provider={stubWallet()} />, {
      session,
      walletAddress: session.session.wallet,
    });
    await screen.findByLabelText(/pitch/i);

    const pitch = screen.getByLabelText(/pitch/i) as HTMLTextAreaElement;
    const disclosures = screen.getByLabelText(/disclosures/i) as HTMLTextAreaElement;
    expect(pitch).toHaveAttribute('maxlength', String(MAX_PITCH_CODE_POINTS));
    expect(disclosures).toHaveAttribute('maxlength', String(MAX_DISCLOSURE_CODE_POINTS));
    expect(screen.getAllByLabelText(/evidence url/i)).toHaveLength(MAX_EVIDENCE_URLS);
    expect(screen.queryByRole('button', { name: /add evidence/i })).toBeNull();

    await user.type(screen.getByLabelText(/proposal id/i), '812');
    await user.type(screen.getByLabelText(/position/i), 'FOR');
    // Over-limit content is rejected before any network call.
    pitch.setAttribute('maxlength', String(MAX_PITCH_CODE_POINTS + 10));
    await user.click(pitch);
    await user.paste('x'.repeat(MAX_PITCH_CODE_POINTS + 1));
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(String(MAX_PITCH_CODE_POINTS)));
    expect(calls.filter((call) => call.includes('/submissions'))).toHaveLength(0);
  });

  it('accepts only HTTPS evidence URLs, at most five', async () => {
    const { api, calls } = stubApi(baseRoutes);
    const user = userEvent.setup();
    renderApp(<SubmissionComposer api={api} wallet={VOTER} provider={stubWallet()} />, {
      session,
      walletAddress: session.session.wallet,
    });
    await screen.findByLabelText(/pitch/i);
    await fillValidDraft(user);

    await user.clear(screen.getByLabelText(/evidence url 1/i));
    await user.type(screen.getByLabelText(/evidence url 1/i), 'http://insecure.example.com');
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/https/i);
    expect(calls.filter((call) => call.includes('/submissions'))).toHaveLength(0);
  });

  it('never fetches, previews, or summarizes an evidence URL', async () => {
    const { api, calls } = stubApi([
      ...baseRoutes,
      { method: 'POST', match: /\/submissions$/, status: 201, body: quotedReceipt },
    ]);
    const user = userEvent.setup();
    renderApp(<SubmissionComposer api={api} wallet={VOTER} provider={stubWallet()} />, {
      session,
      walletAddress: session.session.wallet,
    });
    await screen.findByLabelText(/pitch/i);
    await fillValidDraft(user);
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    await waitFor(() => expect(calls.some((call) => call.includes('/submissions'))).toBe(true));

    // No request ever leaves for an advocate-supplied origin.
    expect(calls.some((call) => call.includes('example.org'))).toBe(false);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/preview|og:|opengraph|summary of/i)).toBeNull();
    expect(screen.getByText(/advocate-provided/i)).toBeInTheDocument();
  });

  it('lets the server override a client-side assumption', async () => {
    const { api } = stubApi([
      ...baseRoutes,
      {
        method: 'POST',
        match: /\/submissions$/,
        status: 400,
        body: { state: 'malformed', error: { code: 'INVALID_SUBMISSION', message: 'Submission content is invalid' } },
      },
    ]);
    const user = userEvent.setup();
    renderApp(<SubmissionComposer api={api} wallet={VOTER} provider={stubWallet()} />, {
      session,
      walletAddress: session.session.wallet,
    });
    await screen.findByLabelText(/pitch/i);
    await fillValidDraft(user);
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Submission content is invalid');
  });

  it('preserves the raw submitted text exactly after server validation', async () => {
    const raw = 'Line one.\n\n  indented   spaces  kept\n\n> quote';
    const { api } = stubApi([
      ...baseRoutes,
      { method: 'POST', match: /\/submissions$/, status: 201, body: quotedReceipt },
    ]);
    const onQuote = vi.fn();
    const user = userEvent.setup();
    renderApp(<SubmissionComposer api={api} wallet={VOTER} provider={stubWallet()} onQuote={onQuote} />, {
      session,
      walletAddress: session.session.wallet,
    });
    await screen.findByLabelText(/pitch/i);
    await user.type(screen.getByLabelText(/proposal id/i), '812');
    await user.type(screen.getByLabelText(/position/i), 'FOR');
    await user.click(screen.getByLabelText(/pitch/i));
    await user.paste(raw);
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    await waitFor(() => expect(onQuote).toHaveBeenCalled());
    expect((screen.getByLabelText(/pitch/i) as HTMLTextAreaElement).value).toBe(raw);
  });

  it('follows the server resume URL on a duplicate instead of requesting a new quote', async () => {
    const { api, calls } = stubApi([
      ...baseRoutes,
      { method: 'POST', match: /\/submissions$/, status: 409, body: duplicateReceipt },
      { method: 'GET', match: /\/resume$/, status: 200, body: quotedReceipt },
    ]);
    const onQuote = vi.fn();
    const user = userEvent.setup();
    renderApp(<SubmissionComposer api={api} wallet={VOTER} provider={stubWallet()} onQuote={onQuote} />, {
      session,
      walletAddress: session.session.wallet,
    });
    await screen.findByLabelText(/pitch/i);
    await fillValidDraft(user);
    await user.click(screen.getByRole('button', { name: /request quote/i }));

    await waitFor(() => expect(onQuote).toHaveBeenCalledTimes(1));
    expect(onQuote.mock.calls[0][0].quote).toEqual(quote);
    expect(calls.filter((call) => call.endsWith('/resume'))).toHaveLength(1);
    // Exactly one submission attempt: a duplicate is recovered, never retried.
    expect(calls.filter((call) => /^POST .*\/submissions$/.test(call))).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(/already|existing|recovered/i);
  });

  it('is fully operable from the keyboard with labelled fields', async () => {
    const { api } = stubApi(baseRoutes);
    renderApp(<SubmissionComposer api={api} wallet={VOTER} provider={stubWallet()} />, {
      session,
      walletAddress: session.session.wallet,
    });
    await screen.findByLabelText(/pitch/i);
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByLabelText(/proposal id/i)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/position/i)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/pitch/i)).toHaveFocus();

    for (const field of [/proposal id/i, /position/i, /pitch/i, /disclosures/i, /evidence url 1/i]) {
      expect(screen.getByLabelText(field)).toHaveAccessibleName();
    }
    expect(screen.getByRole('form', { name: /paid submission/i })).toBeInTheDocument();
  });
});

const senderChallenge = {
  proofType: 'WalletSession',
  primaryType: 'WalletSession',
  domain: { name: 'GavelGate', version: '1', chainId: 84532, verifyingContract: PAYER },
  types: { WalletSession: [{ name: 'wallet', type: 'address' }] },
  message: { wallet: PAYER, role: 'base_sender' },
  nonceHash: `0x${'aa'.repeat(32)}`,
  payloadHash: `0x${'bb'.repeat(32)}`,
};

function advocateWallet(handlers: Record<string, (params?: unknown) => unknown> = {}) {
  return stubWallet({
    eth_requestAccounts: () => [PAYER],
    eth_accounts: () => [PAYER],
    eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    ...handlers,
  });
}

function listenableWallet(handlers: Record<string, (params?: unknown) => unknown> = {}) {
  const wallet = advocateWallet(handlers);
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider = {
    ...wallet,
    on(event: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return provider as typeof wallet & Eip1193Provider & { emit(event: string, ...args: unknown[]): void };
}

function renderComposer(
  api: ReturnType<typeof stubApi>['api'],
  options: {
    session?: typeof senderSession | typeof profileSession | typeof inboxSession | null;
    walletAddress?: string | null;
    provider?: Eip1193Provider;
    onQuote?: (receipt: unknown) => void;
  } = {},
) {
  const provider = options.provider ?? stubWallet();
  return renderApp(
    <SubmissionComposer api={api} wallet={VOTER} provider={provider} onQuote={options.onQuote} />,
    { session: options.session ?? null, walletAddress: options.walletAddress ?? null, provider },
  );
}

describe('SubmissionComposer advocate session', () => {
  it('asks to connect a wallet when none is connected', async () => {
    const { api } = stubApi(baseRoutes);
    renderComposer(api);
    expect(await screen.findByRole('heading', { name: /paid submission/i })).toBeInTheDocument();
    expect(screen.getByText(/voter\.eth|0x4444/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /sign in with wallet/i })).toBeNull();
  });

  it('asks a connected advocate to sign in for base_sender and does not treat header identity as a session', async () => {
    const { api, calls } = stubApi(baseRoutes);
    renderComposer(api, { walletAddress: PAYER, provider: advocateWallet() });
    expect(await screen.findByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
    expect(calls.some((call) => call.includes('/submissions'))).toBe(false);
  });

  it('connects, signs a base_sender challenge, then allows a quote without changing the target voter', async () => {
    const { api, calls } = stubApi([
      ...baseRoutes,
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: senderChallenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: senderSession },
      { method: 'POST', match: /\/submissions$/, status: 201, body: quotedReceipt },
    ]);
    const provider = advocateWallet();
    const user = userEvent.setup();
    renderComposer(api, { provider });

    await user.click(screen.getByRole('button', { name: /connect wallet/i }));
    await user.click(await screen.findByRole('button', { name: /sign in with wallet/i }));
    expect(await screen.findByRole('button', { name: /request quote/i })).toBeInTheDocument();
    expect(JSON.stringify(provider.calls.find((call) => call.method === 'eth_signTypedData_v4')?.params)).toContain(
      'base_sender',
    );
    expect(screen.getByText(/voter\.eth/i)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(PAYER, 'i'))).toBeNull();

    await fillValidDraft(user);
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    await waitFor(() => expect(calls.some((call) => call.includes('/submissions'))).toBe(true));
    const submitted = calls.find((call) => call.includes('/submissions'));
    expect(submitted).toContain(VOTER);
  });

  it('allows a quote when a live base_sender session is already present', async () => {
    const { api, calls } = stubApi([
      ...baseRoutes,
      { method: 'POST', match: /\/submissions$/, status: 201, body: quotedReceipt },
    ]);
    const user = userEvent.setup();
    renderComposer(api, { session: senderSession, walletAddress: PAYER, provider: advocateWallet() });
    expect(await screen.findByRole('button', { name: /request quote/i })).toBeInTheDocument();
    await fillValidDraft(user);
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    await waitFor(() => expect(calls.filter((call) => call.includes('/submissions'))).toHaveLength(1));
  });

  it('does not treat a dao_profile session as an advocate session', async () => {
    const { api } = stubApi(baseRoutes);
    renderComposer(api, { session: profileSession, walletAddress: VOTER });
    expect(await screen.findByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
  });

  it('does not treat a dao_inbox session as an advocate session', async () => {
    const { api } = stubApi(baseRoutes);
    renderComposer(api, { session: inboxSession, walletAddress: VOTER });
    expect(await screen.findByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
  });

  it('clears an expired base_sender session and returns to sign-in', async () => {
    const { api } = stubApi(baseRoutes);
    const expired = {
      ...senderSession,
      session: { ...senderSession.session, expiry: '1' },
    };
    renderComposer(api, { session: expired, walletAddress: PAYER, provider: advocateWallet() });
    expect(await screen.findByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
  });

  it('clears a stale session on 401 and offers sign-in again', async () => {
    const { api } = stubApi([
      ...baseRoutes,
      {
        method: 'POST',
        match: /\/submissions$/,
        status: 401,
        body: { error: { code: 'UNAUTHORIZED', message: 'authentication required' } },
      },
    ]);
    const user = userEvent.setup();
    renderComposer(api, { session: senderSession, walletAddress: PAYER, provider: advocateWallet() });
    await fillValidDraft(user);
    await user.click(screen.getByRole('button', { name: /request quote/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired|sign in/i);
    expect(screen.getByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
  });

  it('returns to connect after the wallet disconnects', async () => {
    const { api } = stubApi(baseRoutes);
    const provider = listenableWallet();
    renderComposer(api, { session: senderSession, walletAddress: PAYER, provider });
    expect(await screen.findByRole('button', { name: /request quote/i })).toBeInTheDocument();
    act(() => {
      provider.emit('accountsChanged', []);
    });
    expect(await screen.findByRole('button', { name: /connect wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
  });

  it('refuses to keep a base_sender session after the wallet switches accounts', async () => {
    const { api } = stubApi(baseRoutes);
    const provider = listenableWallet();
    renderComposer(api, { session: senderSession, walletAddress: PAYER, provider });
    expect(await screen.findByRole('button', { name: /request quote/i })).toBeInTheDocument();
    act(() => {
      provider.emit('accountsChanged', [VOTER]);
    });
    expect(await screen.findByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
    expect(screen.getByText(/voter\.eth/i)).toBeInTheDocument();
  });

  it('reports a rejected signature and stays connected-but-unauthenticated', async () => {
    const { api } = stubApi([
      ...baseRoutes,
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: senderChallenge },
    ]);
    const provider = advocateWallet({
      eth_signTypedData_v4: () => {
        throw new Error('User rejected the request');
      },
    });
    const user = userEvent.setup();
    renderComposer(api, { walletAddress: PAYER, provider });
    await user.click(screen.getByRole('button', { name: /sign in with wallet/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/rejected/i);
    expect(screen.getByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
  });

  it('refuses to sign as a different account than the header connection', async () => {
    const { api, calls } = stubApi(baseRoutes);
    const provider = advocateWallet({
      eth_accounts: () => [VOTER],
      eth_requestAccounts: () => [VOTER],
    });
    const user = userEvent.setup();
    renderComposer(api, { walletAddress: PAYER, provider });
    await user.click(screen.getByRole('button', { name: /sign in with wallet/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer on the account/i);
    expect(calls.some((call) => /auth\/(challenge|verify)/.test(call))).toBe(false);
  });

  it('reports a malformed signature without leaving a stale session', async () => {
    const { api } = stubApi([
      ...baseRoutes,
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: senderChallenge },
      {
        method: 'POST',
        match: /\/auth\/verify$/,
        status: 401,
        body: { error: { code: 'INVALID_AUTH_PROOF', message: 'authentication proof is invalid' } },
      },
    ]);
    const provider = advocateWallet({
      eth_signTypedData_v4: () => 'not-a-signature',
    });
    const user = userEvent.setup();
    renderComposer(api, { walletAddress: PAYER, provider });
    await user.click(screen.getByRole('button', { name: /sign in with wallet/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with wallet/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request quote/i })).toBeNull();
  });
});
