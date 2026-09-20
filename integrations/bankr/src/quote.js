"use strict";

const { getAddress } = require("ethers");
const {
  GAVEL_FEE_AMOUNT,
  QUOTE_FIELD_NAMES,
  QUOTE_VERSION,
  createQuoteTypedData,
  quoteTotalAmount,
} = require("@gavel/gate");
const { BankrGateError } = require("./errors");
const { DEFAULT_ALLOWED_CHAIN_IDS, chainLabel, formatUsdcWithUnit, truncateDisplay } = require("./format");

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

function invalidQuote(message) {
  return new BankrGateError("INVALID_QUOTE", message);
}

/**
 * Parses the quote Gate signed and persisted.
 *
 * Every payment value lives here and only here. Conversational text — a pitch,
 * a "make it 5 USDC", a title, anything an advocate or a linked page says —
 * can never reach a signed field: this function reads only the server payload,
 * refuses an unknown field, and returns a frozen copy.
 */
function parseIssuedQuote(quote) {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) throw invalidQuote("Gate returned no quote.");
  const { domain, message, signature, totalAmount } = quote;
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) {
    throw invalidQuote("Gate returned a quote without a usable signature.");
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw invalidQuote("Gate returned a quote without a message.");
  }
  const names = Object.keys(message);
  if (names.length !== QUOTE_FIELD_NAMES.length || QUOTE_FIELD_NAMES.some((field) => !names.includes(field))) {
    throw invalidQuote("Gate returned a quote whose fields this client does not recognize.");
  }
  let typed;
  try {
    // Rebuilding the typed data proves domain and message are well formed
    // without altering a single value.
    typed = createQuoteTypedData(message, { chainId: domain?.chainId, verifyingContract: domain?.verifyingContract });
  } catch (cause) {
    throw new BankrGateError("INVALID_QUOTE", "Gate returned a quote this client cannot read.", { cause });
  }
  if (String(message.quoteVersion) !== String(QUOTE_VERSION)) {
    throw new BankrGateError(
      "UNSUPPORTED_QUOTE_VERSION",
      "This quote uses a version this integration cannot pay. Ask Gate for a new quote.",
    );
  }
  if (BigInt(message.gavelFeeAmount) !== GAVEL_FEE_AMOUNT) {
    throw invalidQuote("This quote does not carry the fixed Gavel fee.");
  }
  const computedTotal = quoteTotalAmount(message);
  if (totalAmount !== undefined && String(totalAmount) !== computedTotal) {
    throw invalidQuote("This quote's total does not equal its attention amount plus the Gavel fee.");
  }
  return Object.freeze({
    domain: Object.freeze({ ...typed.domain }),
    message: Object.freeze({ ...typed.message }),
    signature,
    totalAmount: computedTotal,
    /** The splitter is the quote domain's verifying contract. Never configured. */
    splitter: getAddress(typed.domain.verifyingContract),
    token: getAddress(typed.message.token),
    chainId: Number(typed.domain.chainId),
  });
}

/**
 * Refuses a quote this integration must not sign for.
 *
 * Expiry is checked before anything touches the wallet, so an expired quote
 * costs zero wallet interactions. The chain allow-list is what keeps this flow
 * on Base mainnet: a quote for any other chain — Base Sepolia included — is
 * refused rather than paid.
 */
function assertPayableQuote(quote, nowSeconds, { allowedChainIds = DEFAULT_ALLOWED_CHAIN_IDS } = {}) {
  const allowed = [...allowedChainIds].map(Number);
  if (!allowed.includes(Number(quote.chainId))) {
    throw new BankrGateError(
      "CHAIN_NOT_ALLOWED",
      `This quote is for ${chainLabel(quote.chainId).name}. This integration only pays on ${
        allowed.map((id) => chainLabel(id).name).join(", ")}.`,
    );
  }
  let expiry;
  let now;
  try {
    expiry = BigInt(quote.message.expiry);
    now = BigInt(Math.floor(Number(nowSeconds)));
  } catch {
    throw invalidQuote("This quote has an unreadable expiry and cannot be paid.");
  }
  if (expiry <= now) {
    throw new BankrGateError(
      "QUOTE_EXPIRED",
      "This quote expired before it was paid. Nothing was signed and nothing was charged.",
    );
  }
  return quote;
}

function isQuotePayable(quote, nowSeconds, options) {
  try {
    assertPayableQuote(quote, nowSeconds, options);
    return true;
  } catch {
    return false;
  }
}

function secondsUntilExpiry(quote, nowSeconds) {
  return Number(BigInt(quote.message.expiry) - BigInt(Math.floor(Number(nowSeconds))));
}

/**
 * The confirmation an advocate must explicitly approve before ANY signing.
 *
 * `lines` is the exact copy shown. Amounts are read from the quote, never from
 * the directory listing, never from conversation.
 */
function confirmationSummary({ quote, target, voter }) {
  const chainId = quote.chainId;
  const attention = formatUsdcWithUnit(quote.message.attentionAmount, chainId);
  const fee = formatUsdcWithUnit(quote.message.gavelFeeAmount, chainId);
  const total = formatUsdcWithUnit(quote.totalAmount, chainId);
  const voterName = voter?.label || voter?.ens || voter?.wallet || quote.message.voter;
  const title = truncateDisplay(target?.title ?? "");
  const attentionNoun = target?.language?.attentionNoun
    || (target?.stage === "PRE_VOTE" ? "sponsorship attention" : "voting attention");
  const headline = `Send “${title}” to ${voterName} for ${attentionNoun}`;
  return Object.freeze({
    headline,
    lines: Object.freeze([
      headline,
      "",
      `Attention: ${attention}`,
      `Gavel fee: ${fee}`,
      `Total: ${total}`,
    ]),
    text: [headline, "", `Attention: ${attention}`, `Gavel fee: ${fee}`, `Total: ${total}`].join("\n"),
    stage: target?.stage ?? null,
    position: target?.position ?? null,
    chain: chainLabel(chainId).name,
    attentionAmount: quote.message.attentionAmount,
    gavelFeeAmount: quote.message.gavelFeeAmount,
    totalAmount: quote.totalAmount,
    voterWallet: quote.message.voter,
    payerWallet: quote.message.payer,
    expiry: quote.message.expiry,
  });
}

module.exports = {
  assertPayableQuote,
  confirmationSummary,
  isQuotePayable,
  parseIssuedQuote,
  secondsUntilExpiry,
};
