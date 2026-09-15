"use strict";

const { getAddress } = require("ethers");
const {
  QUOTE_LIFETIME_SECONDS,
  QUOTE_VERSION,
  buildQuoteMessage,
  createQuoteDomain,
  createQuoteTypedData,
  quoteTotalAmount,
  verifyQuoteSignature,
} = require("@gavel/gate");

const QUOTE_LIFETIME_MS = QUOTE_LIFETIME_SECONDS * 1000;

// Every Gate store constructs, signs, and re-reads quotes through this module,
// so the in-memory and Postgres paths cannot drift apart on domain, message
// encoding, lifetime, or signature verification.

function issuanceInstant(value) {
  const at = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(at.getTime())) throw new TypeError("issuance instant must be a valid time");
  // EIP-712 expiry is a Unix second, so issuance time is truncated once, here.
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}

function quoteExpiryFrom(issuedAt) {
  return new Date(issuanceInstant(issuedAt).getTime() + QUOTE_LIFETIME_MS);
}

function buildIssuedQuoteMessage({
  quoteId, payer, voter, attentionAmount, feeAmount, submissionHash, token, expiresAt,
} = {}) {
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) throw new TypeError("quote expiry must be a valid time");
  if (expiry.getTime() % 1000 !== 0) throw new TypeError("quote expiry must land on a whole second");
  return buildQuoteMessage({
    quoteId,
    payer,
    voter,
    attentionAmount: String(attentionAmount),
    gavelFeeAmount: String(feeAmount),
    submissionHash,
    token,
    expiry: String(expiry.getTime() / 1000),
    quoteVersion: String(QUOTE_VERSION),
  });
}

// A signer is bound to one chain and one splitter at construction. Issuance
// refuses to use a signer whose domain is not the deployment being quoted.
function assertSignerDeploymentBinding(signer, { chainId, splitter } = {}) {
  if (!signer || typeof signer.signQuote !== "function" || typeof signer.address !== "string" || !signer.domain) {
    throw new TypeError("an injected quote signer exposing address, domain, and signQuote is required");
  }
  let expectedSplitter;
  try {
    expectedSplitter = getAddress(String(splitter));
  } catch {
    throw new TypeError("deployment splitter is invalid");
  }
  let boundSplitter;
  try {
    boundSplitter = getAddress(String(signer.domain.verifyingContract));
  } catch {
    throw new TypeError("quote signer domain verifyingContract is invalid");
  }
  if (String(signer.domain.chainId) !== String(chainId) || boundSplitter !== expectedSplitter) {
    throw new Error("quote signer domain does not match the configured splitter deployment");
  }
  return signer;
}

// The one signing site. It runs inside the caller's issuance transaction and
// verifies its own output before that transaction is allowed to commit.
async function signIssuedQuote(signer, message) {
  const domain = createQuoteDomain(signer.domain);
  const signature = await signer.signQuote(message);
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("quote signer returned an invalid signature");
  }
  if (!verifyQuoteSignature(createQuoteTypedData(message, domain), signature, signer.address)) {
    throw new Error("quote signature does not verify against the configured signer address");
  }
  return { domain, message, signature };
}

function issuedQuotePayload({ domain, message, signature } = {}) {
  return Object.freeze({
    domain: createQuoteDomain(domain),
    message,
    totalAmount: quoteTotalAmount(message),
    signature,
  });
}

// Caller-supplied issuance time or signature material is rejected outright:
// accepting either would reintroduce a second, unauthoritative signing site.
function assertStoreOwnedQuoteMaterial(quote, reservation) {
  for (const [value, field, owner] of [
    [quote?.expiresAt, "quote.expiresAt", "issuance time"],
    [quote?.signature, "quote.signature", "signing"],
    [quote?.message, "quote.message", "signing"],
    [reservation?.expiresAt, "reservation.expiresAt", "issuance time"],
  ]) {
    if (value !== undefined) {
      throw new TypeError(`${field} is not accepted: the store owns ${owner}`);
    }
  }
}

module.exports = {
  QUOTE_LIFETIME_MS,
  assertSignerDeploymentBinding,
  assertStoreOwnedQuoteMaterial,
  buildIssuedQuoteMessage,
  issuanceInstant,
  issuedQuotePayload,
  quoteExpiryFrom,
  signIssuedQuote,
};
