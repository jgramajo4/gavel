import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, Signature, keccak256, toUtf8Bytes } from 'ethers';
import { encodeSettleCall, planPayment, payQuote, readTokenDomain, WalletError } from './wallet';
import { stubWallet } from './test/harness';
import { PAYER, SPLITTER, TEST_CHAIN_ID, USDC, VOTER, quote } from './test/fixtures';

const AUTH_SIGNATURE = `0x${'22'.repeat(32)}${'33'.repeat(32)}1c`;
const TX_HASH = `0x${'fe'.repeat(32)}`;
const iface = new Interface([
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
]);

function separatorFor(name: string, version: string) {
  return keccak256(
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
}

function token(separator = separatorFor('USD Coin', '2'), overrides = {}) {
  return stubWallet({
    eth_chainId: () => `0x${TEST_CHAIN_ID.toString(16)}`,
    eth_call: (params) => {
      const [call] = params as [{ data: string }];
      if (call.data === iface.encodeFunctionData('name')) return iface.encodeFunctionResult('name', ['USD Coin']);
      if (call.data === iface.encodeFunctionData('version')) return iface.encodeFunctionResult('version', ['2']);
      return iface.encodeFunctionResult('DOMAIN_SEPARATOR', [separator]);
    },
    eth_signTypedData_v4: () => AUTH_SIGNATURE,
    eth_sendTransaction: () => TX_HASH,
    ...overrides,
  });
}

describe('payment boundary', () => {
  it('derives the authorization from the quote alone', () => {
    const plan = planPayment(quote);
    expect(plan).toEqual({
      chainId: TEST_CHAIN_ID,
      splitter: SPLITTER,
      token: USDC,
      authorization: {
        from: PAYER,
        to: SPLITTER,
        value: '5250000',
        validAfter: '0',
        validBefore: quote.message.expiry,
        nonce: quote.message.quoteId,
      },
    });
  });

  it('encodes exactly one settle call with the persisted quote and signature', () => {
    const data = encodeSettleCall(quote, AUTH_SIGNATURE);
    const splitter = new Interface([
      'function settle((bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion) quote, bytes quoteSignature, (address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) authorization)',
    ]);
    const decoded = splitter.decodeFunctionData('settle', data);
    expect(decoded[0].quoteId).toBe(quote.message.quoteId);
    expect(decoded[0].payer).toBe(PAYER);
    expect(decoded[0].voter).toBe(VOTER);
    expect(decoded[0].attentionAmount).toBe(5_000_000n);
    expect(decoded[0].gavelFeeAmount).toBe(250_000n);
    expect(decoded[0].token).toBe(USDC);
    expect(decoded[1]).toBe(quote.signature);
    expect(decoded[2].to).toBe(SPLITTER);
    expect(decoded[2].value).toBe(5_250_000n);
    expect(decoded[2].nonce).toBe(quote.message.quoteId);
    const { v, r, s } = Signature.from(AUTH_SIGNATURE);
    expect(Number(decoded[2].v)).toBe(v);
    expect(decoded[2].r).toBe(r);
    expect(decoded[2].s).toBe(s);
  });

  it('never encodes an ERC-20 approve selector', () => {
    const approve = new Interface(['function approve(address,uint256)']).getFunction('approve')!.selector;
    expect(encodeSettleCall(quote, AUTH_SIGNATURE)).not.toContain(approve.slice(2));
  });

  it('refuses to sign when the token domain does not reproduce its separator', async () => {
    const wallet = token(separatorFor('Wrong Name', '9'));
    await expect(readTokenDomain(wallet, USDC, TEST_CHAIN_ID)).rejects.toBeInstanceOf(WalletError);
    await expect(payQuote(wallet, quote)).rejects.toMatchObject({ code: 'TOKEN_DOMAIN_MISMATCH' });
    expect(wallet.calls.some((call) => call.method === 'eth_signTypedData_v4')).toBe(false);
    expect(wallet.calls.some((call) => call.method === 'eth_sendTransaction')).toBe(false);
  });

  it('switches to the chain the quote was issued for rather than assuming Base mainnet', async () => {
    const wallet = token(undefined, {
      eth_chainId: (() => {
        let current = '0x1';
        return () => {
          const value = current;
          current = `0x${TEST_CHAIN_ID.toString(16)}`;
          return value;
        };
      })(),
      wallet_switchEthereumChain: () => null,
    });
    await payQuote(wallet, quote);
    const [switchCall] = wallet.calls.filter((call) => call.method === 'wallet_switchEthereumChain');
    expect(switchCall.params).toEqual([{ chainId: `0x${TEST_CHAIN_ID.toString(16)}` }]);
  });

  it('reports phases without claiming acceptance', async () => {
    const phases: string[] = [];
    const result = await payQuote(token(), quote, (phase) => phases.push(phase));
    expect(phases).toEqual(['authorizing', 'broadcasting', 'broadcast']);
    expect(result).toEqual({ txHash: TX_HASH, chainId: String(TEST_CHAIN_ID) });
    expect(phases).not.toContain('accepted');
  });

  it('rejects a malformed wallet signature without echoing it', async () => {
    const wallet = token(undefined, { eth_signTypedData_v4: () => '0xdeadbeef' });
    await expect(payQuote(wallet, quote)).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    await expect(payQuote(wallet, quote)).rejects.not.toMatchObject({ message: expect.stringContaining('deadbeef') });
  });
});
