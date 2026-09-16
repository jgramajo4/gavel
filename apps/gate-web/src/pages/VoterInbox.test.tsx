import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { VoterInbox } from './VoterInbox';
import { renderApp } from '../test/harness';
import { createGateApi } from '../api';

/**
 * The merged backend (PR4–PR6) serves no private inbox route. Rather than ship
 * a speculative client for routes that do not exist — which a later accidental
 * 200 would turn into an undeclared contract — `/inbox` is a static product-gap
 * page that issues no requests at all.
 */
describe('VoterInbox', () => {
  it('makes zero HTTP requests', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('VoterInbox must not make any request');
    });
    Object.defineProperty(globalThis, 'fetch', { value: fetchSpy, writable: true, configurable: true });

    renderApp(<VoterInbox />);
    await screen.findByRole('heading', { name: /voter inbox/i, level: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('states plainly that the private inbox backend is not available yet', async () => {
    renderApp(<VoterInbox />);
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/not available/i);
    expect(notice).toHaveTextContent(/deployment/i);
  });

  it('offers no archive, reply, or follow-up control', () => {
    renderApp(<VoterInbox />);
    expect(screen.queryByRole('button', { name: /archive/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /repl(y|ies)|follow.?up/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('exposes no speculative inbox methods on the production API client', () => {
    const api = createGateApi('', (() => {
      throw new Error('no request expected');
    }) as unknown as typeof fetch);
    expect('listInbox' in api).toBe(false);
    expect('archiveInboxItem' in api).toBe(false);
  });
});
