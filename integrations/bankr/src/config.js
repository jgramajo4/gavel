"use strict";

const { BankrGateError } = require("./errors");
const { DEFAULT_ALLOWED_CHAIN_IDS } = require("./format");

const DEFAULT_INDEX_URL = "https://index.0773h.com";

/**
 * Rejects an endpoint that carries credentials or a path.
 *
 * Mirrors `scripts/gate-smoke.js`: an origin with a username, password, query,
 * or fragment is a configuration mistake that would put a secret into a request
 * line, so it fails closed rather than being normalized away.
 */
function canonicalOrigin(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new BankrGateError("INVALID_CONFIG", `${name} is required.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BankrGateError("INVALID_CONFIG", `${name} must be an HTTP(S) origin.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new BankrGateError(
      "INVALID_CONFIG",
      `${name} must be an HTTP(S) origin with no credentials, path, query, or fragment.`,
    );
  }
  return parsed.origin;
}

function chainIds(value) {
  if (value === undefined || value === null || value === "") return [...DEFAULT_ALLOWED_CHAIN_IDS];
  const list = (Array.isArray(value) ? value : String(value).split(","))
    .map((entry) => Number(String(entry).trim()))
    .filter((entry) => Number.isSafeInteger(entry) && entry > 0);
  if (list.length === 0) {
    throw new BankrGateError("INVALID_CONFIG", "GAVEL_GATE_CHAIN_IDS must list at least one chain ID.");
  }
  return list;
}

/**
 * Resolves Bankr-side configuration.
 *
 * Deliberately absent: splitter address, token address, quote signer, fee, and
 * price. Every one of those is served by Gate inside the signed quote, and this
 * integration never carries a second copy that could drift from it.
 */
function resolveConfig(env = process.env, overrides = {}) {
  const gateUrl = canonicalOrigin(overrides.gateUrl ?? env.GAVEL_GATE_URL, "GAVEL_GATE_URL");
  const indexUrl = canonicalOrigin(
    overrides.indexUrl ?? env.GAVEL_INDEX_API_URL ?? DEFAULT_INDEX_URL,
    "GAVEL_INDEX_API_URL",
  );
  return Object.freeze({
    gateUrl,
    indexUrl,
    dao: "nouns",
    allowedChainIds: Object.freeze(chainIds(overrides.allowedChainIds ?? env.GAVEL_GATE_CHAIN_IDS)),
    requestTimeoutMs: Number(overrides.requestTimeoutMs ?? env.GAVEL_GATE_TIMEOUT_MS ?? 10_000),
  });
}

module.exports = { DEFAULT_INDEX_URL, canonicalOrigin, resolveConfig };
