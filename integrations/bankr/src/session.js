"use strict";

const { getAddress } = require("ethers");
const { BankrGateError } = require("./errors");
const { assertWalletCapabilities } = require("./wallet");

const BASE_SENDER_ROLE = "base_sender";

/**
 * Opens the payer's Gate session.
 *
 * This is Gate's existing WalletSession exchange and nothing else: request a
 * challenge for ONE role, sign that exact typed data, exchange the signature
 * for a short-lived session. There is no Bankr-specific authentication
 * mechanism, no fallback, and no reuse of a session issued for another role.
 *
 * The payer wallet authenticates as `base_sender`. It never authenticates as
 * `dao_profile` or `dao_inbox`, so a Bankr advocate can never hold a session
 * that could read a voter's private inbox.
 *
 * Nothing in this function is logged. The challenge, the signature, and the
 * returned token never reach a console, an artifact, a URL, or storage.
 */
async function openBaseSenderSession({ gateApi, wallet } = {}) {
  if (!gateApi || typeof gateApi.requestChallenge !== "function" || typeof gateApi.verifyProof !== "function") {
    throw new BankrGateError("INVALID_CONFIG", "A Gate API client is required.");
  }
  assertWalletCapabilities(wallet);
  const account = getAddress(await wallet.getAddress());

  const challenge = await gateApi.requestChallenge({
    proofType: "WalletSession",
    wallet: account,
    role: BASE_SENDER_ROLE,
  });
  if (!challenge || challenge.primaryType !== "WalletSession" || !challenge.domain || !challenge.types
      || !challenge.message) {
    throw new BankrGateError("INVALID_AUTH_CHALLENGE", "Gate returned an unusable authentication challenge.");
  }
  if (challenge.message.role !== BASE_SENDER_ROLE
      || getAddress(String(challenge.message.wallet)) !== account) {
    throw new BankrGateError(
      "INVALID_AUTH_CHALLENGE",
      "Gate issued a challenge for a different wallet or role. Nothing was signed.",
    );
  }

  const signature = await wallet.signTypedData({
    account,
    domain: challenge.domain,
    types: challenge.types,
    primaryType: challenge.primaryType,
    message: challenge.message,
  });

  // The verify body is Gate's exact contract: the three typed-data fields it
  // accepts, plus the signature. Nothing is added, renamed, or reordered.
  const verified = await gateApi.verifyProof({
    proofType: "WalletSession",
    typedData: {
      primaryType: challenge.primaryType,
      domain: challenge.domain,
      message: challenge.message,
    },
    signature,
  });

  if (!verified || typeof verified.token !== "string" || !verified.token) {
    throw new BankrGateError("INVALID_AUTH_PROOF", "Gate did not issue a payer session.");
  }
  if (verified.session?.role !== BASE_SENDER_ROLE) {
    throw new BankrGateError(
      "INVALID_AUTH_PROOF",
      `This is not a ${BASE_SENDER_ROLE} session. Authenticate the payer wallet again.`,
    );
  }
  if (getAddress(String(verified.session.wallet)) !== account) {
    throw new BankrGateError("INVALID_AUTH_PROOF", "Gate issued a session for a different wallet.");
  }
  return Object.freeze({ account, token: verified.token, session: Object.freeze({ ...verified.session }) });
}

module.exports = { BASE_SENDER_ROLE, openBaseSenderSession };
