"use strict";

const { BankrGateError } = require("./errors");

const USDC_DECIMALS = 6;

// Base Sepolia is the only chain this integration is built for. Base mainnet is
// listed so an accidental mainnet quote is NAMED in the refusal rather than
// silently formatted as if it were fine.
const CHAIN_LABELS = Object.freeze({
  84532: { name: "Base Sepolia", token: "test USDC" },
  8453: { name: "Base", token: "USDC" },
});

const DEFAULT_ALLOWED_CHAIN_IDS = Object.freeze([84532]);

function chainLabel(chainId) {
  return CHAIN_LABELS[Number(chainId)] || { name: `chain ${String(chainId)}`, token: "USDC" };
}

/** Exact fixed-point formatting. No rounding, no floats, no locale guessing. */
function formatUsdc(atomic) {
  let value;
  try {
    value = BigInt(atomic);
  } catch {
    throw new BankrGateError("INVALID_AMOUNT", "An amount in this quote is unreadable.");
  }
  if (value < 0n) throw new BankrGateError("INVALID_AMOUNT", "An amount in this quote is negative.");
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = value / unit;
  const fraction = (value % unit).toString(10).padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  // Two decimal places minimum, so "1.00" never renders as "1".
  const shown = fraction.length >= 2 ? fraction : fraction.padEnd(2, "0");
  return `${whole.toString(10)}.${shown}`;
}

function formatUsdcWithUnit(atomic, chainId) {
  return `${formatUsdc(atomic)} ${chainLabel(chainId).token}`;
}

function shortWallet(wallet) {
  const value = String(wallet ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * A voter's display label.
 *
 * `ens` is a server-supplied display string, not a name this client resolved,
 * so it is stripped of control characters before it reaches a terminal.
 */
function voterLabel(profile) {
  const ens = typeof profile?.ens === "string" ? sanitizeDisplayText(profile.ens).trim() : "";
  const wallet = shortWallet(profile?.wallet);
  return ens ? `${ens} (${wallet})` : wallet;
}

/**
 * Strips C0/C1 control characters from untrusted display text.
 *
 * This is presentation hygiene for a terminal, not sanitization of meaning:
 * candidate titles, pitches, disclosures, and evidence URLs stay verbatim data
 * everywhere they are stored, hashed, or sent to Gate.
 */
function sanitizeDisplayText(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function truncateDisplay(value, maximum = 120) {
  const text = sanitizeDisplayText(value).trim();
  const points = Array.from(text);
  return points.length <= maximum ? text : `${points.slice(0, maximum - 1).join("")}…`;
}

module.exports = {
  CHAIN_LABELS,
  DEFAULT_ALLOWED_CHAIN_IDS,
  USDC_DECIMALS,
  chainLabel,
  formatUsdc,
  formatUsdcWithUnit,
  sanitizeDisplayText,
  shortWallet,
  truncateDisplay,
  voterLabel,
};
