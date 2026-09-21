// Canonical block header logsBloom membership test (Yellow Paper M3:2048).
//
// A block header's logsBloom is the union of its receipt blooms, and every log
// contributes its address and each of its topics. The filter has FALSE POSITIVES
// but NEVER false negatives, so a negative answer is a proof that no log with the
// queried address/topic exists in that block. The scanner relies on exactly that
// direction: bloom-negative blocks are proven to hold no QuoteSettled log without
// reading a single receipt, and every bloom-positive block still goes through the
// full canonical receipt enumeration.
//
// The bit derivation is deliberately written as big-integer arithmetic over the
// big-endian 256-byte filter (the web3.py formulation). The test fixture builds
// blooms with the byte-index/mask formulation (go-ethereum's bloom9), so the two
// independently derived mappings cross-check each other.
const { keccak256, getBytes } = require("ethers");

const BLOOM_HEX = /^0x[0-9a-fA-F]{512}$/;
const ITEM_HEX = /^0x([0-9a-fA-F]{2})+$/;

function bloomBits(item) {
  const digest = getBytes(keccak256(item));
  return [0, 2, 4].map((offset) => (((digest[offset] << 8) | digest[offset + 1]) & 0x7ff));
}

function isLogsBloom(value) { return typeof value === "string" && BLOOM_HEX.test(value); }

/**
 * @param {string} bloom 0x-prefixed 256-byte header logsBloom.
 * @param {string} item 0x-prefixed address (20 bytes) or topic (32 bytes).
 * @returns {boolean} false proves the item is absent; true means "may be present".
 */
function logsBloomMayContain(bloom, item) {
  if (!isLogsBloom(bloom)) throw new TypeError("logsBloom must be 256 bytes");
  if (typeof item !== "string" || !ITEM_HEX.test(item)) throw new TypeError("bloom item must be non-empty bytes");
  const filter = BigInt(bloom);
  return bloomBits(item).every((bit) => ((filter >> BigInt(bit)) & 1n) === 1n);
}

/** True when the header may contain a log emitted by `address` carrying `topic` as topic0. */
function logsBloomMayContainEvent(bloom, address, topic) {
  return logsBloomMayContain(bloom, address) && logsBloomMayContain(bloom, topic);
}

/**
 * Pre-derive the bit positions for a fixed set of items (a splitter address and an event
 * topic never change across a scan), so a 5,000-block range costs two keccak hashes rather
 * than two per block.
 *
 * @param {string[]} items 0x-prefixed bloom items, all of which must be present to match.
 * @returns {(bloom: string) => boolean}
 */
function createLogsBloomMatcher(items) {
  const bits = items.flatMap((item) => {
    if (typeof item !== "string" || !ITEM_HEX.test(item)) throw new TypeError("bloom item must be non-empty bytes");
    return bloomBits(item);
  }).map(BigInt);
  return function mayContain(bloom) {
    if (!isLogsBloom(bloom)) throw new TypeError("logsBloom must be 256 bytes");
    const filter = BigInt(bloom);
    return bits.every((bit) => ((filter >> bit) & 1n) === 1n);
  };
}

module.exports = { bloomBits, isLogsBloom, logsBloomMayContain, logsBloomMayContainEvent, createLogsBloomMatcher };
