"use strict";

const { getAddress } = require("ethers");
const { BankrGateError } = require("./errors");
const { SETTLE_SELECTOR, decodeSettleCall } = require("./splitter");
const { assertTxHash } = require("./wallet");

/**
 * The broadcaster.
 *
 * The Gate splitter does not require `msg.sender == payer`: the payer's
 * authority travels entirely inside the EIP-3009 authorization signature, which
 * binds `from`, `to`, `value`, and the quote id as its nonce. So the account
 * that pays gas need not be — and here deliberately is NOT — the account that
 * pays USDC.
 *
 * That split exists because Bankr's signing path on Base Sepolia is proven and
 * its broadcast path is not. Bankr signs; a funded relayer broadcasts the exact
 * prepared transaction and nothing else.
 *
 * The interface is intentionally narrow. There is no arbitrary-call
 * abstraction: a relayer receives one already-prepared splitter settlement and
 * cannot substitute a target, calldata, or value.
 *
 *   getAddress()                  -> 0x-address that pays gas
 *   sendTransaction({to,data,value}) -> transaction hash
 *
 * A relayer NEVER receives a Gate session token, a Bankr API credential, an RPC
 * credential, or any advocate content. The only object that crosses this
 * boundary is `{ to, data, value }`.
 */
const REQUIRED_RELAYER_CAPABILITIES = Object.freeze(["getAddress", "sendTransaction"]);

const PREPARED_TX_FIELDS = Object.freeze(["to", "data", "value"]);

function rejected(message) {
  return new BankrGateError("PREPARED_TX_REJECTED", message);
}

function assertRelayerCapabilities(relayer) {
  const missing = REQUIRED_RELAYER_CAPABILITIES.filter((name) => typeof relayer?.[name] !== "function");
  if (missing.length) {
    throw new BankrGateError(
      "RELAYER_UNAVAILABLE",
      `A funded Base Sepolia relayer is required and this one cannot ${missing.join(", ")}. `
      + "Bankr signs the payment; it does not broadcast it.",
    );
  }
  return relayer;
}

function isZeroValue(value) {
  if (value === undefined || value === null) return false;
  try {
    return BigInt(value) === 0n;
  } catch {
    return false;
  }
}

/**
 * Re-derives and re-checks a prepared transaction against the authoritative
 * quote, immediately before it is broadcast.
 *
 * This runs a second time at broadcast even though `authorizePayment` built the
 * object, because the relayer boundary is the last point at which a substituted
 * target, a mutated calldata, or a smuggled ETH value could still be caught.
 * Nothing here trusts the caller's description of the transaction: every value
 * is decoded back out of the calldata that will actually execute.
 */
function assertPreparedTransaction(prepared, quote, nowSeconds) {
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
    throw rejected("A prepared settlement transaction is required.");
  }
  const extras = Object.keys(prepared).filter((field) => !PREPARED_TX_FIELDS.includes(field));
  if (extras.length) throw rejected(`A prepared settlement carries only to, data, and value; got ${extras[0]}.`);

  // 1. The destination is the authoritative splitter from the signed quote's
  //    EIP-712 domain, never a configured or caller-supplied address.
  let to;
  try {
    to = getAddress(String(prepared.to));
  } catch {
    throw rejected("The prepared transaction has no usable destination.");
  }
  const splitter = getAddress(quote.domain.verifyingContract);
  if (to !== splitter) throw rejected("The prepared transaction does not target the Gate splitter this quote names.");

  // 2. The selector is exactly the splitter's `settle`.
  if (typeof prepared.data !== "string" || !prepared.data.startsWith(SETTLE_SELECTOR)) {
    throw rejected("The prepared transaction is not a Gate splitter settlement.");
  }

  // 3. No ETH moves. Settlement is USDC through EIP-3009 only.
  if (!isZeroValue(prepared.value)) throw rejected("A Gate settlement never sends ETH.");

  // 4. The calldata decodes back to this exact quote.
  const decoded = decodeSettleCall(prepared.data);
  const payer = getAddress(quote.message.payer);
  const mismatches = [
    [decoded.quote.quoteId, String(quote.message.quoteId).toLowerCase(), "quote id"],
    [decoded.quote.payer, payer, "payer"],
    [decoded.quote.voter, getAddress(quote.message.voter), "voter"],
    [decoded.quote.attentionAmount, quote.message.attentionAmount, "attention amount"],
    [decoded.quote.gavelFeeAmount, quote.message.gavelFeeAmount, "Gavel fee"],
    [decoded.quote.submissionHash, String(quote.message.submissionHash).toLowerCase(), "submission hash"],
    [decoded.quote.token, getAddress(quote.message.token), "token"],
    [decoded.quote.expiry, quote.message.expiry, "expiry"],
    [decoded.quote.quoteVersion, quote.message.quoteVersion, "quote version"],
    [decoded.quoteSignature, quote.signature, "Gate quote signature"],
    // 5. The authorization pays FROM the Bankr payer TO the splitter, for the
    //    quote total. A relayer can never become the `from`.
    [decoded.authorization.from, payer, "authorization payer"],
    [decoded.authorization.to, splitter, "authorization recipient"],
    [decoded.authorization.value, quote.totalAmount, "authorization amount"],
    [decoded.authorization.nonce, String(quote.message.quoteId).toLowerCase(), "authorization nonce"],
    [decoded.authorization.validBefore, quote.message.expiry, "authorization expiry"],
  ].filter(([actual, expected]) => actual !== expected);
  if (mismatches.length) {
    throw rejected(`The prepared settlement does not match this quote's ${mismatches[0][2]}.`);
  }

  // 6. An expired quote is dead on arrival: the splitter reverts on it, so
  //    broadcasting would only burn gas.
  if (nowSeconds !== undefined && BigInt(quote.message.expiry) <= BigInt(Math.floor(Number(nowSeconds)))) {
    throw new BankrGateError("QUOTE_EXPIRED", "This quote expired before it was broadcast. Nothing was sent.");
  }
  return Object.freeze({ to, data: prepared.data, value: "0x0" });
}

/**
 * Broadcasts one prepared settlement through the relayer.
 *
 * The relayer is handed a freshly rebuilt `{ to, data, value }` and nothing
 * else, so no credential, session, or advocate field can travel with it even by
 * accident.
 *
 * A returned transaction hash is a HINT for Gate. A relayer receipt is not
 * settlement authority and is not delivery.
 */
async function broadcastSettlement({ relayer, prepared, quote, nowSeconds } = {}) {
  assertRelayerCapabilities(relayer);
  const safe = assertPreparedTransaction(prepared, quote, nowSeconds);

  const relayerAddress = getAddress(await relayer.getAddress());
  if (relayerAddress === getAddress(quote.message.payer)) {
    throw new BankrGateError(
      "RELAYER_IS_PAYER",
      "The relayer must be a separate funded account, not the payer wallet.",
    );
  }

  let txHash;
  try {
    txHash = assertTxHash(await relayer.sendTransaction({ to: safe.to, data: safe.data, value: safe.value }));
  } catch (error) {
    if (error instanceof BankrGateError) throw error;
    throw new BankrGateError(
      "BROADCAST_FAILED",
      "The relayer did not get the settlement transaction onto the network.",
      { cause: error },
    );
  }
  return Object.freeze({
    txHash,
    chainId: String(quote.chainId),
    relayer: relayerAddress,
    payer: getAddress(quote.message.payer),
    broadcast: true,
    // A relayer receipt is never acceptance. Only Gate accepts.
    accepted: false,
  });
}

module.exports = {
  PREPARED_TX_FIELDS,
  REQUIRED_RELAYER_CAPABILITIES,
  assertPreparedTransaction,
  assertRelayerCapabilities,
  broadcastSettlement,
};
