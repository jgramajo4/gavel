"use strict";

/**
 * One error type for the whole Bankr Gate advocate client.
 *
 * `code` is a stable, coarse vocabulary the skill can branch on. `message` is
 * user-facing copy. Nothing here ever carries a session token, a signature, a
 * private key, an RPC credential, or an advocate's raw content: an error is a
 * reason to stop, not a place to echo secrets.
 */
class BankrGateError extends Error {
  constructor(code, message, { state, status, cause } = {}) {
    super(message);
    this.name = "BankrGateError";
    this.code = code;
    if (state !== undefined) this.state = state;
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.state === undefined ? {} : { state: this.state }),
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

// The Gate server's coarse rejection codes, mapped to advocate-facing copy.
// Gate owns every one of these decisions; the client only explains them.
const GATE_ERROR_COPY = Object.freeze({
  UNAUTHORIZED: "This Gate session is no longer valid. Authenticate the payer wallet again.",
  NOT_ACCEPTING: "This voter is not currently accepting this kind of request.",
  NOT_FOUND: "Gate has no record of that voter or submission.",
  CANONICAL_DATA_UNAVAILABLE: "Gate could not read canonical Nouns data right now. Nothing was charged.",
  ACTIVE_QUOTE_EXISTS: "There is already an active quote for this exact request.",
  SENDER_PROPOSAL_LIMIT: "Gate declined this request under its per-sender limits.",
  SENDER_BLOCKED: "Gate declined this request under its per-sender limits.",
  RATE_LIMITED: "Gate is rate limiting this payer. Wait and try the same request again.",
  INVALID_SUBMISSION: "Gate rejected this submission's content.",
  INVALID_REQUEST: "Gate rejected this request's shape.",
  REQUEST_TOO_LARGE: "This request is larger than Gate accepts.",
  EXPIRED: "This quote expired before it was paid.",
  INVALID_SETTLEMENT: "Gate rejected this settlement hint.",
  INVALID_RELAY: "Gate rejected this relay request. Nothing was broadcast.",
  NOT_PAYABLE: "Gate has already moved past this quote; there is nothing to broadcast.",
  INVALID_AUTH_CHALLENGE: "Gate rejected this authentication challenge request.",
  INVALID_AUTH_PROOF: "Gate rejected this wallet session proof.",
});

function gateCopy(code, fallback) {
  return GATE_ERROR_COPY[code] || fallback;
}

module.exports = { BankrGateError, GATE_ERROR_COPY, gateCopy };
