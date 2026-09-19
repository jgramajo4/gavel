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

/** The Base domain the SERVER binds a payout-control proof to. */
const payoutChallenge = {
  proofType: 'BasePayoutControl',
  primaryType: 'BasePayoutControl',
  domain: { name: 'GavelGate', version: '1', chainId: 8453, verifyingContract: VOTER },
  types: { BasePayoutControl: [{ name: 'wallet', type: 'address' }] },
  message: { wallet: VOTER, dao: 'nouns', purpose: 'base_payout_control' },
  nonceHash: `0x${'cc'.repeat(32)}`,
  payloadHash: `0x${'dd'.repeat(32)}`,
};

/** A Safe's answer is its own ERC-1271 material, not a 65-byte ECDSA pair. */
const CONTRACT_SIGNATURE = `0x${'ab'.repeat(130)}`;

interface Recorded {
  calls: string[];
  bodies: Record<string, unknown>[];
}

/** A server that answers each challenge for the proof type actually asked. */
function recordingApi(existingProfile: unknown, record: Recorded) {
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    record.calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) record.bodies.push(body);
    const reply = (status: number, value: unknown) =>
      ({ status, ok: status >= 200 && status < 300, json: async () => value }) as Response;
    if (url.endsWith('/auth/challenge')) {
      return reply(200, body?.proofType === 'BasePayoutControl' ? payoutChallenge : challenge);
    }
    if (url.endsWith('/auth/verify')) return reply(200, walletSession);
    if (/\/v1\/gates\/0x/.test(url)) {
      return existingProfile ? reply(200, existingProfile) : reply(404, null);
    }
    return reply(200, acceptingProfile);
  }) as typeof fetch;
  return createGateApi('', impl);
}

/** A contract wallet: code at the account, and a chain it can be moved across. */
function safeWallet(signature = CONTRACT_SIGNATURE) {
  let chainId = '0x1';
  return stubWallet({
    eth_accounts: () => [VOTER],
    eth_requestAccounts: () => [VOTER],
    eth_chainId: () => chainId,
    eth_getCode: () => '0x6080604052',
    wallet_switchEthereumChain: (params) => {
      const [target] = params as [{ chainId: string }];
      chainId = target.chainId;
      return null;
    },
    eth_signTypedData_v4: () => signature,
  });
}

describe('Enrollment', () => {
  it('puts the payout fact next to the price it governs, not above the form', () => {
    const { api } = stubApi([]);
    renderApp(<Enrollment api={api} wallet={stubWallet()} />);
    const price = screen.getByLabelText(/attention price/i);
    const helper = screen.getByText(/payout wallet and cannot be redirected/i);
    // Helper text belongs to the field: it sits inside the same `.field`.
    expect(price.closest('.field')).toContainElement(helper);
  });

  it('states the contract-wallet terms without promising more than the chain decides', () => {
    const { api } = stubApi([]);
    renderApp(<Enrollment api={api} wallet={stubWallet()} />);
    // Small print at the control it governs: the account itself is the Gate
    // identity, its own ERC-1271 authority answers, and Base deployment is a
    // precondition — no claim that an owner may act for it.
    const limit = screen.getByText(/ERC-1271/i);
    expect(limit).toHaveClass('enrollment-limits');
    expect(limit).toHaveTextContent(/the account you connect/i);
    expect(limit).toHaveTextContent(/never stands in for it/i);
    expect(limit).toHaveTextContent(/on Base/i);
  });

  it('reaches the controls almost immediately, with no wall of prose above them', () => {
    const { api } = stubApi([]);
    const { container } = renderApp(<Enrollment api={api} wallet={stubWallet()} />);
    expect(screen.getByRole('heading', { name: /enroll your gate/i, level: 1 })).toBeInTheDocument();
    const intros = container.querySelectorAll('.page, .page > .page-intro');
    // Exactly one line of supporting copy sits between the heading and the form.
    expect(container.querySelectorAll('.page > .page-intro')).toHaveLength(1);
    expect(intros.length).toBeGreaterThan(0);
    expect(screen.getByText(/set your attention price and choose when advocates can reach you/i))
      .toBeInTheDocument();
    // …and the economics stay in it.
    expect(screen.getByText(/payment buys your attention, never your vote/i)).toBeInTheDocument();
    // The implementation detail paragraphs are gone from the top of the page.
    const form = screen.getByRole('form', { name: /gate enrollment/i });
    const beforeForm = (container.textContent ?? '').split(form.textContent ?? '')[0];
    expect(beforeForm).not.toMatch(/externally owned|contract wallets|payout wallet/i);
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
      eth_getCode: () => '0x',
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

  it('presents the economics, the price, and the stages in plain words', () => {
    const { api } = stubApi([]);
    renderApp(<Enrollment api={api} wallet={stubWallet()} />);
    expect(screen.getByText(/never your vote/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/attention price/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/PRE_VOTE/)).toBeInTheDocument();
    expect(screen.getByLabelText(/VOTING/)).toBeInTheDocument();
    expect(screen.getByLabelText(/availability/i)).toBeInTheDocument();
  });

  it('enrolls the wallet already connected in the header, and still signs for dao_profile', async () => {
    const bodies: unknown[] = [];
    const calls: string[] = [];
    const impl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
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
      eth_getCode: () => '0x',
      eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
    });
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />, { walletAddress: VOTER });

    // The form shows who it is about to enroll without a second connect step.
    expect(screen.getByText(/enrolling/i)).toBeInTheDocument();
    expect(screen.getByText('0x4444…4444')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));

    await waitFor(() => expect(calls.some((call) => call.includes('/me/profile'))).toBe(true));
    // A globally connected wallet grants nothing. Both signatures still
    // happen: the dao_profile WalletSession, then the GateEnrollment proof.
    const requested = calls
      .filter((call) => call.includes('/auth/challenge'))
      .length;
    expect(requested).toBe(2);
    expect(calls.filter((call) => call.includes('/auth/verify'))).toHaveLength(1);
    expect(
      wallet.calls.filter((call) => call.method === 'eth_signTypedData_v4'),
    ).toHaveLength(2);
    // Exactly one WalletSession challenge, for exactly one role.
    const roles = bodies
      .map((body) => (body as { proofType?: string; role?: string }))
      .filter((body) => body?.proofType === 'WalletSession' && body.role !== undefined)
      .map((body) => body.role);
    expect(roles).toEqual(['dao_profile']);
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
      eth_getCode: () => '0x',
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

  it('sends the enrollment proof in the exact shape the server accepts', async () => {
    const record: Recorded = { calls: [], bodies: [] };
    const api = recordingApi(null, record);
    const user = userEvent.setup();
    renderApp(
      <Enrollment
        api={api}
        wallet={stubWallet({
          eth_requestAccounts: () => [VOTER],
          eth_chainId: () => '0x1',
          eth_getCode: () => '0x',
          eth_signTypedData_v4: () => `0x${'44'.repeat(65)}`,
        })}
      />,
    );
    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));

    await waitFor(() => expect(record.calls.some((call) => call.includes('/me/profile'))).toBe(true));
    const update = record.bodies.find((body) => 'gateEnrollmentProof' in body) as {
      gateEnrollmentProof: Record<string, unknown>;
    };
    // The server allows exactly these keys and rejects the update outright for
    // any other, `proofType` included.
    expect(Object.keys(update.gateEnrollmentProof).sort()).toEqual([
      'publicTags',
      'signature',
      'typedData',
    ]);
    // An EOA owes no payout proof, and one it does not owe is itself refused.
    expect('basePayoutControlProof' in update).toBe(false);
  });

  it('enrolls a Safe as itself and proves Base payout control for it', async () => {
    const record: Recorded = { calls: [], bodies: [] };
    const api = recordingApi(null, record);
    const wallet = safeWallet();
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />, { walletAddress: VOTER });

    await user.type(screen.getByLabelText(/attention price/i), '5.00');
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));
    await waitFor(() => expect(record.calls.some((call) => call.includes('/me/profile'))).toBe(true));

    // Three signatures: dao_profile session, GateEnrollment, BasePayoutControl.
    const signatures = wallet.calls.filter((call) => call.method === 'eth_signTypedData_v4');
    expect(signatures).toHaveLength(3);
    // The account's own code decides it is a contract wallet.
    expect(wallet.calls.some((call) => call.method === 'eth_getCode')).toBe(true);
    // Payout control is signed on the Base chain the SERVER named, not chain 1.
    expect(
      wallet.calls.filter((call) => call.method === 'wallet_switchEthereumChain').at(-1)?.params,
    ).toEqual([{ chainId: '0x2105' }]);

    const update = record.bodies.find((body) => 'gateEnrollmentProof' in body) as {
      gateEnrollmentProof: { typedData: { message: { wallet: string } }; signature: string };
      basePayoutControlProof: Record<string, unknown>;
    };
    // The enrolled identity is the connected account itself — the Safe — and
    // the signature travels exactly as the wallet returned it, contract shape
    // and all, for the server to put to the account's own ERC-1271.
    expect(update.gateEnrollmentProof.typedData.message.wallet).toBe(VOTER);
    expect(update.gateEnrollmentProof.signature).toBe(CONTRACT_SIGNATURE);
    expect(Object.keys(update.basePayoutControlProof).sort()).toEqual(['signature', 'typedData']);
    const payoutBody = record.bodies.find((body) => body.proofType === 'BasePayoutControl');
    expect(payoutBody).toMatchObject({ wallet: VOTER, dao: 'nouns' });
  });

  it('asks for no payout proof on an update the server would refuse one for', async () => {
    // Already `accepting_now`: the server requires the Base proof on a first
    // enrollment and on transitions back into accepting, and refuses it here.
    const record: Recorded = { calls: [], bodies: [] };
    const api = recordingApi(acceptingProfile, record);
    const wallet = safeWallet();
    const user = userEvent.setup();
    renderApp(<Enrollment api={api} wallet={wallet} />, { walletAddress: VOTER });

    await user.type(screen.getByLabelText(/attention price/i), '7.50');
    await user.click(screen.getByRole('button', { name: /enroll|update gate/i }));
    await waitFor(() => expect(record.calls.some((call) => call.includes('/me/profile'))).toBe(true));

    expect(record.bodies.some((body) => body.proofType === 'BasePayoutControl')).toBe(false);
    const update = record.bodies.find((body) => 'gateEnrollmentProof' in body) as Record<string, unknown>;
    expect('basePayoutControlProof' in update).toBe(false);
    expect(wallet.calls.filter((call) => call.method === 'eth_signTypedData_v4')).toHaveLength(2);
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
      eth_getCode: () => '0x',
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
