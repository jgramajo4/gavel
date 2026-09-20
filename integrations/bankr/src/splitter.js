"use strict";

const { Interface } = require("ethers");
const {
  PreparedSettlementError,
  SETTLE_SELECTOR,
  SPLITTER_SETTLE_ABI,
  buildSettlementAuthorization,
  decodeSettleCall: decodeSharedSettleCall,
  encodeSettleCall: encodeSharedSettleCall,
} = require("@gavel/gate");
const { BankrGateError } = require("./errors");

// Matches contracts/gate/src/GavelGateSplitter.sol exactly.
const SPLITTER_ABI = Object.freeze([
  "function settle((bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion) quote, bytes quoteSignature, (address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s) authorization)",
]);

// The encoding, decoding, and pre-broadcast checks live in @gavel/gate so the
// Gate server's remote relay runs the SAME code over the SAME decoded values.
// This literal stays here so a local drift from the shared ABI fails at load
// rather than at broadcast, where it would cost gas.
if (SPLITTER_ABI.length !== SPLITTER_SETTLE_ABI.length
    || SPLITTER_ABI.some((entry, index) => entry !== SPLITTER_SETTLE_ABI[index])) {
  throw new Error("the Bankr splitter ABI has drifted from the canonical Gate splitter ABI");
}

const splitterInterface = new Interface([...SPLITTER_ABI]);

/**
 * Converts a shared-guard refusal into this client's error type.
 *
 * The code and the copy are unchanged: the guard is the authority on WHY a
 * settlement is refused, and this only restates it in the vocabulary the skill
 * branches on.
 */
function asBankrError(error) {
  return error instanceof PreparedSettlementError
    ? new BankrGateError(error.code, error.message)
    : error;
}

/** The authorization is a deterministic derivative of the signed quote. */
function buildAuthorization(quote) {
  return buildSettlementAuthorization(quote);
}

/**
 * Encodes the single `settle` call.
 *
 * There is NO ERC-20 approve path: one EIP-3009 `receiveWithAuthorization`
 * authorization is consumed by one `settle` call on the splitter, and no USDC
 * ever moves to a Gavel-operated server address.
 */
function encodeSettleCall(quote, authorizationSignature) {
  try {
    return encodeSharedSettleCall(quote, authorizationSignature);
  } catch (error) {
    throw asBankrError(error);
  }
}

/**
 * Decodes a settle call back into the exact values it will execute with.
 *
 * The broadcaster re-derives what it is about to send rather than trusting the
 * caller's description of it.
 */
function decodeSettleCall(data) {
  try {
    return decodeSharedSettleCall(data);
  } catch (error) {
    throw asBankrError(error);
  }
}

module.exports = {
  SETTLE_SELECTOR,
  SPLITTER_ABI,
  asBankrError,
  buildAuthorization,
  decodeSettleCall,
  encodeSettleCall,
  splitterInterface,
};
