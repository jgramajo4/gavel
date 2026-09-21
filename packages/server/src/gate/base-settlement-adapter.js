const { AsyncLocalStorage } = require("node:async_hooks");
const { createHash } = require("node:crypto");
const {
  DEFAULT_CONFIRMATION_DEPTH,
  DEFAULT_SCANNER_OVERLAP,
  QUOTE_SETTLED_TOPIC,
  decodeQuoteSettledLog,
  safeHead,
} = require("@gavel/gate");

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_MAX_BLOCK_RANGE = 5_000;
// Concurrent in-flight RPCs. The scanner performs exactly the same logical reads it always has;
// this only controls how many of them are outstanding at once, which is what lets the provider
// transport (ethers' JsonRpcProvider) coalesce them into JSON-RPC batches.
const DEFAULT_SCAN_CONCURRENCY = 64;
const MAX_SCAN_CONCURRENCY = 256;

function positive(value, name, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer`);
  return result;
}
// Raw JSON-RPC results encode numbers as QUANTITY hex; ethers-shaped results use numbers.
function quantity(value, name) {
  let result;
  if (typeof value === "bigint") result = value;
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} is invalid`);
    result = BigInt(value);
  } else if (typeof value === "string" && (/^0x[0-9a-fA-F]+$/.test(value) || /^[0-9]+$/.test(value))) {
    result = BigInt(value);
  } else throw new TypeError(`${name} is invalid`);
  if (result < 0n) throw new TypeError(`${name} is invalid`);
  return result;
}
function timestamp(value) {
  const date = value instanceof Date ? new Date(value) : new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("block timestamp is invalid");
  return date;
}
function hash(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) throw new TypeError(`${name} must be bytes32`);
  return value.toLowerCase();
}
function address(value, name) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new TypeError(`${name} must be an address`);
  return value.toLowerCase();
}
function logIndex(log) {
  const result = Number(log.index ?? log.logIndex);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError("log index is invalid");
  return result;
}
function receiptSucceeded(receipt) { return receipt?.status === 1 || receipt?.status === "0x1" || receipt?.status === 1n; }
function receiptFailed(receipt) { return receipt?.status === 0 || receipt?.status === "0x0" || receipt?.status === 0n; }
function completeReceiptLog(log) {
  try {
    hash(log.transactionHash, "transaction hash");
    hash(log.blockHash, "block hash");
    address(log.address, "log address");
    logIndex(log);
    if (!Number.isSafeInteger(Number(log.blockNumber)) || Number(log.blockNumber) < 0
        || typeof log.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(log.data)
        || !Array.isArray(log.topics) || log.topics.some((topic) => !HASH.test(topic))) return false;
    return true;
  } catch { return false; }
}
class InvalidSettlementEvidence extends Error {}
function sameLog(left, right) {
  try {
    return hash(left.transactionHash, "transaction hash") === hash(right.transactionHash, "transaction hash")
      && logIndex(left) === logIndex(right)
      && Number(left.blockNumber) === Number(right.blockNumber)
      && hash(left.blockHash, "block hash") === hash(right.blockHash, "block hash")
      && address(left.address, "log address") === address(right.address, "log address")
      && left.data === right.data
      && JSON.stringify(left.topics) === JSON.stringify(right.topics);
  } catch { return false; }
}
// Digest of the canonical sorted transaction-hash set. Comparing digests is equivalent to the
// sequential scanner's JSON.stringify comparison of the same sorted arrays.
function transactionSetDigest(hashes) {
  return createHash("sha256").update(JSON.stringify([...hashes].sort())).digest("hex");
}
// Receipt logs arrive as raw JSON-RPC QUANTITY hex. Observations are persisted as numeric(78,0),
// so a block number must be normalized to decimal before it leaves the adapter.
function anomalyBlock(log, fallback) {
  try { return quantity(log?.blockNumber, "log block number").toString(); }
  catch { return BigInt(fallback).toString(); }
}

/**
 * Run `worker` over `items` with at most `limit` outstanding at a time.
 *
 * Results are stored by request index, never by completion order, so a provider that answers out
 * of order cannot mis-associate a response with a request. On failure the scan reports the
 * failure belonging to the LOWEST index, which keeps the surfaced error deterministic and equal
 * to the error the previous sequential scanner would have raised first.
 */
async function mapBounded(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  let failureIndex = Infinity;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      // Stop claiming new work once something earlier has already failed.
      if (index >= items.length || index > failureIndex) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) {
        if (index < failureIndex) { failure = error; failureIndex = index; }
        return;
      }
    }
  }));
  if (failureIndex !== Infinity) throw failure;
  return results;
}

function settlementConfigFromEnv(env = process.env) {
  const confirmationDepth = positive(env.GAVEL_GATE_CONFIRMATION_DEPTH, "GAVEL_GATE_CONFIRMATION_DEPTH", DEFAULT_CONFIRMATION_DEPTH);
  if (confirmationDepth !== 1) throw new TypeError("GAVEL_GATE_CONFIRMATION_DEPTH must be exactly 1 for the MVP");
  const scanConcurrency = positive(env.GAVEL_GATE_SETTLEMENT_SCAN_CONCURRENCY,
    "GAVEL_GATE_SETTLEMENT_SCAN_CONCURRENCY", DEFAULT_SCAN_CONCURRENCY);
  if (scanConcurrency > MAX_SCAN_CONCURRENCY) {
    throw new TypeError(`GAVEL_GATE_SETTLEMENT_SCAN_CONCURRENCY must not exceed ${MAX_SCAN_CONCURRENCY}`);
  }
  return Object.freeze({
    confirmationDepth,
    overlap: positive(env.GAVEL_GATE_REORG_OVERLAP_BLOCKS, "GAVEL_GATE_REORG_OVERLAP_BLOCKS", DEFAULT_SCANNER_OVERLAP),
    maxBlockRange: positive(env.GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE,
      "GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE", DEFAULT_MAX_BLOCK_RANGE),
    scanConcurrency,
  });
}

function createBaseSettlementAdapter({ client, chainId, splitter, confirmationDepth = DEFAULT_CONFIRMATION_DEPTH,
  overlap = DEFAULT_SCANNER_OVERLAP, maxBlockRange = DEFAULT_MAX_BLOCK_RANGE,
  scanConcurrency = DEFAULT_SCAN_CONCURRENCY, rpcTimeoutMs = 10_000,
  clock = () => new Date() } = {}) {
  for (const method of ["getChainId", "getBlockNumber", "getBlockHeader", "getBlockTransactionCount",
    "getBlockReceipts", "getTransactionReceipt", "getTransaction"]) {
    if (!client || typeof client[method] !== "function") throw new TypeError(`client.${method} is required`);
  }
  const configuredChain = BigInt(chainId).toString();
  if (BigInt(configuredChain) < 1n) throw new TypeError("chainId must be positive");
  const configuredSplitter = address(splitter, "splitter");
  const configuredTopic = QUOTE_SETTLED_TOPIC.toLowerCase();
  const depth = positive(confirmationDepth, "confirmationDepth", DEFAULT_CONFIRMATION_DEPTH);
  if (depth !== 1) throw new TypeError("confirmationDepth must be exactly 1 for the MVP");
  const trailing = positive(overlap, "overlap", DEFAULT_SCANNER_OVERLAP);
  const rangeLimit = positive(maxBlockRange, "maxBlockRange", DEFAULT_MAX_BLOCK_RANGE);
  const lanes = positive(scanConcurrency, "scanConcurrency", DEFAULT_SCAN_CONCURRENCY);
  if (lanes > MAX_SCAN_CONCURRENCY) throw new TypeError(`scanConcurrency must not exceed ${MAX_SCAN_CONCURRENCY}`);
  const rpcLimit = positive(rpcTimeoutMs, "rpcTimeoutMs", 10_000);
  if (rpcLimit > 60_000) throw new TypeError("rpcTimeoutMs must not exceed 60000");
  if (rangeLimit <= trailing) throw new TypeError("maxBlockRange must be greater than overlap");

  // Logical JSON-RPC method counter. Held in async-local storage rather than a closure variable,
  // because reconcileSubmitted and monitorOnce run on their own timers against this same adapter
  // and would otherwise have their calls attributed to an in-flight scan.
  const meters = new AsyncLocalStorage();
  function measure(name) {
    const meter = meters.getStore();
    if (meter) meter[name] = (meter[name] || 0) + 1;
  }

  async function rpcCall(name, operation) {
    measure(name);
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Base RPC ${name} timed out`)), rpcLimit); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function assertChain() {
    const actual = BigInt(await rpcCall("getChainId", () => client.getChainId())).toString();
    if (actual !== configuredChain) throw new Error(`RPC chain ${actual} does not match configured chain ${configuredChain}`);
  }

  async function getCanonicalHead() { await assertChain(); return BigInt(await rpcCall("getBlockNumber", () => client.getBlockNumber())); }
  async function getSafeHead() { return safeHead(await getCanonicalHead(), depth); }

  /**
   * One eth_getBlockByNumber(number, false) per canonical block — the same logical read the
   * scanner has always performed, issued as a raw JSON-RPC send rather than through
   * provider.getBlock().
   *
   * That difference is load-bearing, not cosmetic. AbstractProvider routes getBlock() through a
   * 250 ms request cache (#perform / cacheTimeout), so once a scan completes quickly the
   * end-of-scan boundary re-read would be answered from that cache and the "canonical boundary
   * changed during scan" check would silently stop detecting anything. A raw send bypasses the
   * cache while still going through the batching queue.
   */
  async function canonicalBlock(number, includeTransactions = false) {
    const header = await rpcCall("getBlockHeader", () => client.getBlockHeader(Number(number)));
    // A missing, mismatched or unparseable block number is all one condition, reported with the
    // same message the sequential scanner used, rather than leaking a validator TypeError.
    let reported;
    try { reported = header ? quantity(header.number, "canonical block number") : undefined; } catch { reported = undefined; }
    if (reported !== BigInt(number)) throw new Error("canonical block unavailable");
    let transactionSet;
    if (includeTransactions) {
      if (!Array.isArray(header.transactions)) throw new Error("canonical block transaction set is incomplete");
      let transactionHashes;
      try {
        transactionHashes = header.transactions.map((transaction) => hash(
          typeof transaction === "string" ? transaction : transaction?.hash, "block transaction hash"));
      } catch { throw new Error("canonical block transaction set is incomplete"); }
      if (new Set(transactionHashes).size !== transactionHashes.length) {
        throw new Error("canonical block transaction set is incomplete");
      }
      // The receipt cross-check only ever compares this set against the receipts' set. Retaining
      // a digest of the canonical sorted form instead of the array makes the comparison identical
      // while cutting per-block retention from kilobytes to ~70 bytes, which matters because the
      // whole range is held at once to prove contiguous coverage.
      transactionSet = { count: transactionHashes.length, digest: transactionSetDigest(transactionHashes) };
    }
    return { blockNumber: BigInt(number).toString(), blockHash: hash(header.hash, "block hash"),
      parentHash: hash(header.parentHash, "block parent hash"),
      blockTimestamp: timestamp(Number(quantity(header.timestamp, "block timestamp"))),
      ...(includeTransactions ? { transactionSet } : {}) };
  }

  // The four fields recordScannerRange validates and persists. Emitting exactly them keeps the
  // stored scanner_result metadata, and therefore generation-replay comparison, independent of
  // anything the adapter carries internally.
  function checkpointShape(block) {
    return { blockNumber: block.blockNumber, blockHash: block.blockHash, parentHash: block.parentHash,
      blockTimestamp: block.blockTimestamp };
  }

  /**
   * Authoritative settlement discovery for one block, unchanged in every check and every
   * ordering from the sequential scanner: the block's receipts are the only source of candidate
   * logs, and each of these checks is an independent fail-closed cross-check against a provider
   * serving a truncated, stale or forked view.
   */
  async function canonicalMatchingLogs(block) {
    if (!block?.transactionSet) throw new Error("canonical block transaction set is incomplete");
    const transactionCount = Number(await rpcCall("getBlockTransactionCount",
      () => client.getBlockTransactionCount(Number(block.blockNumber))));
    if (!Number.isSafeInteger(transactionCount) || transactionCount < 0) {
      throw new Error("block transaction count RPC result is incomplete");
    }
    const receipts = await rpcCall("getBlockReceipts", () => client.getBlockReceipts(Number(block.blockNumber)));
    if (transactionCount !== block.transactionSet.count || !Array.isArray(receipts)
        || receipts.length !== transactionCount) {
      throw new Error("block receipt count RPC result is incomplete");
    }
    const receiptTransactionHashes = [];
    const matches = [];
    for (const receipt of receipts) {
      if (!receipt || (!receiptSucceeded(receipt) && !receiptFailed(receipt)) || !Array.isArray(receipt.logs)
          || receipt.logs.some((entry) => !completeReceiptLog(entry))) {
        throw new Error("block receipts RPC result is incomplete");
      }
      try {
        receiptTransactionHashes.push(hash(receipt.transactionHash, "receipt transaction hash"));
        if (Number(receipt.blockNumber) !== Number(block.blockNumber)
            || hash(receipt.blockHash, "receipt block hash") !== block.blockHash) {
          throw new Error("block receipts RPC result is not canonical");
        }
      } catch (error) {
        if (error.message === "block receipts RPC result is not canonical") throw error;
        throw new Error("block receipts RPC result is incomplete");
      }
      for (const log of receipt.logs) {
        if (hash(log.transactionHash, "log transaction hash") !== receiptTransactionHashes.at(-1)) {
          throw new Error("block receipts RPC result is incomplete");
        }
        if (address(log.address, "log address") === configuredSplitter
            && log.topics[0].toLowerCase() === configuredTopic) {
          matches.push({ log, receipt });
        }
      }
    }
    if (transactionSetDigest(receiptTransactionHashes) !== block.transactionSet.digest) {
      throw new Error("block receipt transaction set RPC result is incomplete");
    }
    return matches;
  }

  async function verify(log, blocks, suppliedReceipt) {
    let event;
    try { event = decodeQuoteSettledLog(log, { splitter: configuredSplitter }); }
    catch { throw new InvalidSettlementEvidence("settlement log is malformed"); }
    const receipt = suppliedReceipt ?? await rpcCall("getTransactionReceipt", () => client.getTransactionReceipt(log.transactionHash));
    if (!receipt || (!receiptSucceeded(receipt) && !receiptFailed(receipt)) || !Array.isArray(receipt.logs)
        || receipt.logs.some((entry) => !completeReceiptLog(entry))) {
      throw new Error("settlement receipt RPC result is incomplete");
    }
    if (receiptFailed(receipt)) throw new InvalidSettlementEvidence("settlement receipt failed");
    const block = blocks.get(BigInt(log.blockNumber).toString()) || await canonicalBlock(log.blockNumber);
    let exact = false;
    try {
      exact = Number(receipt.blockNumber) === Number(log.blockNumber)
        && hash(receipt.blockHash, "receipt block hash") === block.blockHash
        && hash(log.blockHash, "log block hash") === block.blockHash
        && receipt.logs.some((entry) => sameLog(entry, log));
    } catch { throw new Error("settlement receipt RPC result is incomplete"); }
    if (!exact) throw new InvalidSettlementEvidence("settlement receipt is not canonical exact evidence");
    return {
      quoteId: event.quoteId,
      txHash: hash(log.transactionHash, "transaction hash"), logIndex: logIndex(log),
      receiptBlock: block.blockNumber, receiptBlockHash: block.blockHash, receiptBlockTimestamp: block.blockTimestamp,
      settledAt: new Date(block.blockTimestamp), event,
      evidence: { chainId: configuredChain, splitter: configuredSplitter, canonical: true, scannerVerified: true,
        oneConfirmation: true, confirmations: depth },
    };
  }

  /**
   * Scan a block range for canonical settlement evidence.
   *
   * The logical reads are exactly those of the sequential scanner — 1 eth_chainId, one header per
   * block, one transaction count and one receipt set per block, and two boundary re-reads — so
   * the JSON-RPC method count remains 3N+3. Only the transport changes: reads within each phase
   * are issued with bounded concurrency so the provider can batch them, which is what collapses
   * thousands of serialized round trips into tens.
   *
   * Receipts remain the sole authority for settlement discovery. Nothing here consults
   * eth_getLogs or a header's logsBloom, so no provider-side log index or bloom can hide a
   * settlement that the receipts contain.
   */
  async function scanRange(window = {}) {
    const stats = {};
    // Optional client capability: a transport that can report real HTTP payload counts. The
    // scanner never depends on it, and its absence simply omits the two transport fields.
    const before = typeof client.transportStats === "function" ? client.transportStats() : undefined;
    const result = await meters.run(stats, () => runScan(window, stats));
    if (!before) return result;
    const after = client.transportStats();
    const delta = (field) => {
      const value = Number(after?.[field]) - Number(before?.[field]);
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    };
    const httpPayloads = delta("httpPayloads");
    if (httpPayloads === undefined) return result;
    return { ...result, rpcStats: Object.freeze({ ...result.rpcStats, httpPayloads }) };
  }

  async function runScan({ fromBlock, throughBlock } = {}, stats) {
    const started = process.hrtime.bigint();
    await assertChain();
    const from = BigInt(fromBlock); const through = BigInt(throughBlock);
    if (from < 0n || through < from) throw new TypeError("invalid scan range");

    // Phase 1: a canonical header for EVERY block in the range. record_scanner_range requires
    // jsonb_array_length(canonicalBlocks) = through-from+1 with parentHash chaining, so
    // contiguous coverage cannot be proven with fewer headers.
    const numbers = [];
    for (let number = from; number <= through; number += 1n) numbers.push(number);
    const fetched = await mapBounded(numbers, lanes, (number) => canonicalBlock(number, true));
    const canonicalBlocks = [];
    const byNumber = new Map();
    for (const [index, block] of fetched.entries()) {
      if (!block || block.blockNumber !== numbers[index].toString()) throw new Error("canonical block unavailable");
      const previous = canonicalBlocks.at(-1);
      if (previous && block.parentHash !== previous.blockHash) throw new Error("canonical block parent ancestry is inconsistent");
      canonicalBlocks.push(block); byNumber.set(block.blockNumber, block);
    }

    // Phase 2: the authoritative receipt read for every block, in ascending block order. Results
    // are collected by request index, so concurrency cannot reorder or mis-associate them.
    const perBlock = await mapBounded(canonicalBlocks, lanes, (block) => canonicalMatchingLogs(block));
    const logsWithReceipts = perBlock.flat();

    const candidates = []; const anomalies = [];
    for (const { log, receipt } of logsWithReceipts) {
      try { candidates.push(await verify(log, byNumber, receipt)); }
      catch (error) {
        if (!(error instanceof InvalidSettlementEvidence)) throw error;
        anomalies.push({ code: "INVALID_SETTLEMENT_EVIDENCE", txHash: HASH.test(log?.transactionHash || "") ? log.transactionHash.toLowerCase() : `0x${"0".repeat(64)}`,
        logIndex: Number.isSafeInteger(Number(log?.index ?? log?.logIndex)) && Number(log?.index ?? log?.logIndex) >= 0 ? Number(log.index ?? log.logIndex) : 0,
        blockNumber: anomalyBlock(log, from), blockHash: HASH.test(log?.blockHash || "") ? log.blockHash.toLowerCase() : byNumber.get(anomalyBlock(log, from))?.blockHash,
        blockTimestamp: byNumber.get(anomalyBlock(log, from))?.blockTimestamp ?? canonicalBlocks[0].blockTimestamp });
      }
    }

    // Phase 3: re-read the range boundaries last. A canonical rewrite during the scan invalidates
    // the whole range rather than checkpointing half-reorged evidence.
    const boundaries = [canonicalBlocks[0]];
    if (canonicalBlocks.length > 1) boundaries.push(canonicalBlocks.at(-1));
    for (const original of boundaries) {
      const current = await canonicalBlock(original.blockNumber);
      if (current.blockHash !== original.blockHash) throw new Error("canonical boundary changed during scan");
    }

    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      canonicalBlocks: canonicalBlocks.map(checkpointShape),
      candidates,
      anomalies,
      // Privacy-safe scan shape: counts and timings only, no wallet, quote or submission content.
      // These are LOGICAL JSON-RPC method calls. How many HTTP round trips they become depends on
      // the provider transport's batching, which ethers does not report, so it is deliberately
      // not surfaced here as a runtime metric.
      rpcStats: Object.freeze({
        rangeBlocks: canonicalBlocks.length,
        rpcMethodCalls: Object.values(stats).reduce((total, value) => total + value, 0),
        headerMethodCalls: stats.getBlockHeader || 0,
        receiptMethodCalls: (stats.getBlockReceipts || 0) + (stats.getBlockTransactionCount || 0)
          + (stats.getTransactionReceipt || 0),
        logQueryMethodCalls: 0,
        relevantLogs: logsWithReceipts.length,
        concurrency: lanes,
        elapsedMs: Math.round(elapsedMs),
      }),
    };
  }

  async function inspectTransaction(txHash) {
    await assertChain();
    const tx = hash(txHash, "transaction hash");
    const receipt = await rpcCall("getTransactionReceipt", () => client.getTransactionReceipt(tx));
    if (!receipt) return (await rpcCall("getTransaction", () => client.getTransaction(tx))) ? { state: "pending" } : { state: "dropped" };
    if ((!receiptSucceeded(receipt) && !receiptFailed(receipt)) || !Array.isArray(receipt.logs)
        || receipt.logs.some((entry) => !completeReceiptLog(entry))) throw new Error("settlement receipt RPC result is incomplete");
    if (receiptFailed(receipt)) return { state: "reverted" };
    const head = await getSafeHead();
    if (BigInt(receipt.blockNumber) > head) return { state: "unconfirmed" };
    const matching = (receipt.logs || []).filter((entry) => address(entry.address, "log address") === configuredSplitter
      && entry.topics?.[0]?.toLowerCase() === configuredTopic);
    if (matching.length !== 1) return { state: "mismatched" };
    try { return { state: "matched", candidate: await verify(matching[0], new Map()) }; }
    catch (error) {
      if (!(error instanceof InvalidSettlementEvidence)) throw error;
      return { state: "mismatched" };
    }
  }

  async function revalidateMonitor(monitor) {
    await assertChain();
    const block = await canonicalBlock(monitor.receiptBlock);
    if (block.blockHash !== hash(monitor.receiptBlockHash, "receipt block hash")) return { canonical: false };
    const receipt = await rpcCall("getTransactionReceipt", () => client.getTransactionReceipt(monitor.txHash));
    if (!receipt || (!receiptSucceeded(receipt) && !receiptFailed(receipt)) || !Array.isArray(receipt.logs)
        || receipt.logs.some((entry) => !completeReceiptLog(entry))) {
      throw new Error("settlement monitor receipt RPC result is incomplete");
    }
    if (receiptFailed(receipt) || hash(receipt.blockHash, "receipt block hash") !== block.blockHash) return { canonical: false };
    const exact = receipt.logs.some((entry) => {
      try {
        return hash(entry.transactionHash, "transaction hash") === hash(monitor.txHash, "transaction hash")
          && logIndex(entry) === Number(monitor.logIndex) && address(entry.address, "log address") === configuredSplitter
          && decodeQuoteSettledLog(entry, { splitter: configuredSplitter }).quoteId === String(monitor.quoteId).toLowerCase();
      } catch { return false; }
    });
    return { canonical: exact };
  }

  return Object.freeze({ chainId: configuredChain, splitter: configuredSplitter, confirmationDepth: depth, overlap: trailing,
    maxBlockRange: rangeLimit, scanConcurrency: lanes,
    getCanonicalHead, getSafeHead, scanRange, inspectTransaction, revalidateMonitor });
}

module.exports = { createBaseSettlementAdapter, settlementConfigFromEnv,
  DEFAULT_SCAN_CONCURRENCY, MAX_SCAN_CONCURRENCY };
