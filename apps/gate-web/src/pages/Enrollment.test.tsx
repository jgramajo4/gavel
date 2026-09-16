import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Enrollment } from './Enrollment';
import { renderApp, stubApi, stubWallet } from '../test/harness';
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
});
