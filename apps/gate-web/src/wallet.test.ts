import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, Signature, keccak256, toUtf8Bytes } from 'ethers';
import {
  assertEcdsaSignature,
  assertPayableQuote,
  encodeSettleCall,
  isContractAccount,
  isQuotePayable,
  planPayment,
  payQuote,
  readTokenDomain,
  resolveAccount,
  signTypedData,
  WalletError,
} from './wallet';
import { stubWallet } from './test/harness';
import { NOW_SECONDS, PAYER, QUOTE_EXPIRY_SECONDS, SPLITTER, TEST_CHAIN_ID, USDC, VOTER, quote } from './test/fixtures';

const at = (seconds: number) => ({ now: () => seconds * 1000 });

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
    const result = await payQuote(token(), quote, (phase) => phases.push(phase), at(NOW_SECONDS));
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

describe('quote payability gate', () => {
  it('allows a quote one second before expiry', () => {
    expect(isQuotePayable(quote, QUOTE_EXPIRY_SECONDS - 1)).toBe(true);
    expect(() => assertPayableQuote(quote, QUOTE_EXPIRY_SECONDS - 1)).not.toThrow();
  });

  it('refuses a quote exactly at expiry', () => {
    // `validBefore == expiry`, so the splitter rejects at the boundary too.
    expect(isQuotePayable(quote, QUOTE_EXPIRY_SECONDS)).toBe(false);
    expect(() => assertPayableQuote(quote, QUOTE_EXPIRY_SECONDS)).toThrow(WalletError);
  });

  it('refuses a quote after expiry', () => {
    expect(isQuotePayable(quote, QUOTE_EXPIRY_SECONDS + 1)).toBe(false);
    expect(() => assertPayableQuote(quote, QUOTE_EXPIRY_SECONDS + 3600)).toThrow(WalletError);
  });

  it('refuses an unsupported quote version', () => {
    const unsupported = { ...quote, message: { ...quote.message, quoteVersion: '2' } };
    expect(isQuotePayable(unsupported, NOW_SECONDS)).toBe(false);
    expect(() => assertPayableQuote(unsupported, NOW_SECONDS)).toThrow(WalletError);
  });

  it('refuses a malformed expiry', () => {
    const malformed = { ...quote, message: { ...quote.message, expiry: 'soon' } };
    expect(isQuotePayable(malformed, NOW_SECONDS)).toBe(false);
  });

  it('makes no wallet call at all when refusing an expired quote', async () => {
    const wallet = token();
    await expect(payQuote(wallet, quote, undefined, at(QUOTE_EXPIRY_SECONDS))).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED',
    });
    expect(wallet.calls).toHaveLength(0);
  });

  it('makes no wallet call at all when refusing an unsupported quote version', async () => {
    const wallet = token();
    const unsupported = { ...quote, message: { ...quote.message, quoteVersion: '2' } };
    await expect(payQuote(wallet, unsupported, undefined, at(NOW_SECONDS))).rejects.toMatchObject({
      code: 'UNSUPPORTED_QUOTE_VERSION',
    });
    expect(wallet.calls).toHaveLength(0);
  });
});

const TYPED = {
  domain: { name: 'GavelGate', version: '1', chainId: 1, verifyingContract: VOTER },
  types: { WalletSession: [{ name: 'wallet', type: 'address' }] },
  primaryType: 'WalletSession',
  message: { wallet: VOTER },
};

describe('typed-data signature shape', () => {
  it('accepts a contract wallet signature that is not 65 bytes', async () => {
    // A Safe answers with whatever its own `isValidSignature` will accept for
    // the digest: concatenated owner signatures here. Rejecting it in the
    // browser would decide authority the account alone gets to decide.
    const signature = `0x${'44'.repeat(130)}`;
    const wallet = stubWallet({ eth_signTypedData_v4: () => signature });
    await expect(signTypedData(wallet, VOTER, TYPED)).resolves.toBe(signature);
  });

  it('accepts an empty signature, which is what an approved SafeMessage returns', async () => {
    const wallet = stubWallet({ eth_signTypedData_v4: () => '0x' });
    await expect(signTypedData(wallet, VOTER, TYPED)).resolves.toBe('0x');
  });

  it('still refuses something that is not signature bytes at all', async () => {
    for (const bad of ['signed!', '0xabc', '']) {
      const wallet = stubWallet({ eth_signTypedData_v4: () => bad });
      await expect(signTypedData(wallet, VOTER, TYPED)).rejects.toMatchObject({
        code: 'BAD_SIGNATURE',
      });
    }
  });

  it('holds the payment path to ECDSA, because the splitter consumes v, r, s', () => {
    expect(assertEcdsaSignature(AUTH_SIGNATURE)).toBe(AUTH_SIGNATURE);
    // The contract-wallet shapes the auth path now accepts are exactly the
    // ones a token's `receiveWithAuthorization` cannot use.
    expect(() => assertEcdsaSignature(`0x${'44'.repeat(130)}`)).toThrow(WalletError);
    expect(() => assertEcdsaSignature('0x')).toThrow(WalletError);
  });
});

describe('account reuse', () => {
  it('reuses an already authorized account without prompting', async () => {
    const wallet = stubWallet({ eth_accounts: () => [VOTER.toLowerCase()] });
    await expect(resolveAccount(wallet, VOTER)).resolves.toBe(VOTER);
    expect(wallet.calls.map((call) => call.method)).toEqual(['eth_accounts']);
  });

  it('refuses to sign as a different account than the one the page is showing', async () => {
    const wallet = stubWallet({
      eth_accounts: () => [PAYER],
      eth_requestAccounts: () => [PAYER],
    });
    await expect(resolveAccount(wallet, VOTER)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    // No prompt, and above all no session minted for an account nobody named.
    expect(wallet.calls.map((call) => call.method)).toEqual(['eth_accounts']);
  });

  it('prompts when nothing is authorized yet', async () => {
    const wallet = stubWallet({ eth_accounts: () => [], eth_requestAccounts: () => [VOTER] });
    await expect(resolveAccount(wallet, VOTER)).resolves.toBe(VOTER);
    expect(wallet.calls.map((call) => call.method)).toEqual(['eth_accounts', 'eth_requestAccounts']);
  });

  it('prompts when no account is preferred at all', async () => {
    const wallet = stubWallet({ eth_requestAccounts: () => [VOTER] });
    await expect(resolveAccount(wallet)).resolves.toBe(VOTER);
    expect(wallet.calls.map((call) => call.method)).toEqual(['eth_requestAccounts']);
  });

  it('reads contract-ness from the account code, on whatever chain the wallet is on', async () => {
    await expect(isContractAccount(stubWallet({ eth_getCode: () => '0x' }), VOTER)).resolves.toBe(false);
    await expect(isContractAccount(stubWallet({ eth_getCode: () => '0x6080' }), VOTER)).resolves.toBe(true);
    await expect(
      isContractAccount(stubWallet({ eth_getCode: () => null }), VOTER),
    ).rejects.toMatchObject({ code: 'CODE_UNAVAILABLE' });
  });
});
