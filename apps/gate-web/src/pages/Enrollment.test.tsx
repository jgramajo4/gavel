import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Enrollment } from './Enrollment';
import { renderApp, stubApi, stubWallet } from '../test/harness';
import { createGateApi } from '../api';
import { VOTER, acceptingProfile } from '../test/fixtures';

const challenge = {
  proofType: 'GateEnrollment',
  primaryType: 'GateEnrollment',
  domain: { name: 'GavelGate', version: '1', chainId: 1, verifyingContract: VOTER },
  types: { GateEnrollment: [{ name: 'wallet', type: 'address' }] },
  message: { wallet: VOTER, availability: 'accepting_now' },
  nonceHash: `0x${'aa'.repeat(32)}`,
  payloadHash: `0x${'bb'.repeat(32)}`,
};

const walletSession = {
  token: 'c'.repeat(43),
  session: {
    wallet: VOTER,
    role: 'dao_profile' as const,
    chainId: '1',
    audience: 'gate',
    issuedAt: '1',
    expiry: '9999999999',
  },
};

describe('Enrollment', () => {
  it('states that the Gate wallet is the payout wallet', () => {
    const { api } = stubApi([]);
    renderApp(<Enrollment api={api} wallet={stubWallet()} />);
    expect(screen.getByText(/gate wallet .*payout wallet/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be redirected|no payout override/i)).toBeInTheDocument();
  });

  it('does not claim Safe or contract-wallet support', () => {
    const { api } = stubApi([]);
    const { container } = renderApp(<Enrollment api={api} wallet={stubWallet()} />);
    expect(container.textContent).not.toMatch(/safe (is )?supported|supports safe|erc-?1271 supported/i);
    expect(screen.getByText(/externally owned|EOA/i)).toBeInTheDocument();
  });

  it('runs challenge, wallet proof, then typed-data enrollment', async () => {
    const { api, calls } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: challenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: walletSession },
      { method: 'PUT', match: /\/me\/profile$/, status: 200, body: acceptingProfile },
    ]);
    const wallet = stubWallet({
      eth_requestAccounts: () => [VOTER],
      eth_chainId: () => '0x1',
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />);

    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));

    await waitFor(() => expect(calls.some((call) => call.includes('/me/profile'))).toBe(true));
    const order = calls.filter((call) => /challenge|verify|profile/.test(call));
    expect(order[0]).toContain('/auth/challenge');
    expect(order.some((call) => call.includes('/auth/verify'))).toBe(true);
    expect(order.at(-1)).toContain('/me/profile');
    expect(await screen.findByRole('status')).toHaveTextContent(/accepting_now|enrolled|updated/i);
  });

  it('surfaces a server rejection without inventing a fallback', async () => {
    const { api } = stubApi([
      {
        method: 'POST',
        match: /\/auth\/challenge$/,
        status: 400,
        body: { error: { code: 'INVALID_AUTH_CHALLENGE', message: 'authentication challenge is invalid' } },
      },
    ]);
    const wallet = stubWallet({ eth_requestAccounts: () => [VOTER], eth_chainId: () => '0x1' });
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />);
    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/authentication challenge is invalid/i);
  });

  it('presents the paid-attention opt-in, the price, and the stages in plain words', () => {
    const { api } = stubApi([]);
    renderApp(<Enrollment api={api} wallet={stubWallet()} />);
    expect(screen.getByText(/paid attention requests/i)).toBeInTheDocument();
    expect(screen.getByText(/never your vote/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/attention price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/PRE_VOTE/)).toBeInTheDocument();
    expect(screen.getByLabelText(/VOTING/)).toBeInTheDocument();
    expect(screen.getByLabelText(/availability/i)).toBeInTheDocument();
  });

  it('signs the stages the voter actually chose', async () => {
    const bodies: unknown[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      const url = String(input);
      if (url.endsWith('/auth/challenge')) {
        return { status: 200, ok: true, json: async () => challenge } as Response;
      }
      if (url.endsWith('/auth/verify')) {
        return { status: 200, ok: true, json: async () => walletSession } as Response;
      }
      return { status: 200, ok: true, json: async () => acceptingProfile } as Response;
    }) as typeof fetch;
    const api = createGateApi('', impl);
    const wallet = stubWallet({
      eth_requestAccounts: () => [VOTER],
      eth_chainId: () => '0x1',
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />);

    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    // Both stages start on; the voter turns VOTING off and keeps PRE_VOTE.
    await user.click(screen.getByLabelText(/VOTING/));
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));

    await waitFor(() => {
      const enrollment = bodies.find(
        (body) => (body as { proofType?: string })?.proofType === 'GateEnrollment',
      ) as { acceptPreVote?: boolean; acceptVoting?: boolean } | undefined;
      expect(enrollment).toMatchObject({ acceptPreVote: true, acceptVoting: false });
    });
  });

  it('refuses to enroll a Gate that accepts neither stage, before touching the wallet', async () => {
    const { api, calls } = stubApi([]);
    const wallet = stubWallet();
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />);
    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    await user.click(screen.getByLabelText(/PRE_VOTE/));
    await user.click(screen.getByLabelText(/VOTING/));
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one stage/i);
    expect(calls).toEqual([]);
    expect(wallet.calls).toEqual([]);
  });

  it('reports the resulting opt-in state the server confirmed', async () => {
    const { api } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: challenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: walletSession },
      { method: 'PUT', match: /\/me\/profile$/, status: 200, body: acceptingProfile },
    ]);
    const wallet = stubWallet({
      eth_requestAccounts: () => [VOTER],
      eth_chainId: () => '0x1',
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />);
    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/accepting paid attention requests now/i);
    expect(status).toHaveTextContent(/5\.00 USDC/);
    expect(status).toHaveTextContent(/VOTING/);
  });
});
