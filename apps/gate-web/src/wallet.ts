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

/**
 * The accounts the wallet has ALREADY authorized, without prompting.
 *
 * `eth_accounts` never opens a wallet window: it reports what the page may
 * already use. That is what lets a workflow reuse the header's connection
 * instead of asking a connected person to connect a second time.
 */
export async function listAccounts(provider: Eip1193Provider): Promise<string[]> {
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (!Array.isArray(accounts)) return [];
  const authorized: string[] = [];
  for (const entry of accounts) {
    if (typeof entry !== 'string') continue;
    try {
      authorized.push(getAddress(entry));
    } catch {
      // A wallet that reports an unparseable account contributes nothing.
    }
  }
  return authorized;
}

/**
 * Resolves the account a role-scoped workflow is about to sign with.
 *
 * `preferred` is the account the global header is already showing. When the
 * wallet still lists it, it is reused and nothing is prompted — a connected
 * person is asked to SIGN, not to connect again. When the wallet lists other
 * accounts but not that one, this refuses rather than silently signing as
 * somebody else: a session minted for an account the page never named is worse
 * than a visible failure. Only a wallet with nothing authorized prompts.
 */
export async function resolveAccount(
  provider: Eip1193Provider,
  preferred: string | null = null,
): Promise<string> {
  let wanted: string | null = null;
  if (typeof preferred === 'string') {
    try {
      wanted = getAddress(preferred);
    } catch {
      wanted = null;
    }
  }
  if (wanted) {
    let authorized: string[] = [];
    try {
      authorized = await listAccounts(provider);
    } catch {
      // A wallet without `eth_accounts` simply falls through to a prompt.
      authorized = [];
    }
    if (authorized.includes(wanted)) return wanted;
    if (authorized.length > 0) {
      throw new WalletError(
        'ACCOUNT_CHANGED',
        'The wallet is no longer on the account shown in the header. Reconnect and try again.',
      );
    }
  }
  return connect(provider);
}

/**
 * Whether `account` is a contract wallet on the chain the provider is on.
 *
 * Empty code means an externally owned account. Anything else is a contract
 * wallet — a Safe, typically — whose authority is an ERC-1271 question, and
 * whose enrollment the server holds to a stricter proof set.
 */
export async function isContractAccount(
  provider: Eip1193Provider,
  account: string,
): Promise<boolean> {
  const code = await provider.request({
    method: 'eth_getCode',
    params: [getAddress(account), 'latest'],
  });
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) {
    throw new WalletError('CODE_UNAVAILABLE', 'The wallet could not report whether this account is a contract.');
  }
  return code !== '0x';
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

/** Any signature bytes a verifier may accept: ECDSA, or an ERC-1271 blob. */
const SIGNATURE_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/** The 65-byte ECDSA shape, and only that, splits into the `v, r, s` a
 *  token's `receiveWithAuthorization` needs. */
const ECDSA_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

/**
 * Refuses anything the splitter path cannot split into `v, r, s`.
 *
 * This is the payment boundary's own rule, deliberately NOT `signTypedData`'s:
 * the EIP-3009 authorization is consumed as three scalars by a token contract
 * that knows nothing about ERC-1271, so an advocate paying from a contract
 * wallet must fail here rather than produce calldata that reverts on chain.
 */
export function assertEcdsaSignature(signature: string): string {
  if (!ECDSA_SIGNATURE.test(signature)) {
    // Never echo the raw value back in the message; a malformed signature is
    // still signature material.
    throw new WalletError('BAD_SIGNATURE', 'The wallet returned an unusable signature.');
  }
  return signature;
}

/**
 * Signs typed data and returns the wallet's signature bytes, whatever their
 * length.
 *
 * A 65-byte ECDSA signature is what an EOA returns, and it is NOT what a
 * contract wallet returns. A Safe answers `eth_signTypedData_v4` with whatever
 * its own ERC-1271 `isValidSignature` will later accept for that digest: the
 * concatenated owner signatures, an empty `0x` when the SafeMessage is already
 * approved, or another wallet-defined encoding. Assuming 65 bytes here would
 * reject every one of those in the browser, before the server ever got the
 * chance to ask the contract — so the check is exactly what it can honestly be
 * (hex, whole bytes) and authority is decided where it belongs: by the account
 * itself, on chain, through the server's ERC-1271 verification.
 */
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
  if (typeof signature !== 'string' || !SIGNATURE_BYTES.test(signature)) {
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
  // The splitter consumes `v, r, s`, so this path — and only this path — holds
  // the signature to the 65-byte ECDSA shape.
  const authorizationSignature = assertEcdsaSignature(
    await signTypedData(provider, payer, {
      domain: tokenDomain,
      types: RECEIVE_WITH_AUTHORIZATION_TYPES as unknown as object,
      primaryType: 'ReceiveWithAuthorization',
      message: plan.authorization,
    }),
  );

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
