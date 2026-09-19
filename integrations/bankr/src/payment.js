"use strict";

const { AbiCoder, Interface, Signature, getAddress, keccak256, toUtf8Bytes } = require("ethers");
const { deriveUsdcAuthorization } = require("@gavel/gate");
const { BankrGateError } = require("./errors");
const { DEFAULT_ALLOWED_CHAIN_IDS, formatUsdcWithUnit } = require("./format");
const { assertPayableQuote } = require("./quote");
const { assertTxHash, assertSignature, assertWalletCapabilities, ensureChain } = require("./wallet");

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

// Matches contracts/gate/src/GavelGateSplitter.sol exactly.
const SPLITTER_ABI = Object.freeze([
  "function settle((bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion) quote, bytes quoteSignature, (address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) authorization)",
]);

const USDC_ABI = Object.freeze([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address owner) view returns (uint256)",
]);

const splitterInterface = new Interface([...SPLITTER_ABI]);
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

/** The authorization is a deterministic derivative of the signed quote. */
function buildAuthorization(quote) {
  return deriveUsdcAuthorization(quote.message, quote.splitter);
}

/**
 * Encodes the single `settle` call.
 *
 * There is NO ERC-20 approve path: one EIP-3009 `receiveWithAuthorization`
 * authorization is consumed by one `settle` call on the splitter, and no USDC
 * ever moves to a Gavel-operated server address.
 */
function encodeSettleCall(quote, authorizationSignature) {
  const { v, r, s } = Signature.from(assertSignature(authorizationSignature));
  return splitterInterface.encodeFunctionData("settle", [
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
    { ...buildAuthorization(quote), v, r, s },
  ]);
}

/**
 * Signs one authorization and broadcasts one `settle` transaction.
 *
 * The confirmation gate is the first thing checked and it is strict: without
 * `confirmed === true` this function touches the wallet zero times. No signing,
 * no chain switch, no token read, no broadcast.
 *
 * Returning a transaction hash is NOT success. The wallet broadcast — and even
 * a mined receipt — is not acceptance. Only Gate's scanner can accept.
 */
async function payQuote({
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

  onPhase("broadcasting");
  let txHash;
  try {
    txHash = assertTxHash(await wallet.sendTransaction({
      from: payer,
      to: quote.splitter,
      data: encodeSettleCall(quote, authorizationSignature),
      value: "0x0",
    }));
  } catch (error) {
    if (error instanceof BankrGateError) throw error;
    throw new BankrGateError(
      "BROADCAST_FAILED",
      "The settlement transaction was not accepted by the network.",
      { cause: error },
    );
  }
  onPhase("broadcast");
  return Object.freeze({ txHash, chainId: String(quote.chainId), broadcast: true, accepted: false });
}

module.exports = {
  EIP712_DOMAIN_TYPEHASH,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  SPLITTER_ABI,
  USDC_ABI,
  buildAuthorization,
  encodeSettleCall,
  payQuote,
  readTokenBalance,
  readTokenDomain,
};
