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

function positive(value, name, fallback) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer`);
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

function settlementConfigFromEnv(env = process.env) {
  const confirmationDepth = positive(env.GAVEL_GATE_CONFIRMATION_DEPTH, "GAVEL_GATE_CONFIRMATION_DEPTH", DEFAULT_CONFIRMATION_DEPTH);
  if (confirmationDepth !== 1) throw new TypeError("GAVEL_GATE_CONFIRMATION_DEPTH must be exactly 1 for the MVP");
  return Object.freeze({
    confirmationDepth,
    overlap: positive(env.GAVEL_GATE_REORG_OVERLAP_BLOCKS, "GAVEL_GATE_REORG_OVERLAP_BLOCKS", DEFAULT_SCANNER_OVERLAP),
    maxBlockRange: positive(env.GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE,
      "GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE", DEFAULT_MAX_BLOCK_RANGE),
  });
}

function createBaseSettlementAdapter({ client, chainId, splitter, confirmationDepth = DEFAULT_CONFIRMATION_DEPTH,
  overlap = DEFAULT_SCANNER_OVERLAP, maxBlockRange = DEFAULT_MAX_BLOCK_RANGE, rpcTimeoutMs = 10_000,
  clock = () => new Date() } = {}) {
  for (const method of ["getChainId", "getBlockNumber", "getBlock", "getBlockTransactionCount", "getBlockReceipts",
    "getTransactionReceipt", "getTransaction"]) {
    if (!client || typeof client[method] !== "function") throw new TypeError(`client.${method} is required`);
  }
  const configuredChain = BigInt(chainId).toString();
  if (BigInt(configuredChain) < 1n) throw new TypeError("chainId must be positive");
  const configuredSplitter = address(splitter, "splitter");
  const depth = positive(confirmationDepth, "confirmationDepth", DEFAULT_CONFIRMATION_DEPTH);
  if (depth !== 1) throw new TypeError("confirmationDepth must be exactly 1 for the MVP");
  const trailing = positive(overlap, "overlap", DEFAULT_SCANNER_OVERLAP);
  const rangeLimit = positive(maxBlockRange, "maxBlockRange", DEFAULT_MAX_BLOCK_RANGE);
  const rpcLimit = positive(rpcTimeoutMs, "rpcTimeoutMs", 10_000);
  if (rpcLimit > 60_000) throw new TypeError("rpcTimeoutMs must not exceed 60000");
  if (rangeLimit <= trailing) throw new TypeError("maxBlockRange must be greater than overlap");

  async function rpcCall(name, operation) {
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

  async function canonicalBlock(number, includeTransactions = false) {
    const block = await rpcCall("getBlock", () => client.getBlock(Number(number)));
    if (!block || Number(block.number) !== Number(number)) throw new Error("canonical block unavailable");
    let transactionHashes;
    if (includeTransactions) {
      if (!Array.isArray(block.transactions)) throw new Error("canonical block transaction set is incomplete");
      try {
        transactionHashes = block.transactions.map((transaction) => hash(
          typeof transaction === "string" ? transaction : transaction?.hash, "block transaction hash"));
      } catch { throw new Error("canonical block transaction set is incomplete"); }
      if (new Set(transactionHashes).size !== transactionHashes.length) {
        throw new Error("canonical block transaction set is incomplete");
      }
    }
    return { blockNumber: BigInt(number).toString(), blockHash: hash(block.hash, "block hash"),
      parentHash: hash(block.parentHash, "block parent hash"), blockTimestamp: timestamp(block.timestamp),
      ...(includeTransactions ? { transactionHashes } : {}) };
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

  async function scanRange({ fromBlock, throughBlock } = {}) {
    await assertChain();
    const from = BigInt(fromBlock); const through = BigInt(throughBlock);
    if (from < 0n || through < from) throw new TypeError("invalid scan range");
    const canonicalBlocks = [];
    const byNumber = new Map();
    for (let number = from; number <= through; number += 1n) {
      const block = await canonicalBlock(number, true);
      const previous = canonicalBlocks.at(-1);
      if (previous && block.parentHash !== previous.blockHash) throw new Error("canonical block parent ancestry is inconsistent");
      canonicalBlocks.push(block); byNumber.set(block.blockNumber, block);
    }
    const logsWithReceipts = [];
    for (const block of canonicalBlocks) {
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
              && log.topics[0].toLowerCase() === QUOTE_SETTLED_TOPIC.toLowerCase()) {
            logsWithReceipts.push({ log, receipt });
          }
        }
      }
      const expectedTransactions = [...block.transactionHashes].sort();
      const observedTransactions = [...receiptTransactionHashes].sort();
      if (JSON.stringify(observedTransactions) !== JSON.stringify(expectedTransactions)) {
        throw new Error("block receipt transaction set RPC result is incomplete");
      }
    }
    const candidates = []; const anomalies = [];
    for (const { log, receipt } of logsWithReceipts) {
      try { candidates.push(await verify(log, byNumber, receipt)); }
      catch (error) {
        if (!(error instanceof InvalidSettlementEvidence)) throw error;
        anomalies.push({ code: "INVALID_SETTLEMENT_EVIDENCE", txHash: HASH.test(log?.transactionHash || "") ? log.transactionHash.toLowerCase() : `0x${"0".repeat(64)}`,
        logIndex: Number.isSafeInteger(Number(log?.index ?? log?.logIndex)) && Number(log?.index ?? log?.logIndex) >= 0 ? Number(log.index ?? log.logIndex) : 0,
        blockNumber: String(log?.blockNumber ?? from), blockHash: HASH.test(log?.blockHash || "") ? log.blockHash.toLowerCase() : byNumber.get(String(log?.blockNumber))?.blockHash,
        blockTimestamp: byNumber.get(String(log?.blockNumber))?.blockTimestamp ?? canonicalBlocks[0].blockTimestamp });
      }
    }
    const boundaries = [canonicalBlocks[0]];
    if (canonicalBlocks.length > 1) boundaries.push(canonicalBlocks.at(-1));
    for (const original of boundaries) {
      const current = await canonicalBlock(original.blockNumber);
      if (current.blockHash !== original.blockHash) throw new Error("canonical boundary changed during scan");
    }
    return { canonicalBlocks, candidates, anomalies };
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
      && entry.topics?.[0]?.toLowerCase() === QUOTE_SETTLED_TOPIC.toLowerCase());
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
    maxBlockRange: rangeLimit,
    getCanonicalHead, getSafeHead, scanRange, inspectTransaction, revalidateMonitor });
}

module.exports = { createBaseSettlementAdapter, settlementConfigFromEnv };
