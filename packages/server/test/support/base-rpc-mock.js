// Deterministic synthetic Base chain + call-counting JSON-RPC client.
//
// Used by the scanner regression tests and by the benchmark scripts. It exposes the
// client surface the adapter requires (getBlock / getBlockHeader /
// getBlockTransactionCount / getBlockReceipts / getTransactionReceipt) plus
// getLogs and a real header logsBloom.
//
// getLogs and logsBloom exist here on purpose even though the default scanner never
// reads them: tests corrupt them and assert that settlement discovery is unaffected,
// which is how the receipt-authoritative guarantee is proven rather than asserted.
const { Interface, keccak256, getBytes, toBeHex, id } = require("ethers");
const { QUOTE_SETTLED_EVENT_ABI, QUOTE_SETTLED_TOPIC } = require("@gavel/gate");

const iface = new Interface([QUOTE_SETTLED_EVENT_ABI]);
const BLOOM_BYTES = 256;

function bloomAdd(bloom, item) {
  const digest = getBytes(keccak256(item));
  for (const offset of [0, 2, 4]) {
    const bit = (((digest[offset] << 8) | digest[offset + 1]) & 0x7ff);
    bloom[BLOOM_BYTES - 1 - (bit >> 3)] |= 1 << (bit & 7);
  }
}

function bloomHex(bloom) {
  return `0x${Buffer.from(bloom).toString("hex")}`;
}

function digest(label) { return keccak256(Buffer.from(label, "utf8")); }

function hexQuantity(value) { return toBeHex(BigInt(value)); }

function quoteSettledLog({ splitter, quoteId, payer, voter, attentionAmount, gavelRecipient, token, submissionHash }) {
  const encoded = iface.encodeEventLog(iface.getEvent("QuoteSettled"), [
    quoteId, payer, voter, BigInt(attentionAmount), gavelRecipient, 250_000n, token, submissionHash,
  ]);
  return { address: splitter, topics: encoded.topics, data: encoded.data };
}

/**
 * Build a synthetic canonical chain.
 *
 * settlements: [{ block, quoteId, payer, voter, attentionAmount, gavelRecipient, token, submissionHash }]
 * noiseLogsPerBlock: unrelated logs added to every block so blooms are realistically filled.
 */
function createSyntheticChain({
  fromBlock = 0n,
  head = 100n,
  splitter,
  settlements = [],
  noiseLogsPerBlock = 0,
  noiseTxPerBlock = 1,
  seed = "gavel",
  baseTimestamp = 1_700_000_000,
} = {}) {
  const first = BigInt(fromBlock);
  const last = BigInt(head);
  const blocks = new Map();
  const receiptsByTx = new Map();
  const settlementsByBlock = new Map();
  for (const settlement of settlements) {
    const key = BigInt(settlement.block).toString();
    if (!settlementsByBlock.has(key)) settlementsByBlock.set(key, []);
    settlementsByBlock.get(key).push(settlement);
  }
  let parentHash = digest(`${seed}:parent:${first}`);
  for (let number = first; number <= last; number += 1n) {
    const key = number.toString();
    const hash = digest(`${seed}:block:${key}`);
    const bloom = new Uint8Array(BLOOM_BYTES);
    const receipts = [];
    const transactions = [];
    const pushReceipt = (txHash, logs, status = 1) => {
      transactions.push(txHash);
      const materialized = logs.map((log, offset) => ({
        ...log,
        transactionHash: txHash,
        blockNumber: Number(number),
        blockHash: hash,
        index: receipts.reduce((total, receipt) => total + receipt.logs.length, 0) + offset,
      }));
      for (const log of materialized) {
        bloomAdd(bloom, log.address);
        for (const topic of log.topics) bloomAdd(bloom, topic);
      }
      const receipt = { status, transactionHash: txHash, blockNumber: Number(number), blockHash: hash, logs: materialized };
      receipts.push(receipt);
      receiptsByTx.set(txHash, receipt);
    };
    for (let index = 0; index < noiseTxPerBlock; index += 1) {
      const logs = [];
      for (let offset = 0; offset < noiseLogsPerBlock; offset += 1) {
        logs.push({
          address: `0x${digest(`${seed}:noise-address:${key}:${index}:${offset}`).slice(26)}`,
          topics: [id(`Noise(uint256,uint256,${key}:${index}:${offset})`), digest(`${seed}:noise-topic:${key}:${index}:${offset}`)],
          data: `0x${"00".repeat(32)}`,
        });
      }
      pushReceipt(digest(`${seed}:noise-tx:${key}:${index}`), logs);
    }
    for (const [offset, settlement] of (settlementsByBlock.get(key) || []).entries()) {
      pushReceipt(settlement.txHash || digest(`${seed}:settlement-tx:${key}:${offset}`),
        [quoteSettledLog({ splitter, ...settlement })], settlement.status ?? 1);
    }
    blocks.set(key, {
      number, hash, parentHash, timestamp: baseTimestamp + Number(number) * 2,
      transactions, receipts, logsBloom: bloomHex(bloom),
    });
    parentHash = hash;
  }
  return { first, last, blocks, receiptsByTx, splitter };
}

function matchingLogs(chain, { address, topic, fromBlock, toBlock }) {
  const found = [];
  for (let number = BigInt(fromBlock); number <= BigInt(toBlock); number += 1n) {
    const block = chain.blocks.get(number.toString());
    if (!block) continue;
    for (const receipt of block.receipts) {
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== address.toLowerCase()) continue;
        if (log.topics[0].toLowerCase() !== topic.toLowerCase()) continue;
        found.push(log);
      }
    }
  }
  return found;
}

function rawLog(log) {
  return {
    address: log.address, topics: log.topics, data: log.data,
    blockNumber: hexQuantity(log.blockNumber), blockHash: log.blockHash,
    transactionHash: log.transactionHash, logIndex: hexQuantity(log.index),
    removed: false,
  };
}

// Receipts come back from a raw provider.send, so every numeric field is QUANTITY hex, exactly
// as eth_getBlockReceipts / eth_getTransactionReceipt encode it. Returning decimals here would
// hide encoding bugs in code that stringifies these fields.
function rawReceipt(receipt) {
  return {
    status: receipt.status ? "0x1" : "0x0",
    transactionHash: receipt.transactionHash,
    blockNumber: hexQuantity(receipt.blockNumber),
    blockHash: receipt.blockHash,
    logs: receipt.logs.map(rawLog),
  };
}

function rawHeader(block) {
  return {
    number: hexQuantity(block.number), hash: block.hash, parentHash: block.parentHash,
    timestamp: hexQuantity(block.timestamp), logsBloom: block.logsBloom,
    transactions: [...block.transactions],
  };
}

/**
 * A client whose every method increments a per-method counter, so tests can make
 * exact RPC call-count assertions and the benchmark can report call shape.
 */
function createCountingClient(chain, { chainId = 8453, splitter = chain.splitter, overrides = {}, logRangeLimit,
  maxLogResults } = {}) {
  const counts = new Map();
  const count = (method) => counts.set(method, (counts.get(method) || 0) + 1);
  const block = (number) => {
    const found = chain.blocks.get(BigInt(number).toString());
    if (!found) throw new Error(`synthetic chain has no block ${number}`);
    return found;
  };
  const client = {
    async getChainId() { count("eth_chainId"); return chainId; },
    async getBlockNumber() { count("eth_blockNumber"); return Number(chain.last); },
    async getBlock(number) {
      count("eth_getBlockByNumber");
      const found = block(number);
      return { number: Number(found.number), hash: found.hash, parentHash: found.parentHash,
        timestamp: found.timestamp, transactions: [...found.transactions] };
    },
    async getBlockHeader(number) { count("eth_getBlockByNumber"); return rawHeader(block(number)); },
    async getLogs(filter) {
      count("eth_getLogs");
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      if (logRangeLimit !== undefined && to - from + 1n > BigInt(logRangeLimit)) {
        throw new Error("query returned more than 10000 results / block range is too large");
      }
      const topic = Array.isArray(filter.topics?.[0]) ? filter.topics[0][0] : filter.topics?.[0];
      const found = matchingLogs(chain, { address: filter.address, topic: topic ?? QUOTE_SETTLED_TOPIC,
        fromBlock: from, toBlock: to }).map(rawLog);
      if (maxLogResults !== undefined && found.length > maxLogResults) {
        throw new Error("query returned more than 10000 results");
      }
      return found;
    },
    async getBlockTransactionCount(number) { count("eth_getBlockTransactionCountByNumber"); return hexQuantity(block(number).transactions.length); },
    async getBlockReceipts(number) { count("eth_getBlockReceipts"); return block(number).receipts.map(rawReceipt); },
    async getTransactionReceipt(hash) {
      count("eth_getTransactionReceipt");
      const receipt = chain.receiptsByTx.get(String(hash).toLowerCase());
      return receipt ? rawReceipt(receipt) : null;
    },
    async getTransaction(hash) { count("eth_getTransactionByHash"); return chain.receiptsByTx.has(String(hash).toLowerCase()) ? { hash } : null; },
    ...overrides,
  };
  return {
    client,
    counts,
    get total() { return [...counts.values()].reduce((sum, value) => sum + value, 0); },
    calls(method) { return counts.get(method) || 0; },
    reset() { counts.clear(); },
    snapshot() { return Object.fromEntries([...counts.entries()].sort()); },
    splitter,
  };
}

module.exports = { bloomAdd, bloomHex, createSyntheticChain, createCountingClient, matchingLogs, rawHeader, rawLog, digest };
