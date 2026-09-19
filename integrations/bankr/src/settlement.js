"use strict";

const { BankrGateError } = require("./errors");

/** Gate's public receipt states that never change again. */
const TERMINAL_STATES = Object.freeze(["accepted", "expired", "rejected_by_policy", "malformed"]);

/**
 * User-facing copy for each Gate state.
 *
 * Exactly one of these says the request was delivered, and it is only reachable
 * from `accepted` — the state Gate's own scanner sets after it verifies the
 * settlement and creates the voter's inbox item.
 */
const STATE_COPY = Object.freeze({
  payment_required: "Gate is still waiting for payment on this quote.",
  pending_settlement: "Payment was broadcast. Gate is independently verifying it on chain; this is not yet delivery.",
  accepted: "Gate verified the settlement and created the request in the voter's private Gate inbox.",
  expired: "The quote expired. Gate did not accept this request.",
  rejected_by_policy: "Gate rejected this request under its policy.",
  malformed: "Gate rejected this request's content.",
  duplicate: "Gate already holds this exact request.",
});

function describeStatus(state) {
  return STATE_COPY[state] || `Gate reports this request as ${String(state)}.`;
}

/**
 * Submits the broadcast transaction hash as a SETTLEMENT HINT.
 *
 * The hash is a hint and nothing more: it tells Gate's scanner where to look
 * first. Gate verifies the on-chain `QuoteSettled` log itself and would reach
 * the same verdict with no hint at all. A 202 here means "recorded", never
 * "paid", "delivered", or "accepted".
 */
async function submitSettlementHint({ gateApi, token, publicId, txHash, chainId } = {}) {
  const receipt = await gateApi.recordSettlementHint(token, publicId, txHash, chainId);
  return Object.freeze({
    recorded: true,
    hint: true,
    accepted: false,
    publicId,
    txHash,
    state: receipt?.state ?? "pending_settlement",
    message: "Payment was broadcast and the transaction hash was recorded with Gate as a hint. "
      + "Gate is now independently verifying the settlement on chain.",
  });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls Gate's public status endpoint for the AUTHORITATIVE verdict.
 *
 * It waits before the first read: a status taken the instant after broadcast is
 * just the pre-payment state read back. It never infers acceptance from a
 * transaction receipt, a block confirmation, or elapsed time — only from Gate
 * answering `accepted`.
 */
async function pollUntilTerminal({
  gateApi,
  publicId,
  intervalMs = 4_000,
  attempts = 60,
  sleep = defaultSleep,
  onPoll = () => {},
} = {}) {
  if (!gateApi || typeof gateApi.getStatus !== "function") {
    throw new BankrGateError("INVALID_CONFIG", "A Gate API client is required.");
  }
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(intervalMs);
    const status = await gateApi.getStatus(publicId);
    if (status) {
      last = status;
      onPoll(status, attempt);
      if (TERMINAL_STATES.includes(status.state)) {
        return Object.freeze({
          publicId,
          state: status.state,
          delivered: status.state === "accepted",
          settled: status.state === "accepted",
          terminal: true,
          ...(status.acceptedAt === undefined ? {} : { acceptedAt: status.acceptedAt }),
          message: describeStatus(status.state),
        });
      }
    }
  }
  return Object.freeze({
    publicId,
    state: last?.state ?? "pending_settlement",
    delivered: false,
    settled: false,
    terminal: false,
    message: "Gate has not finished verifying this settlement yet. It is still pending_settlement; "
      + "nothing has been delivered and no new quote is needed. Check the status again later.",
  });
}

/** True only for Gate's own `accepted`. Never for a mined transaction. */
function isDelivered(result) {
  return result?.state === "accepted";
}

module.exports = {
  STATE_COPY,
  TERMINAL_STATES,
  describeStatus,
  isDelivered,
  pollUntilTerminal,
  submitSettlementHint,
};
