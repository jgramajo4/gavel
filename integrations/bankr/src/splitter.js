"use strict";

const { Interface, Signature, getAddress } = require("ethers");
const { deriveUsdcAuthorization } = require("@gavel/gate");
const { BankrGateError } = require("./errors");

// Matches contracts/gate/src/GavelGateSplitter.sol exactly.
const SPLITTER_ABI = Object.freeze([
  "function settle((bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion) quote, bytes quoteSignature, (address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) authorization)",
]);

const splitterInterface = new Interface([...SPLITTER_ABI]);
const SETTLE_SELECTOR = splitterInterface.getFunction("settle").selector;

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
  const { v, r, s } = Signature.from(authorizationSignature);
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
 * Decodes a settle call back into the exact values it will execute with.
 *
 * The broadcaster re-derives what it is about to send rather than trusting the
 * caller's description of it.
 */
function decodeSettleCall(data) {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data) || !data.startsWith(SETTLE_SELECTOR)) {
    throw new BankrGateError("PREPARED_TX_REJECTED", "This transaction is not a Gate splitter settlement.");
  }
  let decoded;
  try {
    decoded = splitterInterface.decodeFunctionData("settle", data);
  } catch (cause) {
    throw new BankrGateError("PREPARED_TX_REJECTED", "This settlement calldata could not be decoded.", { cause });
  }
  const [quote, quoteSignature, authorization] = decoded;
  return Object.freeze({
    quote: Object.freeze({
      quoteId: String(quote.quoteId).toLowerCase(),
      payer: getAddress(quote.payer),
      voter: getAddress(quote.voter),
      attentionAmount: quote.attentionAmount.toString(10),
      gavelFeeAmount: quote.gavelFeeAmount.toString(10),
      submissionHash: String(quote.submissionHash).toLowerCase(),
      token: getAddress(quote.token),
      expiry: quote.expiry.toString(10),
      quoteVersion: quote.quoteVersion.toString(10),
    }),
    quoteSignature,
    authorization: Object.freeze({
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: authorization.value.toString(10),
      validAfter: authorization.validAfter.toString(10),
      validBefore: authorization.validBefore.toString(10),
      nonce: String(authorization.nonce).toLowerCase(),
    }),
  });
}

module.exports = {
  SETTLE_SELECTOR,
  SPLITTER_ABI,
  buildAuthorization,
  decodeSettleCall,
  encodeSettleCall,
  splitterInterface,
};
