import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkout } from './Checkout';
import { renderApp, stubApi, stubWallet } from '../test/harness';
import { PAYER, SPLITTER, TEST_CHAIN_ID, USDC, VOTER, quote, quotedReceipt } from '../test/fixtures';
import { encodeSettleCall } from '../wallet';

const session = {
  token: 'a'.repeat(43),
  session: {
    wallet: PAYER,
    role: 'base_sender' as const,
    chainId: String(TEST_CHAIN_ID),
    audience: 'gate',
    issuedAt: '1',
    expiry: '9999999999',
  },
};

const TX_HASH = `0x${'fe'.repeat(32)}`;
/** Quote issuance only — deliberately not the settlement route under it. */
const CREATE_SUBMISSION = /^POST .*\/v1\/gates\/0x[0-9a-fA-F]{40}\/submissions$/;
const AUTH_SIGNATURE = `0x${'22'.repeat(32)}${'33'.repeat(32)}1c`;

// A USDC-shaped token whose reported domain reproduces its own separator.
function tokenWallet(overrides: Record<string, (params?: unknown) => unknown> = {}) {
  const { AbiCoder, keccak256, toUtf8Bytes, Interface } = require('ethers');
  const iface = new Interface([
    'function name() view returns (string)',
    'function version() view returns (string)',
    'function DOMAIN_SEPARATOR() view returns (bytes32)',
  ]);
  const name = 'USD Coin';
  const version = '2';
  const separator = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        keccak256(toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(toUtf8Bytes(name)),
        keccak256(toUtf8Bytes(version)),
        TEST_CHAIN_ID,
        USDC,
      ],
    ),
  );
  return stubWallet({
    eth_chainId: () => `0x${TEST_CHAIN_ID.toString(16)}`,
    eth_call: (params) => {
      const [call] = params as [{ data: string }];
      if (call.data === iface.encodeFunctionData('name')) return iface.encodeFunctionResult('name', [name]);
      if (call.data === iface.encodeFunctionData('version')) return iface.encodeFunctionResult('version', [version]);
      return iface.encodeFunctionResult('DOMAIN_SEPARATOR', [separator]);
    },
    eth_signTypedData_v4: () => AUTH_SIGNATURE,
    eth_sendTransaction: () => TX_HASH,
    ...overrides,
  });
}

const statusRoute = (body: unknown) => ({ method: 'GET', match: /\/status$/, status: 200, body });
const settlementRoute = {
  method: 'POST',
  match: /\/settlement$/,
  status: 202,
  body: { publicId: quotedReceipt.publicId, state: 'pending_settlement', updatedAt: '2026-09-16T10:02:00.000Z' },
};

describe('Checkout', () => {
  it('shows the immutable quote summary with a separate $0.25 Gavel fee', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt)]);
    renderApp(<Checkout api={api} wallet={tokenWallet()} receipt={quotedReceipt} />, { session });

    expect(await screen.findByTestId('total-amount')).toHaveTextContent('5.25 USDC');
    expect(screen.getByTestId('attention-amount')).toHaveTextContent('5.00 USDC');
    expect(screen.getByTestId('gavel-fee')).toHaveTextContent('0.25 USDC');
    const fee = screen.getByTestId('gavel-fee');
    expect(fee).toHaveTextContent(/gavel (service )?fee/i);
    expect(fee).toHaveTextContent('0.25 USDC');
    expect(screen.getByTestId('attention-amount')).toHaveTextContent('5.00 USDC');
  });

  it('shows the full settlement context the server bound this quote to', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt)]);
    renderApp(<Checkout api={api} wallet={tokenWallet()} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');

    expect(screen.getByTestId('chain-id')).toHaveTextContent(String(TEST_CHAIN_ID));
    expect(screen.getByTestId('token')).toHaveTextContent(USDC);
    expect(screen.getByTestId('splitter')).toHaveTextContent(SPLITTER);
    expect(screen.getByTestId('payer')).toHaveTextContent(PAYER);
    expect(screen.getByTestId('voter-payout')).toHaveTextContent(VOTER);
    expect(screen.getByTestId('quote-expiry')).toHaveTextContent(/expires/i);
    expect(screen.getByTestId('submission-context')).toHaveTextContent(quotedReceipt.publicId);
    // Chain is read from the quote, never assumed; the next test proves it
    // follows a different quote rather than a compiled-in default.
    expect(screen.getByTestId('chain-id')).toHaveTextContent(String(TEST_CHAIN_ID));
  });

  it('reads the chain from the quote rather than assuming Base mainnet', async () => {
    const otherChain = { ...quote, domain: { ...quote.domain, chainId: 11155111 } };
    const { api } = stubApi([statusRoute(quotedReceipt)]);
    renderApp(
      <Checkout api={api} wallet={tokenWallet()} receipt={{ ...quotedReceipt, quote: otherChain }} />,
      { session },
    );
    expect(await screen.findByTestId('chain-id')).toHaveTextContent('11155111');
  });

  it('contains no ERC-20 approve path anywhere in the flow', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt), settlementRoute]);
    const wallet = tokenWallet();
    const user = userEvent.setup();
    const { container } = renderApp(<Checkout api={api} wallet={wallet} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');
    expect(container.textContent).not.toMatch(/approve|allowance|spending cap|unlock token/i);

    await user.click(screen.getByRole('button', { name: /authorize and pay/i }));
    await waitFor(() => expect(wallet.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(true));

    const methods = wallet.calls.map((call) => call.method);
    expect(methods.filter((method) => method === 'eth_signTypedData_v4')).toHaveLength(1);
    expect(methods.filter((method) => method === 'eth_sendTransaction')).toHaveLength(1);
    const [[tx]] = wallet.calls
      .filter((call) => call.method === 'eth_sendTransaction')
      .map((call) => call.params as [{ to: string; data: string }]);
    // One settle() call to the splitter — no approve, and no transfer to Gavel.
    expect(tx.to).toBe(SPLITTER);
    expect(tx.data.slice(0, 10)).toBe(encodeSettleCall(quote, AUTH_SIGNATURE).slice(0, 10));
    expect(tx.data).toBe(encodeSettleCall(quote, AUTH_SIGNATURE));
  });

  it('signs an EIP-3009 authorization built only from the persisted quote', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt), settlementRoute]);
    const wallet = tokenWallet();
    const user = userEvent.setup();
    renderApp(<Checkout api={api} wallet={wallet} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');
    await user.click(screen.getByRole('button', { name: /authorize and pay/i }));
    await waitFor(() => expect(wallet.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(true));

    const [signCall] = wallet.calls.filter((call) => call.method === 'eth_signTypedData_v4');
    const [account, payload] = signCall.params as [string, string];
    const typed = JSON.parse(payload);
    expect(account).toBe(PAYER);
    expect(typed.primaryType).toBe('ReceiveWithAuthorization');
    expect(typed.domain.verifyingContract).toBe(USDC);
    expect(typed.domain.chainId).toBe(TEST_CHAIN_ID);
    expect(typed.message).toEqual({
      from: PAYER,
      to: SPLITTER,
      value: '5250000',
      validAfter: '0',
      validBefore: quote.message.expiry,
      nonce: quote.message.quoteId,
    });
  });

  it('treats every quote field as immutable server state', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt), settlementRoute]);
    const wallet = tokenWallet();
    const user = userEvent.setup();
    const { container } = renderApp(<Checkout api={api} wallet={wallet} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');

    // Nothing in checkout may edit a quote field.
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /edit|change|refresh|extend|new quote/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /authorize and pay/i }));
    await waitFor(() => expect(wallet.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(true));
    const [[tx]] = wallet.calls
      .filter((call) => call.method === 'eth_sendTransaction')
      .map((call) => call.params as [{ data: string }]);
    expect(tx.data).toContain(quote.message.quoteId.slice(2));
    expect(tx.data).toContain(quote.message.submissionHash.slice(2));
    expect(tx.data).toContain(quote.signature.slice(2, 10));
  });

  it('recovers a resumed quote without mutating or refreshing it', async () => {
    const { api, calls } = stubApi([
      { method: 'GET', match: /\/resume$/, status: 200, body: quotedReceipt },
      statusRoute(quotedReceipt),
    ]);
    const onResume = vi.fn();
    renderApp(
      <Checkout api={api} wallet={tokenWallet()} publicId={quotedReceipt.publicId} onResume={onResume} />,
      { session },
    );
    await screen.findByTestId('total-amount');

    expect(calls.some((call) => call.endsWith('/resume'))).toBe(true);
    // No new submission, and no second quote request.
    expect(calls.some((call) => CREATE_SUBMISSION.test(call))).toBe(false);
    expect(onResume).toHaveBeenCalledWith(expect.objectContaining({ quote }));
    expect(screen.getByTestId('quote-expiry')).toHaveTextContent(
      new Date(Number(quote.message.expiry) * 1000).toISOString(),
    );
  });

  it('does not show accepted after a 202 settlement receipt', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt), settlementRoute]);
    const user = userEvent.setup();
    renderApp(<Checkout api={api} wallet={tokenWallet()} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');
    await user.click(screen.getByRole('button', { name: /authorize and pay/i }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/pending/i));
    expect(status.textContent).not.toMatch(/\b(accepted|paid|delivered)\b/i);
  });

  it('shows accepted only once the public status endpoint reports it', async () => {
    const { api } = stubApi([
      settlementRoute,
      statusRoute({ publicId: quotedReceipt.publicId, state: 'accepted', acceptedAt: '2026-09-16T10:06:00.000Z' }),
    ]);
    const user = userEvent.setup();
    renderApp(<Checkout api={api} wallet={tokenWallet()} receipt={quotedReceipt} pollIntervalMs={5} />, { session });
    await screen.findByTestId('total-amount');
    await user.click(screen.getByRole('button', { name: /authorize and pay/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/accepted/i), { timeout: 3000 });
  });

  it('does not show accepted when the wallet rejects the transaction', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt)]);
    const wallet = tokenWallet({
      eth_sendTransaction: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      },
    });
    const user = userEvent.setup();
    renderApp(<Checkout api={api} wallet={wallet} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');
    await user.click(screen.getByRole('button', { name: /authorize and pay/i }));

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent(/cancell?ed|rejected|not sent/i));
    expect(status.textContent).not.toMatch(/\b(accepted|paid|delivered)\b/i);
    expect(screen.queryByText(/pending_settlement/)).toBeNull();
  });

  it('reports an expired quote without silently reissuing one', async () => {
    const { api, calls } = stubApi([
      statusRoute(quotedReceipt),
      {
        method: 'POST',
        match: /\/settlement$/,
        status: 410,
        body: { state: 'expired', error: { code: 'EXPIRED', message: 'Quote expired' } },
      },
    ]);
    const user = userEvent.setup();
    renderApp(<Checkout api={api} wallet={tokenWallet()} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');
    await user.click(screen.getByRole('button', { name: /authorize and pay/i }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/expired/i));
    expect(calls.some((call) => CREATE_SUBMISSION.test(call))).toBe(false);
  });

  it('keeps the pay control reachable and labelled for keyboard users', async () => {
    const { api } = stubApi([statusRoute(quotedReceipt), settlementRoute]);
    const wallet = tokenWallet();
    const user = userEvent.setup();
    renderApp(<Checkout api={api} wallet={wallet} receipt={quotedReceipt} />, { session });
    await screen.findByTestId('total-amount');

    expect(screen.getByRole('region', { name: /quote summary/i })).toBeInTheDocument();
    await user.tab();
    const pay = screen.getByRole('button', { name: /authorize and pay/i });
    expect(pay).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(wallet.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(true));
  });
});
