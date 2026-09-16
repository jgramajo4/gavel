import { Interface, Signature, getAddress, keccak256, toUtf8Bytes, AbiCoder } from 'ethers';
import { deriveUsdcAuthorization, type UsdcAuthorization } from './gate-domain';
import type { IssuedQuote } from './types';

/**
 * Wallet and payment boundary.
 *
 * Rules enforced here, not by the UI above it:
 *  - There is no ERC-20 `approve` path. Payment is one EIP-3009
 *    `receiveWithAuthorization` authorization consumed by one `settle` call.
 *  - Every signed and submitted value is derived from the server's persisted
 *    quote. The browser supplies no amount, token, voter, fee, splitter,
 *    quote ID, or submission hash of its own.
 *  - No chain ID is hard-coded. It comes from `quote.domain.chainId`, which the
 *    server persisted and signed over. Testnet works with no code change.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export class WalletError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** The only quote version this client knows how to build calldata for. */
export const SUPPORTED_QUOTE_VERSION = '1';

/**
 * Refuses a quote the browser must not sign for.
 *
 * The splitter sets `validBefore = expiry` and reverts when
 * `block.timestamp >= expiry`, so a signature produced at or after expiry is
 * dead on arrival: it costs gas, leaks a pointless authorization, and tells the
 * user nothing. This runs before any chain switch, any token read, and any
 * signing request, so a refusal touches the wallet zero times.
 */
export function assertPayableQuote(quote: IssuedQuote, nowSeconds: number | bigint): void {
  if (String(quote.message.quoteVersion) !== SUPPORTED_QUOTE_VERSION) {
    throw new WalletError(
      'UNSUPPORTED_QUOTE_VERSION',
      'This quote uses a version this app cannot pay. Request a new quote.',
    );
  }
  let expiry: bigint;
  let now: bigint;
  try {
    expiry = BigInt(quote.message.expiry);
    now = BigInt(nowSeconds);
  } catch {
    throw new WalletError('INVALID_EXPIRY', 'This quote has an unreadable expiry and cannot be paid.');
  }
  if (expiry <= now) {
    throw new WalletError('QUOTE_EXPIRED', 'This quote has expired and can no longer be paid.');
  }
}

export function isQuotePayable(quote: IssuedQuote, nowSeconds: number | bigint): boolean {
  try {
    assertPayableQuote(quote, nowSeconds);
    return true;
  } catch {
    return false;
  }
}

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// Matches contracts/gate/src/GavelGateSplitter.sol exactly.
export const SPLITTER_ABI = [
  'function settle((bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion) quote, bytes quoteSignature, (address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) authorization)',
] as const;

export const USDC_ABI = [
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
] as const;

const splitterInterface = new Interface(SPLITTER_ABI as unknown as string[]);
const usdcInterface = new Interface(USDC_ABI as unknown as string[]);

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

function hexChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

async function ethCall(provider: Eip1193Provider, to: string, data: string): Promise<string> {
  const result = await provider.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
  if (typeof result !== 'string') throw new WalletError('CALL_FAILED', 'Contract read failed.');
  return result;
}

/**
 * Reads the token's own EIP-712 domain rather than assuming one.
 *
 * The merged backend does not publish the USDC domain name/version (see the
 * PR7 report's backend-gap list), and guessing "USD Coin"/"2" would silently
 * break on any testnet token. Instead the fields are read from the token and
 * then proven correct against the token's own DOMAIN_SEPARATOR before anything
 * is signed. A mismatch aborts; it never falls back to a guess.
 */
export async function readTokenDomain(
  provider: Eip1193Provider,
  token: string,
  chainId: number,
): Promise<TokenDomain> {
  const verifyingContract = getAddress(token);
  const [nameRaw, versionRaw, separatorRaw] = await Promise.all([
    ethCall(provider, verifyingContract, usdcInterface.encodeFunctionData('name')),
    ethCall(provider, verifyingContract, usdcInterface.encodeFunctionData('version')),
    ethCall(provider, verifyingContract, usdcInterface.encodeFunctionData('DOMAIN_SEPARATOR')),
  ]);
  const [name] = usdcInterface.decodeFunctionResult('name', nameRaw);
  const [version] = usdcInterface.decodeFunctionResult('version', versionRaw);
  const [separator] = usdcInterface.decodeFunctionResult('DOMAIN_SEPARATOR', separatorRaw);
  const domain: TokenDomain = { name: String(name), version: String(version), chainId, verifyingContract };
  const computed = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toUtf8Bytes(domain.name)),
        keccak256(toUtf8Bytes(domain.version)),
        domain.chainId,
        domain.verifyingContract,
      ],
    ),
  );
  if (computed.toLowerCase() !== String(separator).toLowerCase()) {
    throw new WalletError(
      'TOKEN_DOMAIN_MISMATCH',
      'The payment token reports a domain separator this app cannot reproduce. Payment was not attempted.',
    );
  }
  return domain;
}

export async function connect(provider: Eip1193Provider): Promise<string> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const [account] = Array.isArray(accounts) ? accounts : [];
  if (typeof account !== 'string') throw new WalletError('NO_ACCOUNT', 'No wallet account was authorized.');
  return getAddress(account);
}

export async function getChainId(provider: Eip1193Provider): Promise<number> {
  const raw = await provider.request({ method: 'eth_chainId' });
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WalletError('UNKNOWN_CHAIN', 'The wallet did not report a usable chain.');
  }
  return value;
}

/** Asks the wallet to move to the chain the SERVER bound this quote to. */
export async function ensureChain(provider: Eip1193Provider, chainId: number): Promise<void> {
  if ((await getChainId(provider)) === chainId) return;
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: hexChainId(chainId) }],
  });
  if ((await getChainId(provider)) !== chainId) {
    throw new WalletError('WRONG_CHAIN', 'The wallet is not on the chain this quote was issued for.');
  }
}

export async function signTypedData(
  provider: Eip1193Provider,
  account: string,
  payload: { domain: object; types: object; primaryType: string; message: object },
): Promise<string> {
  const signature = await provider.request({
    method: 'eth_signTypedData_v4',
    params: [
      account,
      JSON.stringify({
        domain: payload.domain,
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' },
          ],
          ...payload.types,
        },
        primaryType: payload.primaryType,
        message: payload.message,
      }),
    ],
  });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    // Never echo the raw value back in the message; a malformed signature is
    // still signature material.
    throw new WalletError('BAD_SIGNATURE', 'The wallet returned an unusable signature.');
  }
  return signature;
}

export interface PaymentPlan {
  chainId: number;
  splitter: string;
  token: string;
  authorization: UsdcAuthorization;
}

/** Derives the payment plan from the persisted quote. No browser input. */
export function planPayment(quote: IssuedQuote): PaymentPlan {
  const splitter = getAddress(quote.domain.verifyingContract);
  return {
    chainId: quote.domain.chainId,
    splitter,
    token: getAddress(quote.message.token),
    authorization: deriveUsdcAuthorization(quote.message, splitter),
  };
}

export function encodeSettleCall(quote: IssuedQuote, authorizationSignature: string): string {
  const plan = planPayment(quote);
  const { v, r, s } = Signature.from(authorizationSignature);
  return splitterInterface.encodeFunctionData('settle', [
    {
      quoteId: quote.message.quoteId,
      payer: quote.message.payer,
      voter: quote.message.voter,
      attentionAmount: quote.message.attentionAmount,
      gavelFeeAmount: quote.message.gavelFeeAmount,
      submissionHash: quote.message.submissionHash,
      token: quote.message.token,
      expiry: quote.message.expiry,
      quoteVersion: quote.message.quoteVersion,
    },
    quote.signature,
    { ...plan.authorization, v, r, s },
  ]);
}

export type PaymentPhase =
  | 'idle'
  | 'authorizing'
  | 'broadcasting'
  | 'broadcast'
  | 'rejected'
  | 'failed';

export interface PaymentResult {
  txHash: string;
  chainId: string;
}

/**
 * One authorization signature, one `settle` transaction. There is deliberately
 * no approve step, no transfer to any Gavel-operated address, and no waiting on
 * a local receipt to declare success — acceptance is the server's call alone.
 */
export async function payQuote(
  provider: Eip1193Provider,
  quote: IssuedQuote,
  onPhase: (phase: PaymentPhase) => void = () => {},
  { now = Date.now }: { now?: () => number } = {},
): Promise<PaymentResult> {
  // Expiry and version are checked first so a refusal never reaches the wallet.
  assertPayableQuote(quote, Math.floor(now() / 1000));
  const plan = planPayment(quote);
  await ensureChain(provider, plan.chainId);
  const payer = getAddress(quote.message.payer);

  onPhase('authorizing');
  const tokenDomain = await readTokenDomain(provider, plan.token, plan.chainId);
  const authorizationSignature = await signTypedData(provider, payer, {
    domain: tokenDomain,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES as unknown as object,
    primaryType: 'ReceiveWithAuthorization',
    message: plan.authorization,
  });

  onPhase('broadcasting');
  const txHash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: payer, to: plan.splitter, data: encodeSettleCall(quote, authorizationSignature), value: '0x0' }],
  });
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new WalletError('BAD_TX_HASH', 'The wallet did not return a transaction hash.');
  }
  onPhase('broadcast');
  return { txHash, chainId: String(plan.chainId) };
}
