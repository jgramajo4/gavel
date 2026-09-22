"use strict";

const { BankrGateError } = require("./errors");
const { DEFAULT_ALLOWED_CHAIN_IDS } = require("./format");

const DEFAULT_INDEX_URL = "https://index.0773h.com";

// Hostnames that can never be a production Gate relay. A relay origin carries
// the Gate session token and receives a payment authorization, so a typo that
// points it at a laptop, a LAN box, or a reserved documentation name is a
// configuration failure, not a fallback.
const RESERVED_RELAY_SUFFIXES = Object.freeze([
  ".local", ".localhost", ".test", ".invalid", ".example", ".internal", ".home.arpa", ".onion",
]);
const RESERVED_RELAY_HOSTS = Object.freeze([
  "localhost", "example.com", "example.net", "example.org",
]);

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

/**
 * Rejects a relay origin that is not a production HTTPS endpoint.
 *
 * Beyond the shared origin rules, a relay must be an HTTPS DNS name. An IP
 * literal is refused outright, which is what closes loopback and every RFC 1918
 * LAN range at once, and the reserved test/documentation names above are
 * refused by suffix. There is no permissive mode: a relay that cannot be
 * reached over TLS is simply not configured.
 */
function canonicalRelayOrigin(value, name) {
  const origin = canonicalOrigin(value, name);
  const parsed = new URL(origin);
  const { protocol } = parsed;
  if (protocol !== "https:") {
    throw new BankrGateError("INVALID_CONFIG", `${name} must be an HTTPS origin.`);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  // An IPv6 literal arrives bracketed; an IPv4 literal is four dotted numbers.
  const isIpLiteral = host.startsWith("[") || /^[0-9]+(\.[0-9]+){3}$/.test(host);
  if (isIpLiteral || !host.includes(".") || RESERVED_RELAY_HOSTS.includes(host)
      || RESERVED_RELAY_SUFFIXES.some((suffix) => host.endsWith(suffix))
      || RESERVED_RELAY_HOSTS.some((reserved) => host.endsWith(`.${reserved}`))) {
    throw new BankrGateError(
      "INVALID_CONFIG",
      `${name} must be a public HTTPS hostname, not an IP address, a loopback, a LAN, or a reserved test name.`,
    );
  }
  parsed.hostname = host;
  return parsed.origin;
}

function chainIds(value) {
  const list = (value === undefined || value === null || value === "")
    ? [...DEFAULT_ALLOWED_CHAIN_IDS]
    : (Array.isArray(value) ? value : String(value).split(","))
      .map((entry) => Number(String(entry).trim()))
      .filter((entry) => Number.isSafeInteger(entry) && entry > 0);
  if (list.length !== 1 || list[0] !== 8453) {
    throw new BankrGateError(
      "INVALID_CONFIG",
      "GAVEL_GATE_CHAIN_IDS must contain exactly 8453 (Base mainnet).",
    );
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
  const gateUrl = canonicalRelayOrigin(overrides.gateUrl ?? env.GAVEL_GATE_URL, "GAVEL_GATE_URL");
  const indexUrl = canonicalOrigin(
    overrides.indexUrl ?? env.GAVEL_INDEX_API_URL ?? DEFAULT_INDEX_URL,
    "GAVEL_INDEX_API_URL",
  );
  // Opt-in. Absent, the client has no remote relay and says so by name rather
  // than falling back to broadcasting from Bankr.
  const relayerSource = overrides.relayerUrl ?? env.GAVEL_GATE_RELAYER_URL;
  const relayerUrl = relayerSource === undefined || relayerSource === null || relayerSource === ""
    ? null
    : canonicalRelayOrigin(relayerSource, "GAVEL_GATE_RELAYER_URL");
  return Object.freeze({
    gateUrl,
    indexUrl,
    relayerUrl,
    dao: "nouns",
    allowedChainIds: Object.freeze(chainIds(overrides.allowedChainIds ?? env.GAVEL_GATE_CHAIN_IDS)),
    requestTimeoutMs: Number(overrides.requestTimeoutMs ?? env.GAVEL_GATE_TIMEOUT_MS ?? 10_000),
  });
}

module.exports = {
  DEFAULT_INDEX_URL,
  RESERVED_RELAY_HOSTS,
  RESERVED_RELAY_SUFFIXES,
  canonicalOrigin,
  canonicalRelayOrigin,
  resolveConfig,
};
