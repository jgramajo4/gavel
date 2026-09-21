const {
  DEFAULT_CONFIRMATION_DEPTH,
  DEFAULT_SCANNER_OVERLAP,
  QUOTE_SETTLED_TOPIC,
  decodeQuoteSettledLog,
  safeHead,
} = require("@gavel/gate");
const { AsyncLocalStorage } = require("node:async_hooks");
const { isLogsBloom, createLogsBloomMatcher } = require("./logs-bloom");

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_MAX_BLOCK_RANGE = 5_000;
// Public Base RPC providers cap eth_getLogs spans (commonly 10k blocks / 10k results).
// A conservative default keeps a full maxBlockRange scan to a handful of log queries.
const DEFAULT_MAX_LOG_RANGE = 1_000;
// Header reads are the one per-block RPC the checkpoint invariant still requires, so they
// are issued with bounded concurrency. ethers' JsonRpcProvider coalesces concurrent sends
// into JSON-RPC batches, which turns this bound into "one HTTP round trip per wave".
const DEFAULT_HEADER_CONCURRENCY = 64;
const MAX_HEADER_CONCURRENCY = 256;
// Fraction of bloom-negative blocks read in full anyway, to detect a provider whose bloom
// index disagrees with its own receipts. 0 disables the audit; 1 restores the old cost.
const DEFAULT_BLOOM_AUDIT_RATE = 0.01;
const DEFAULT_BLOOM_AUDIT_CAP = 64;
// Signals that specifically mean "this eth_getLogs span is too wide", so halving is the remedy.
// Deliberately excludes rate-limit shapes ("rate limit exceeded", Infura's -32005, bare 429):
// splitting a throttled query multiplies the requests aimed at a provider already throttling us.
const RANGE_LIMIT_HINT =
  /too many results|more than \d+ results|query timeout|block range|response size|log response size/i;

function positive(value, name, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer`);
  return result;
}
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
// Reconciliation between two independent RPC views of the same log (eth_getLogs and
// eth_getBlockReceipts) compares canonical bytes, so a provider that differs only in hex
// casing is not treated as a contradiction.
function logIdentity(log) { return `${hash(log.transactionHash, "log transaction hash")}:${logIndex(log)}`; }
function logFingerprint(log) {
  return JSON.stringify([
    hash(log.transactionHash, "log transaction hash"), logIndex(log), Number(log.blockNumber),
    hash(log.blockHash, "log block hash"), address(log.address, "log address"),
    String(log.data).toLowerCase(), log.topics.map((topic) => String(topic).toLowerCase()),
  ]);
}
// Receipt logs arrive as raw JSON-RPC QUANTITY hex. Observations are persisted as numeric(78,0),
// so a block number must be normalized to decimal before it leaves the adapter.
function anomalyBlock(log, fallback) {
  try { return quantity(log?.blockNumber, "log block number").toString(); }
  catch { return BigInt(fallback).toString(); }
}
function isRangeLimitError(error) {
  const message = `${error?.message || ""} ${error?.error?.message || ""} ${error?.code || ""}`;
  return RANGE_LIMIT_HINT.test(message);
}
async function mapBounded(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (;;) {
      if (failure !== undefined) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { if (failure === undefined) failure = error; return; }
    }
  }));
  if (failure !== undefined) throw failure;
  return results;
}

function settlementConfigFromEnv(env = process.env) {
  const confirmationDepth = positive(env.GAVEL_GATE_CONFIRMATION_DEPTH, "GAVEL_GATE_CONFIRMATION_DEPTH", DEFAULT_CONFIRMATION_DEPTH);
  if (confirmationDepth !== 1) throw new TypeError("GAVEL_GATE_CONFIRMATION_DEPTH must be exactly 1 for the MVP");
  const maxBlockRange = positive(env.GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE,
    "GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE", DEFAULT_MAX_BLOCK_RANGE);
  const headerConcurrency = positive(env.GAVEL_GATE_SETTLEMENT_HEADER_CONCURRENCY,
    "GAVEL_GATE_SETTLEMENT_HEADER_CONCURRENCY", DEFAULT_HEADER_CONCURRENCY);
  if (headerConcurrency > MAX_HEADER_CONCURRENCY) {
    throw new TypeError(`GAVEL_GATE_SETTLEMENT_HEADER_CONCURRENCY must not exceed ${MAX_HEADER_CONCURRENCY}`);
  }
  return Object.freeze({
    confirmationDepth,
    overlap: positive(env.GAVEL_GATE_REORG_OVERLAP_BLOCKS, "GAVEL_GATE_REORG_OVERLAP_BLOCKS", DEFAULT_SCANNER_OVERLAP),
    maxBlockRange,
    // Same clamp as settlementRuntimeConfigFromEnv: a scan never spans more than maxBlockRange.
    maxLogRange: Math.min(positive(env.GAVEL_GATE_SETTLEMENT_MAX_LOG_RANGE,
      "GAVEL_GATE_SETTLEMENT_MAX_LOG_RANGE", DEFAULT_MAX_LOG_RANGE), maxBlockRange),
    headerConcurrency,
  });
}

function createBaseSettlementAdapter({ client, chainId, splitter, confirmationDepth = DEFAULT_CONFIRMATION_DEPTH,
  overlap = DEFAULT_SCANNER_OVERLAP, maxBlockRange = DEFAULT_MAX_BLOCK_RANGE, maxLogRange = DEFAULT_MAX_LOG_RANGE,
  headerConcurrency = DEFAULT_HEADER_CONCURRENCY, bloomAuditRate = DEFAULT_BLOOM_AUDIT_RATE,
  bloomAuditCap = DEFAULT_BLOOM_AUDIT_CAP, rpcTimeoutMs = 10_000,
  clock = () => new Date() } = {}) {
  for (const method of ["getChainId", "getBlockNumber", "getBlockHeader", "getLogs", "getBlockTransactionCount",
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
  const logRangeLimit = positive(maxLogRange, "maxLogRange", DEFAULT_MAX_LOG_RANGE);
  const headerLanes = positive(headerConcurrency, "headerConcurrency", DEFAULT_HEADER_CONCURRENCY);
  if (headerLanes > MAX_HEADER_CONCURRENCY) throw new TypeError(`headerConcurrency must not exceed ${MAX_HEADER_CONCURRENCY}`);
  const auditRate = Number(bloomAuditRate);
  if (!Number.isFinite(auditRate) || auditRate < 0 || auditRate > 1) {
    throw new TypeError("bloomAuditRate must be from 0 to 1");
  }
  const auditCap = Number(bloomAuditCap);
  if (!Number.isSafeInteger(auditCap) || auditCap < 0) throw new TypeError("bloomAuditCap must be a non-negative integer");
  const rpcLimit = positive(rpcTimeoutMs, "rpcTimeoutMs", 10_000);
  if (rpcLimit > 60_000) throw new TypeError("rpcTimeoutMs must not exceed 60000");
  if (rangeLimit <= trailing) throw new TypeError("maxBlockRange must be greater than overlap");

  // The splitter address and the event topic are fixed for the adapter's lifetime, so their
  // bloom bit positions are derived once instead of keccak-hashed per scanned block.
  const bloomMatcher = createLogsBloomMatcher([configuredSplitter, configuredTopic]);

  // Central RPC counter: every adapter RPC goes through rpcCall, so per-scan call shape is
  // measured at one place. The counter is held in async-local storage rather than a closure
  // variable, because reconcileSubmitted and monitorOnce run on their own timers against this
  // same adapter and would otherwise have their calls attributed to an in-flight scan.
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

  // One eth_getBlockByNumber(number, false) per canonical block. It carries every field the
  // checkpoint invariant needs (hash, parentHash, timestamp), the transaction hash set, and
  // the logsBloom that proves whether the block can hold a QuoteSettled log at all.
  async function canonicalBlock(number, { retainTransactions = false } = {}) {
    const header = await rpcCall("getBlock", () => client.getBlockHeader(Number(number)));
    if (!header || quantity(header.number, "canonical block number") !== BigInt(number)) {
      throw new Error("canonical block unavailable");
    }
    if (!isLogsBloom(header.logsBloom)) throw new Error("canonical block header is incomplete");
    if (!Array.isArray(header.transactions)) throw new Error("canonical block transaction set is incomplete");
    let transactionHashes;
    try {
      transactionHashes = header.transactions.map((transaction) => hash(
        typeof transaction === "string" ? transaction : transaction?.hash, "block transaction hash"));
    } catch { throw new Error("canonical block transaction set is incomplete"); }
    if (new Set(transactionHashes).size !== transactionHashes.length) {
      throw new Error("canonical block transaction set is incomplete");
    }
    // The transaction hash set is validated for every block but retained only where it is
    // used — cross-checking a bloom-positive block's receipts. Holding it for every block in
    // a 5,000-block range is tens of megabytes of hex strings nothing ever reads.
    const mayHoldSettlement = bloomMatcher(header.logsBloom);
    return { blockNumber: BigInt(number).toString(), blockHash: hash(header.hash, "block hash"),
      parentHash: hash(header.parentHash, "block parent hash"),
      blockTimestamp: timestamp(Number(quantity(header.timestamp, "block timestamp"))),
      mayHoldSettlement, ...(mayHoldSettlement || retainTransactions ? { transactionHashes } : {}) };
  }

  // The four fields recordScannerRange validates and persists. The pre-optimization scanRange
  // also carried transactionHashes on each block; both stores normalize to these four before
  // building p_metadata, so stored scanner_result and generation-replay comparisons are
  // unchanged either way. Emitting exactly them keeps that independent of store behaviour.
  function checkpointShape(block) {
    return { blockNumber: block.blockNumber, blockHash: block.blockHash, parentHash: block.parentHash,
      blockTimestamp: block.blockTimestamp };
  }

  function mayHoldSettlement(block) { return block.mayHoldSettlement === true; }

  async function canonicalBlockWithTransactions(block) {
    const reread = await canonicalBlock(block.blockNumber, { retainTransactions: true });
    if (reread.blockHash !== block.blockHash) throw new Error("canonical boundary changed during scan");
    return reread;
  }

  // Sample without replacement, capped so a wide range cannot turn the audit into the old cost.
  function sampleForAudit(blocks) {
    if (auditRate <= 0 || blocks.length === 0) return [];
    const target = Math.min(auditCap, Math.max(1, Math.round(blocks.length * auditRate)));
    if (target >= blocks.length) return [...blocks];
    const chosen = new Set();
    while (chosen.size < target) chosen.add(Math.floor(Math.random() * blocks.length));
    return [...chosen].sort((left, right) => left - right).map((index) => blocks[index]);
  }

  // Strict eth_getLogs discovery: exact splitter, exact QuoteSettled topic0, exact span.
  // Chunked up front, and halved adaptively when a provider rejects a span for being too
  // wide or returning too many results. A chunk is never skipped: it either resolves or throws.
  async function discoverLogs(from, through) {
    const found = [];
    const seen = new Map();
    const idealChunks = Number((through - from) / BigInt(logRangeLimit)) + 1;
    // Halving is bounded: legitimate adaptation needs a few extra queries, a provider that
    // rejects everything would otherwise issue ~2 queries per block before giving up.
    let budget = Math.max(64, idealChunks * 8);
    async function query(start, end) {
      if (budget <= 0) throw new Error("settlement log discovery exceeded its query budget");
      budget -= 1;
      let logs;
      try {
        logs = await rpcCall("getLogs", () => client.getLogs({
          fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`,
          address: configuredSplitter, topics: [QUOTE_SETTLED_TOPIC],
        }));
      } catch (error) {
        if (start >= end || !isRangeLimitError(error)) {
          throw Object.assign(new Error(`settlement log discovery failed for blocks ${start}-${end}: ${error?.message || error}`),
            { cause: error });
        }
        const middle = start + (end - start) / 2n;
        await query(start, middle);
        await query(middle + 1n, end);
        return;
      }
      if (!Array.isArray(logs)) throw new Error("settlement log discovery result is incomplete");
      for (const log of logs) {
        if (!log || !completeReceiptLog(log)) throw new Error("settlement log discovery result is incomplete");
        if (address(log.address, "log address") !== configuredSplitter) {
          throw new Error("settlement log discovery returned a log from another contract");
        }
        if (String(log.topics[0]).toLowerCase() !== configuredTopic) {
          throw new Error("settlement log discovery returned an unrelated event topic");
        }
        const number = quantity(log.blockNumber, "log block number");
        if (number < start || number > end) throw new Error("settlement log discovery returned an out-of-range log");
        const identity = logIdentity(log);
        const fingerprint = logFingerprint(log);
        const previous = seen.get(identity);
        if (previous !== undefined) {
          // A duplicated but byte-identical log is a benign provider repeat; a duplicated
          // identity with different content is a contradiction and fails closed.
          if (previous !== fingerprint) throw new Error("settlement log discovery returned conflicting duplicate logs");
          continue;
        }
        seen.set(identity, fingerprint);
        found.push(log);
      }
    }
    for (let start = from; start <= through; start += BigInt(logRangeLimit)) {
      const end = start + BigInt(logRangeLimit) - 1n > through ? through : start + BigInt(logRangeLimit) - 1n;
      await query(start, end);
    }
    // eth_getLogs makes no ordering guarantee across providers; the scanner sorts so that
    // observation ordering is a function of the chain, not of the provider's response order.
    found.sort((left, right) => {
      const leftBlock = Number(left.blockNumber);
      const rightBlock = Number(right.blockNumber);
      return leftBlock === rightBlock ? logIndex(left) - logIndex(right) : leftBlock - rightBlock;
    });
    return found;
  }

  // Full canonical receipt enumeration for one block: unchanged from the pre-optimization
  // scanner, and still the ONLY source of accepted settlement evidence.
  async function canonicalMatchingLogs(source) {
    // Audited bloom-negative blocks did not retain their transaction set; re-read the header.
    const block = source.transactionHashes ? source : await canonicalBlockWithTransactions(source);
    const transactionCount = Number(await rpcCall("getBlockTransactionCount",
      () => client.getBlockTransactionCount(Number(block.blockNumber))));
    if (!Number.isSafeInteger(transactionCount) || transactionCount < 0) {
      throw new Error("block transaction count RPC result is incomplete");
    }
    const receipts = await rpcCall("getBlockReceipts", () => client.getBlockReceipts(Number(block.blockNumber)));
    if (transactionCount !== block.transactionHashes.length || !Array.isArray(receipts)
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
    const expectedTransactions = [...block.transactionHashes].sort();
    const observedTransactions = [...receiptTransactionHashes].sort();
    if (JSON.stringify(observedTransactions) !== JSON.stringify(expectedTransactions)) {
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

  async function scanRange(window = {}) {
    const stats = {};
    return meters.run(stats, () => runScan(window, stats));
  }

  async function runScan({ fromBlock, throughBlock } = {}, stats) {
    const started = process.hrtime.bigint();
    {
      await assertChain();
      const from = BigInt(fromBlock); const through = BigInt(throughBlock);
      if (from < 0n || through < from) throw new TypeError("invalid scan range");

      // 1. Discovery: one strictly filtered eth_getLogs span (chunked only if the provider
      //    refuses the width). This is an accelerator and an integrity probe, never the
      //    evidence a settlement or a capacity release rests on.
      const discovered = await discoverLogs(from, through);

      // 2. Canonical headers for EVERY block in the range. record_scanner_range requires
      //    jsonb_array_length(canonicalBlocks) = through - from + 1 with parentHash chaining,
      //    so contiguous coverage cannot be proven with fewer headers.
      const numbers = [];
      for (let number = from; number <= through; number += 1n) numbers.push(number);
      const fetched = await mapBounded(numbers, headerLanes, (number) => canonicalBlock(number));
      const canonicalBlocks = [];
      const byNumber = new Map();
      for (const [index, block] of fetched.entries()) {
        if (!block || block.blockNumber !== numbers[index].toString()) throw new Error("canonical block unavailable");
        const previous = canonicalBlocks.at(-1);
        if (previous && block.parentHash !== previous.blockHash) throw new Error("canonical block parent ancestry is inconsistent");
        canonicalBlocks.push(block); byNumber.set(block.blockNumber, block);
      }

      // 3. Reconcile discovery against the headers. A log sitting on a block hash that is not
      //    the canonical one is evidence from an orphaned sibling block and is dropped, exactly
      //    as the receipt path already drops it. A log the canonical header's own logsBloom
      //    denies is a contradiction between two provider answers and fails closed.
      const discoveredByBlock = new Map();
      let nonCanonicalLogs = 0;
      for (const log of discovered) {
        const key = quantity(log.blockNumber, "log block number").toString();
        const block = byNumber.get(key);
        if (!block) throw new Error("settlement log discovery returned an out-of-range log");
        if (hash(log.blockHash, "log block hash") !== block.blockHash) { nonCanonicalLogs += 1; continue; }
        if (!mayHoldSettlement(block)) {
          throw new Error("canonical block header contradicts settlement log discovery");
        }
        if (!discoveredByBlock.has(key)) discoveredByBlock.set(key, []);
        discoveredByBlock.get(key).push(log);
      }

      // 4. Canonical enumeration for every block whose header bloom admits the event. Blocks the
      //    bloom rejects are PROVEN to hold no QuoteSettled log (blooms have no false negatives),
      //    so their no-match coverage rests on the same canonical header evidence as before and
      //    never on an empty eth_getLogs answer.
      const relevantBlocks = canonicalBlocks.filter(mayHoldSettlement);
      // Receipt reads are concurrent too, so the round-trip win does not evaporate on a dense
      // range where the bloom admits many blocks. Results are collected by request index, so
      // logsWithReceipts stays in ascending block order regardless of completion order.
      const perBlock = await mapBounded(relevantBlocks, headerLanes, async (block) => {
        const matches = await canonicalMatchingLogs(block);
        // The receipt set is authoritative in both directions that matter. A log eth_getLogs
        // reported that the receipts do not contain is an injection and fails closed; a log the
        // receipts contain that eth_getLogs omitted is merely a lossy index, and the scanner
        // still accepts it, because the bloom already forced this block's receipts to be read.
        const canonicalIdentities = new Map(matches.map(({ log }) => [logIdentity(log), logFingerprint(log)]));
        const discoveredIdentities = new Map((discoveredByBlock.get(block.blockNumber) || [])
          .map((log) => [logIdentity(log), logFingerprint(log)]));
        for (const [identity, fingerprint] of discoveredIdentities) {
          if (canonicalIdentities.get(identity) !== fingerprint) {
            throw new Error("settlement log discovery is inconsistent with canonical receipts");
          }
        }
        return { matches, omissions: canonicalIdentities.size - discoveredIdentities.size };
      });
      const logsWithReceipts = perBlock.flatMap((entry) => entry.matches);
      const discoveryOmissions = perBlock.reduce((total, entry) => total + entry.omissions, 0);

      // 4b. Bloom audit. A bloom-negative block is skipped on the strength of its header's own
      //     logsBloom, and eth_getLogs cannot corroborate it: go-ethereum's log filter selects
      //     candidate blocks using those same header blooms, so a provider serving a corrupted
      //     bloom index would hide a log from BOTH answers. A bounded random sample of skipped
      //     blocks is therefore read in full, turning a silent wrong release into a loud abort.
      const skipped = canonicalBlocks.filter((block) => !mayHoldSettlement(block));
      const audited = sampleForAudit(skipped);
      for (const block of await mapBounded(audited, headerLanes, async (block) => ({
        block, matches: await canonicalMatchingLogs(block) }))) {
        if (block.matches.length > 0) {
          throw new Error("canonical receipts contradict a bloom-negative block header");
        }
      }

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

      // 5. Re-read the range boundaries last: a canonical rewrite during the scan invalidates
      //    the whole range rather than checkpointing half-reorged evidence.
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
        rpcStats: Object.freeze({
          rangeBlocks: canonicalBlocks.length,
          rpcCalls: Object.values(stats).reduce((total, value) => total + value, 0),
          getLogsCalls: stats.getLogs || 0,
          headerCalls: stats.getBlock || 0,
          receiptCalls: (stats.getBlockReceipts || 0) + (stats.getBlockTransactionCount || 0)
            + (stats.getTransactionReceipt || 0),
          relevantLogs: logsWithReceipts.length,
          relevantBlocks: relevantBlocks.length,
          discoveredLogs: discovered.length,
          discoveryOmissions,
          nonCanonicalLogs,
          auditedBlocks: audited.length,
          elapsedMs: Math.round(elapsedMs),
        }),
      };
    }
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
    maxBlockRange: rangeLimit, maxLogRange: logRangeLimit, headerConcurrency: headerLanes,
    bloomAuditRate: auditRate, bloomAuditCap: auditCap,
    getCanonicalHead, getSafeHead, scanRange, inspectTransaction, revalidateMonitor });
}

module.exports = { createBaseSettlementAdapter, settlementConfigFromEnv };
