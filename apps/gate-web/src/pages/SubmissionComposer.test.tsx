import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SubmissionComposer } from './SubmissionComposer';
import { renderApp, stubApi } from '../test/harness';
import { VOTER, acceptingProfile, duplicateReceipt, quote, quotedReceipt } from '../test/fixtures';
import { MAX_DISCLOSURE_CODE_POINTS, MAX_EVIDENCE_URLS, MAX_PITCH_CODE_POINTS } from '../gate-domain';

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
    renderApp(<SubmissionComposer api={api} wallet={VOTER} />, { session });
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
    renderApp(<SubmissionComposer api={api} wallet={VOTER} />, { session });
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
    renderApp(<SubmissionComposer api={api} wallet={VOTER} />, { session });
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
    renderApp(<SubmissionComposer api={api} wallet={VOTER} />, { session });
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
    renderApp(<SubmissionComposer api={api} wallet={VOTER} onQuote={onQuote} />, { session });
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
    renderApp(<SubmissionComposer api={api} wallet={VOTER} onQuote={onQuote} />, { session });
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
    renderApp(<SubmissionComposer api={api} wallet={VOTER} />, { session });
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
