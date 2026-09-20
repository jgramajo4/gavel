import { describe, expect, it } from 'vitest';
import { isSessionForRole, openWalletSession, WalletSessionRoleError } from './wallet-session';
import { stubApi, stubWallet } from './test/harness';
import { PAYER, VOTER, inboxSession, profileSession, senderSession } from './test/fixtures';

const challenge = {
  proofType: 'WalletSession',
  primaryType: 'WalletSession',
  domain: { name: 'GavelGate', version: '1', chainId: 84532, verifyingContract: PAYER },
  types: { WalletSession: [{ name: 'wallet', type: 'address' }] },
  message: { wallet: PAYER, role: 'base_sender' },
  nonceHash: `0x${'aa'.repeat(32)}`,
  payloadHash: `0x${'bb'.repeat(32)}`,
};

describe('isSessionForRole', () => {
  it('accepts only the exact role the server issued', () => {
    expect(isSessionForRole(senderSession, 'base_sender')).toBe(true);
    expect(isSessionForRole(profileSession, 'base_sender')).toBe(false);
    expect(isSessionForRole(inboxSession, 'base_sender')).toBe(false);
    expect(isSessionForRole(null, 'base_sender')).toBe(false);
  });
});

describe('openWalletSession', () => {
  it('requests a base_sender challenge for the connected advocate, not the target voter', async () => {
    const { api, calls } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: challenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: senderSession },
    ]);
    const provider = stubWallet({
      eth_accounts: () => [PAYER],
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });

    const result = await openWalletSession({
      api,
      provider,
      role: 'base_sender',
      account: PAYER,
    });

    expect(result.account).toBe(PAYER);
    expect(result.verified.session.role).toBe('base_sender');
    expect(result.verified.session.wallet.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(calls.filter((call) => call.includes('/auth/challenge'))).toHaveLength(1);
    const signed = provider.calls.find((call) => call.method === 'eth_signTypedData_v4');
    expect(JSON.stringify(signed?.params)).toContain('base_sender');
    expect(JSON.stringify(signed?.params)).toContain(PAYER);
    expect(JSON.stringify(signed?.params)).not.toContain(VOTER);
  });

  it('fails closed when the wallet is no longer on the connected account', async () => {
    const { api, calls } = stubApi([]);
    const provider = stubWallet({
      eth_accounts: () => [VOTER],
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });

    await expect(
      openWalletSession({ api, provider, role: 'base_sender', account: PAYER }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(calls).toEqual([]);
    expect(provider.calls.map((call) => call.method)).toEqual(['eth_accounts']);
  });

  it('refuses a session the server issued for another role', async () => {
    const { api } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: challenge },
      { method: 'POST', match: /\/auth\/verify$/, status: 200, body: profileSession },
    ]);
    const provider = stubWallet({
      eth_accounts: () => [PAYER],
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });

    await expect(
      openWalletSession({ api, provider, role: 'base_sender', account: PAYER }),
    ).rejects.toBeInstanceOf(WalletSessionRoleError);
  });

  it('surfaces a rejected signature without claiming a session', async () => {
    const { api, calls } = stubApi([
      { method: 'POST', match: /\/auth\/challenge$/, status: 200, body: challenge },
    ]);
    const provider = stubWallet({
      eth_accounts: () => [PAYER],
      eth_signTypedData_v4: () => {
        throw new Error('User rejected the request');
      },
    });

    await expect(
      openWalletSession({ api, provider, role: 'base_sender', account: PAYER }),
    ).rejects.toThrow(/rejected/i);
    expect(calls.some((call) => /\/auth\/verify$/.test(call))).toBe(false);
  });
});
