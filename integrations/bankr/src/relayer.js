"use strict";

const { getAddress } = require("ethers");
const { PREPARED_SETTLEMENT_FIELDS, assertPreparedSettlement } = require("@gavel/gate");
const { BankrGateError } = require("./errors");
const { asBankrError } = require("./splitter");
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
 * That split exists because Bankr's signing path is proven and its broadcast
 * path is not. Bankr signs; a funded relayer on Base mainnet broadcasts the
 * exact prepared transaction and nothing else.
 *
 * There are two shapes a relayer can take, and both are this narrow:
 *
 *   - an in-process relayer object, used here;
 *   - the Gate server's remote relay endpoint, used through `remote-relay.js`,
 *     where the funded wallet lives server-side and Bankr never holds a key.
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

// The field list is the shared guard's, restated here so a drift fails at load
// rather than at broadcast.
if (PREPARED_TX_FIELDS.length !== PREPARED_SETTLEMENT_FIELDS.length
    || PREPARED_TX_FIELDS.some((field, index) => field !== PREPARED_SETTLEMENT_FIELDS[index])) {
  throw new Error("the Bankr prepared-transaction fields have drifted from the canonical Gate fields");
}

function assertRelayerCapabilities(relayer) {
  const missing = REQUIRED_RELAYER_CAPABILITIES.filter((name) => typeof relayer?.[name] !== "function");
  if (missing.length) {
    throw new BankrGateError(
      "RELAYER_UNAVAILABLE",
      `A funded Base mainnet relayer is required and this one cannot ${missing.join(", ")}. `
      + "Bankr signs the payment; it does not broadcast it. "
      + "Configure GAVEL_GATE_RELAYER_URL to use the Gate server's remote relay instead.",
    );
  }
  return relayer;
}

/**
 * Re-derives and re-checks a prepared transaction against the authoritative
 * quote, immediately before it is broadcast.
 *
 * The checks themselves live in `@gavel/gate` so the Gate server's remote relay
 * applies exactly the same ones server-side before it spends gas. This wrapper
 * only restates a refusal in this client's error type.
 */
function assertPreparedTransaction(prepared, quote, nowSeconds) {
  try {
    return assertPreparedSettlement(prepared, quote, nowSeconds);
  } catch (error) {
    throw asBankrError(error);
  }
}

/**
 * Refuses a relayer that is the payer.
 *
 * The payer's USDC authority is the EIP-3009 signature; a relayer only pays
 * gas. Collapsing the two accounts would put the funded wallet back inside the
 * payment path, which is the thing this split exists to prevent.
 */
function assertRelayerIsNotPayer(relayerAddress, quote) {
  const relayer = getAddress(relayerAddress);
  if (relayer === getAddress(quote.message.payer)) {
    throw new BankrGateError(
      "RELAYER_IS_PAYER",
      "The relayer must be a separate funded account, not the payer wallet.",
    );
  }
  return relayer;
}

/** The receipt shape every broadcast path returns, local or remote. */
function broadcastReceipt({ txHash, quote, relayer, remote = false }) {
  return Object.freeze({
    txHash,
    chainId: String(quote.chainId),
    relayer,
    payer: getAddress(quote.message.payer),
    broadcast: true,
    remote,
    // A relayer receipt is never acceptance. Only Gate accepts.
    accepted: false,
  });
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

  const relayerAddress = assertRelayerIsNotPayer(await relayer.getAddress(), quote);

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
  return broadcastReceipt({ txHash, quote, relayer: relayerAddress });
}

module.exports = {
  PREPARED_TX_FIELDS,
  REQUIRED_RELAYER_CAPABILITIES,
  assertPreparedTransaction,
  assertRelayerCapabilities,
  assertRelayerIsNotPayer,
  broadcastReceipt,
  broadcastSettlement,
};
