/**
 * Deterministic canonical hashing for intents.
 *
 * Requirements this satisfies:
 *
 *   - The same logical intent always produces the same hash, on any host, in
 *     any process, in any field order.
 *   - Different logical intents cannot collide by field concatenation. Each
 *     hash is domain-separated by a leading constant and the material is
 *     JSON-encoded, so a `reason` containing a separator cannot forge another
 *     field's value.
 *   - Nothing generated at or after submission is hashed. No Safe nonce, no
 *     safeTxHash, no provider request id, no submission timestamp. Those live
 *     on the ExecutionRecord instead, so one intent hash can front several
 *     execution attempts.
 */

const { createHash } = require("node:crypto");

function sha256Hex(material) {
  return `0x${createHash("sha256").update(material).digest("hex")}`;
}

/**
 * Hash an ordered field list under a domain tag.
 *
 * The domain tag is part of the hashed bytes, so a VoteIntent and an
 * ExecutionIntent that happened to serialize identically would still hash
 * differently.
 */
function domainHash(domain, fields) {
  if (typeof domain !== "string" || !domain) throw new TypeError("A hash domain is required");
  if (!Array.isArray(fields)) throw new TypeError("Hash material must be an ordered array");
  return sha256Hex(JSON.stringify([domain, ...fields]));
}

function normalizeChainId(value) {
  const chainId = Number(value);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new TypeError("chainId must be a positive integer");
  return chainId;
}

/** Accepts bigint, number, or decimal string; emits an unsigned decimal string. */
function normalizeUint(value, label) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${label} must be an unsigned integer`);
  }
  if (parsed < 0n) throw new TypeError(`${label} must be an unsigned integer`);
  return parsed.toString();
}

function normalizeHex(value, label) {
  const text = String(value ?? "").toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(text)) throw new TypeError(`${label} must be 0x-prefixed even-length hex`);
  return text;
}

/** Empty calldata has no selector; a governance call always does. */
function selectorOf(calldata) {
  const data = normalizeHex(calldata, "calldata");
  if (data.length < 10) return null;
  return data.slice(0, 10);
}

/** A nullable, trimmed string. Empty and whitespace-only collapse to null so
 * that `reason: ""` and `reason: null` are the same logical intent. */
function normalizeReason(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

module.exports = {
  deepFreeze,
  domainHash,
  normalizeChainId,
  normalizeHex,
  normalizeReason,
  normalizeTimestamp,
  normalizeUint,
  selectorOf,
  sha256Hex,
};
