"use strict";

const { getAddress } = require("ethers");
const { canonicalRelayOrigin } = require("./config");
const { BankrGateError } = require("./errors");
const { PUBLIC_ID, errorFrom } = require("./gate-api");
const { assertPreparedTransaction, assertRelayerIsNotPayer, broadcastReceipt } = require("./relayer");
const { decodeSettleCall } = require("./splitter");
const { assertTxHash } = require("./wallet");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

/**
 * The remote relayer.
 *
 * A Bankr sandbox is ephemeral and holds no funded key, so the account that
 * pays gas lives on the Gate server instead. This client is what reaches it,
 * and the boundary is narrower than the in-process one, not wider:
 *
 *   in-process relayer  ->  { to, data, value }
 *   remote relay        ->  { authorization: { signature } }
 *
 * Nothing about the transaction crosses the wire. Gate holds the quote it
 * signed itself, rebuilds the settlement calldata from that quote, re-runs the
 * same prepared-settlement guard server-side, and hands its gas-only wallet the
 * result. There is no request shape that makes it broadcast something else:
 * a `to`, a `data`, or a `value` is refused by the endpoint, not ignored.
 *
 * Bankr still builds and checks the prepared transaction locally first. That is
 * what proves the signature it is about to send is the one bound to THIS quote:
 * the signature is read back out of the calldata the guard approved, never
 * taken on trust.
 *
 * What travels: the Gate session token this payer already holds, in an
 * `Authorization` header to the Gate origin, and one EIP-3009 signature — which
 * is exactly what the protocol requires to settle, and nothing more. No private
 * key, no RPC credential, no Bankr credential, and no advocate content.
 */
function createRemoteRelay({ relayUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof relayUrl !== "string" || !relayUrl) {
    throw new BankrGateError("INVALID_CONFIG", "A Gate relay origin is required.");
  }
  if (typeof fetchImpl !== "function") throw new BankrGateError("INVALID_CONFIG", "A fetch implementation is required.");
  // Re-validated here, not only where the environment is read, so an injected
  // configuration cannot point a production relay at a laptop or a LAN box.
  const root = canonicalRelayOrigin(relayUrl, "GAVEL_GATE_RELAYER_URL");

  async function post(path, token, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } catch (cause) {
      // The relay may or may not have broadcast before the connection failed.
      // This is an UNKNOWN outcome, never a reason to sign a second payment.
      throw new BankrGateError(
        "TRANSPORT_FAILED",
        "The relay request did not complete. Whether the settlement was broadcast is unknown; "
        + "check this submission's Gate status before doing anything else. Do not pay again.",
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
    let parsed = null;
    try {
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error("oversized response");
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.status < 200 || response.status >= 300) throw errorFrom(response.status, parsed);
    return parsed;
  }

  return Object.freeze({
    origin: root,

    /**
     * Relays ONE prepared settlement and returns the same receipt shape an
     * in-process relayer produces.
     *
     * A returned transaction hash is a HINT for Gate. A relay receipt is not
     * settlement authority and is not delivery.
     */
    async relay({ token, publicId, prepared, quote, nowSeconds } = {}) {
      if (typeof token !== "string" || token === "") {
        throw new BankrGateError("UNAUTHORIZED", "Authenticate the payer wallet first.");
      }
      if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) {
        throw new BankrGateError("INVALID_REQUEST", "A Gate submission id is required.");
      }
      // The same guard the in-process path runs, and the reason the signature
      // below can be trusted to belong to this quote.
      const safe = assertPreparedTransaction(prepared, quote, nowSeconds);
      const { authorizationSignature } = decodeSettleCall(safe.data);

      const receipt = await post(`/v1/submissions/${publicId}/relay`, token, {
        authorization: { signature: authorizationSignature },
      });

      const txHash = assertTxHash(receipt?.txHash);
      if (String(receipt?.chainId) !== String(quote.chainId)) {
        throw new BankrGateError(
          "PREPARED_TX_REJECTED",
          "The relay reported a different chain than this quote was issued for.",
        );
      }
      let relayerAddress;
      try {
        relayerAddress = getAddress(String(receipt?.relayer));
      } catch {
        throw new BankrGateError("BROADCAST_FAILED", "The relay did not name the account that paid gas.");
      }
      // The gas payer is never the USDC payer, wherever it runs.
      assertRelayerIsNotPayer(relayerAddress, quote);
      return broadcastReceipt({ txHash, quote, relayer: relayerAddress, remote: true });
    },
  });
}

module.exports = { DEFAULT_TIMEOUT_MS, createRemoteRelay };
