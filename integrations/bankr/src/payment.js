"use strict";

const { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes, verifyTypedData } = require("ethers");
const { BankrGateError } = require("./errors");
const { DEFAULT_ALLOWED_CHAIN_IDS, formatUsdcWithUnit } = require("./format");
const { assertPayableQuote } = require("./quote");
const { SPLITTER_ABI, buildAuthorization, encodeSettleCall } = require("./splitter");
const { broadcastSettlement } = require("./relayer");
const { assertSignature, assertWalletCapabilities, ensureChain } = require("./wallet");

/**
 * The EIP-3009 struct USDC signs. Gate's semantics are unchanged: this is the
 * token's own type, and every field value is derived from the signed quote.
 */
const RECEIVE_WITH_AUTHORIZATION_TYPES = Object.freeze({
  ReceiveWithAuthorization: Object.freeze([
    Object.freeze({ name: "from", type: "address" }),
    Object.freeze({ name: "to", type: "address" }),
    Object.freeze({ name: "value", type: "uint256" }),
    Object.freeze({ name: "validAfter", type: "uint256" }),
    Object.freeze({ name: "validBefore", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "bytes32" }),
  ]),
});

const USDC_ABI = Object.freeze([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const usdcInterface = new Interface([...USDC_ABI]);

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);

/**
 * Reads the payment token's OWN EIP-712 domain and proves it.
 *
 * Nothing is guessed. The name and version come from the token, and they are
 * only used after they reproduce the token's own `DOMAIN_SEPARATOR`. A mismatch
 * aborts before any signature is requested; it never falls back to a guess,
 * which is what keeps a testnet USDC working with no code change.
 */
async function readTokenDomain(wallet, token, chainId) {
  const verifyingContract = getAddress(token);
  const [nameRaw, versionRaw, separatorRaw] = await Promise.all([
    wallet.call({ to: verifyingContract, data: usdcInterface.encodeFunctionData("name") }),
    wallet.call({ to: verifyingContract, data: usdcInterface.encodeFunctionData("version") }),
    wallet.call({ to: verifyingContract, data: usdcInterface.encodeFunctionData("DOMAIN_SEPARATOR") }),
  ]);
  let domain;
  try {
    const [name] = usdcInterface.decodeFunctionResult("name", nameRaw);
    const [version] = usdcInterface.decodeFunctionResult("version", versionRaw);
    const [separator] = usdcInterface.decodeFunctionResult("DOMAIN_SEPARATOR", separatorRaw);
    domain = { name: String(name), version: String(version), chainId: Number(chainId), verifyingContract, separator };
  } catch (cause) {
    throw new BankrGateError("CHAIN_READ_FAILED", "The payment token did not answer a domain read.", { cause });
  }
  const computed = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [
      EIP712_DOMAIN_TYPEHASH,
      keccak256(toUtf8Bytes(domain.name)),
      keccak256(toUtf8Bytes(domain.version)),
      domain.chainId,
      domain.verifyingContract,
    ],
  ));
  if (computed.toLowerCase() !== String(domain.separator).toLowerCase()) {
    throw new BankrGateError(
      "TOKEN_DOMAIN_MISMATCH",
      "The payment token reports a domain separator this client cannot reproduce. Payment was not attempted.",
    );
  }
  return Object.freeze({
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  });
}

async function readTokenBalance(wallet, token, owner) {
  const raw = await wallet.call({
    to: getAddress(token),
    data: usdcInterface.encodeFunctionData("balanceOf", [getAddress(owner)]),
  });
  try {
    const [balance] = usdcInterface.decodeFunctionResult("balanceOf", raw);
    return BigInt(balance);
  } catch (cause) {
    throw new BankrGateError("CHAIN_READ_FAILED", "The payment token did not answer a balance read.", { cause });
  }
}

/**
 * Step 1 of 2: Bankr signs, and nothing is broadcast.
 *
 * The confirmation gate is the first thing checked and it is strict: without
 * `confirmed === true` this function touches the wallet zero times. No signing,
 * no chain switch, no token read.
 *
 * What comes back is an immutable prepared transaction — `{ to, data, value }`
 * and nothing else. Every field in it is derived from the quote Gate signed;
 * none of it is caller-supplied. The authorization signature is verified
 * LOCALLY to recover to the quote's payer before the calldata is built, so a
 * wallet that signed the wrong payload fails here rather than on chain.
 */
async function authorizePayment({
  wallet,
  quote,
  confirmed,
  onPhase = () => {},
  now = () => Date.now(),
  allowedChainIds = DEFAULT_ALLOWED_CHAIN_IDS,
} = {}) {
  if (confirmed !== true) {
    throw new BankrGateError(
      "CONFIRMATION_REQUIRED",
      "Payment needs explicit confirmation. Nothing was signed and nothing was sent.",
    );
  }
  assertWalletCapabilities(wallet);
  // Version, chain, and expiry are checked before the wallet is touched.
  assertPayableQuote(quote, Math.floor(Number(now()) / 1000), { allowedChainIds });

  const payer = getAddress(quote.message.payer);
  const signer = getAddress(await wallet.getAddress());
  if (signer !== payer) {
    throw new BankrGateError(
      "PAYER_MISMATCH",
      "This quote was issued to a different payer wallet than the one connected.",
    );
  }

  // The signing wallet must sit on the quote's chain: the token domain read and
  // the EIP-712 domain it produces are chain-bound.
  await ensureChain(wallet, quote.chainId);

  const total = BigInt(quote.totalAmount);
  const balance = await readTokenBalance(wallet, quote.token, payer);
  if (balance < total) {
    throw new BankrGateError(
      "INSUFFICIENT_BALANCE",
      `This wallet holds ${formatUsdcWithUnit(balance.toString(10), quote.chainId)} and this quote needs ${
        formatUsdcWithUnit(quote.totalAmount, quote.chainId)}. Nothing was signed.`,
    );
  }

  onPhase("authorizing");
  const tokenDomain = await readTokenDomain(wallet, quote.token, quote.chainId);
  const authorization = buildAuthorization(quote);
  let authorizationSignature;
  try {
    authorizationSignature = assertSignature(await wallet.signTypedData({
      account: payer,
      domain: tokenDomain,
      types: RECEIVE_WITH_AUTHORIZATION_TYPES,
      primaryType: "ReceiveWithAuthorization",
      message: authorization,
    }));
  } catch (error) {
    if (error instanceof BankrGateError) throw error;
    throw new BankrGateError("AUTHORIZATION_FAILED", "The wallet did not authorize this payment.", { cause: error });
  }

  // Local proof that the signature covers THIS authorization and recovers to
  // the payer. A relayer is about to spend gas on it; a bad signature should
  // cost nothing. The failure never echoes the signature itself.
  let recovered;
  try {
    recovered = getAddress(verifyTypedData(
      tokenDomain,
      { ...RECEIVE_WITH_AUTHORIZATION_TYPES },
      authorization,
      authorizationSignature,
    ));
  } catch (cause) {
    throw new BankrGateError("AUTHORIZATION_FAILED", "The payment authorization could not be verified.", { cause });
  }
  if (recovered !== payer) {
    throw new BankrGateError(
      "AUTHORIZATION_FAILED",
      "The payment authorization does not recover to the quote's payer. Nothing was broadcast.",
    );
  }

  onPhase("authorized");
  // Immutable, and exactly the three fields a relayer may see.
  return Object.freeze({
    to: quote.splitter,
    data: encodeSettleCall(quote, authorizationSignature),
    value: "0x0",
  });
}

/**
 * Step 2 of 2: a separate funded relayer broadcasts the prepared transaction.
 *
 * Bankr does not broadcast. The Gate splitter does not require
 * `msg.sender == payer`, so the relayer pays gas while the payer's USDC
 * authority stays entirely inside the EIP-3009 signature.
 */
async function broadcastPayment({ relayer, prepared, quote, onPhase = () => {}, now = () => Date.now() } = {}) {
  onPhase("broadcasting");
  const result = await broadcastSettlement({
    relayer,
    prepared,
    quote,
    nowSeconds: Math.floor(Number(now()) / 1000),
  });
  onPhase("broadcast");
  return result;
}

/**
 * Authorize then broadcast.
 *
 * Returning a transaction hash is NOT success. A relayer receipt — even a mined
 * one — is not acceptance. Only Gate's scanner can accept.
 */
async function payQuote({
  wallet,
  relayer,
  quote,
  confirmed,
  onPhase = () => {},
  now = () => Date.now(),
  allowedChainIds = DEFAULT_ALLOWED_CHAIN_IDS,
} = {}) {
  const prepared = await authorizePayment({ wallet, quote, confirmed, onPhase, now, allowedChainIds });
  return broadcastPayment({ relayer, prepared, quote, onPhase, now });
}

module.exports = {
  EIP712_DOMAIN_TYPEHASH,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  SPLITTER_ABI,
  USDC_ABI,
  authorizePayment,
  broadcastPayment,
  buildAuthorization,
  encodeSettleCall,
  payQuote,
  readTokenBalance,
  readTokenDomain,
};
