"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertPayableQuote, confirmationSummary, isQuotePayable, parseIssuedQuote,
} = require("../src/quote");
const { formatUsdc } = require("../src/format");
const { BASE_MAINNET, SPLITTER, TOKEN, VOTER, issuedQuote } = require("./helpers");

const NOW = 1_800_000_000;

test("a Gate-issued quote parses into exactly the server's payment values", () => {
  const quote = parseIssuedQuote(issuedQuote());

  assert.equal(quote.message.attentionAmount, "1000000");
  assert.equal(quote.message.gavelFeeAmount, "250000");
  assert.equal(quote.totalAmount, "1250000");
  assert.equal(quote.chainId, BASE_MAINNET);
  assert.equal(quote.splitter, SPLITTER);
  assert.equal(quote.token, TOKEN);
  assert.equal(quote.message.voter, VOTER);
  assert.ok(Object.isFrozen(quote.message));
});

test("splitter, token, chain, and expiry are read from the quote, never configured", () => {
  const custom = issuedQuote({
    domain: { chainId: 8453, verifyingContract: `0x${"5".repeat(40)}` },
    message: { token: `0x${"6".repeat(40)}`, expiry: "1900000000" },
  });
  const quote = parseIssuedQuote(custom);
  assert.equal(quote.splitter.toLowerCase(), `0x${"5".repeat(40)}`);
  assert.equal(quote.token.toLowerCase(), `0x${"6".repeat(40)}`);
  assert.equal(quote.message.expiry, "1900000000");
});

test("a quote carrying anything but the fixed Gavel fee is refused", () => {
  assert.throws(
    () => parseIssuedQuote(issuedQuote({ message: { gavelFeeAmount: "500000" }, totalAmount: "1500000" })),
    (error) => ["INVALID_QUOTE"].includes(error.code),
  );
});

test("a quote whose total does not equal attention plus fee is refused", () => {
  assert.throws(
    () => parseIssuedQuote(issuedQuote({ totalAmount: "9999999" })),
    (error) => error.code === "INVALID_QUOTE",
  );
});

test("an unsupported quote version is refused", () => {
  assert.throws(
    () => parseIssuedQuote(issuedQuote({ message: { quoteVersion: "2" } })),
    (error) => error.code === "UNSUPPORTED_QUOTE_VERSION",
  );
});

test("an unsigned or unknown-shaped quote is refused", () => {
  assert.throws(() => parseIssuedQuote(issuedQuote({ signature: "0xdead" })), (error) => error.code === "INVALID_QUOTE");
  const extra = issuedQuote();
  extra.message.surprise = "1";
  assert.throws(() => parseIssuedQuote(extra), (error) => error.code === "INVALID_QUOTE");
});

test("an expired quote is refused before anything is signed", () => {
  const quote = parseIssuedQuote(issuedQuote({ message: { expiry: String(NOW - 1) } }));
  assert.equal(isQuotePayable(quote, NOW), false);
  assert.throws(() => assertPayableQuote(quote, NOW), (error) => error.code === "QUOTE_EXPIRED");
});

test("a quote for any chain other than Base mainnet is refused", () => {
  // A quote still pointed at the testnet must be refused by name, not paid
  // with real USDC by accident and not formatted as though it were fine.
  const sepolia = parseIssuedQuote(issuedQuote({ domain: { chainId: 84532 } }));
  assert.throws(
    () => assertPayableQuote(sepolia, NOW),
    (error) => error.code === "CHAIN_NOT_ALLOWED" && /Base Sepolia/.test(error.message),
  );
  const ethereum = parseIssuedQuote(issuedQuote({ domain: { chainId: 1 } }));
  assert.throws(
    () => assertPayableQuote(ethereum, NOW),
    (error) => error.code === "CHAIN_NOT_ALLOWED",
  );
  assert.equal(isQuotePayable(parseIssuedQuote(issuedQuote()), NOW), true);
});

test("the confirmation reads exactly the required copy", () => {
  const quote = parseIssuedQuote(issuedQuote());
  const summary = confirmationSummary({
    quote,
    target: { title: "Fund the Nouns builder grant", stage: "PRE_VOTE", position: "SPONSOR",
      language: { attentionNoun: "sponsorship attention" } },
    voter: { label: "voter.eth", wallet: VOTER },
  });

  assert.equal(summary.lines[0], "Send “Fund the Nouns builder grant” to voter.eth for sponsorship attention");
  assert.equal(summary.lines[1], "");
  assert.equal(summary.lines[2], "Attention: 1.00 USDC");
  assert.equal(summary.lines[3], "Gavel fee: 0.25 USDC");
  assert.equal(summary.lines[4], "Total: 1.25 USDC");
  assert.equal(summary.chain, "Base");
});

test("confirmation amounts come from the quote, never from conversation", () => {
  const quote = parseIssuedQuote(issuedQuote({ message: { attentionAmount: "7500000" }, totalAmount: "7750000" }));
  const summary = confirmationSummary({
    quote,
    target: { title: "Anything the advocate typed: 99.00 USDC", stage: "PRE_VOTE", language: {} },
    voter: { label: "voter.eth" },
  });
  assert.equal(summary.lines[2], "Attention: 7.50 USDC");
  assert.equal(summary.lines[4], "Total: 7.75 USDC");
  assert.equal(summary.totalAmount, "7750000");
});

test("USDC formatting is exact fixed-point, never floating point", () => {
  assert.equal(formatUsdc("1000000"), "1.00");
  assert.equal(formatUsdc("250000"), "0.25");
  assert.equal(formatUsdc("1250000"), "1.25");
  assert.equal(formatUsdc("1"), "0.000001");
  assert.equal(formatUsdc("0"), "0.00");
  assert.equal(formatUsdc("123456789012345678901"), "123456789012345.678901");
});
