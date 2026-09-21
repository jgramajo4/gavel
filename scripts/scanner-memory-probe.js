#!/usr/bin/env node
// Resource-bound probe for BaseSettlementAdapter.scanRange().
//
// Reports peak RSS/heap attributable to a scan, the peak number of in-flight RPCs, and the
// per-block retention, for a range sized like a real backfill. The synthetic chain fixture
// itself dominates absolute memory, so the figure that matters is the DELTA across the scan.
//
//   node scripts/scanner-memory-probe.js [--blocks 5000] [--tx 150] [--concurrency 64] [--adapter <path>]
const { keccak256, toQuantity } = require("ethers");

const SPLITTER = `0x${"3".repeat(40)}`;

// A LAZY chain: blocks are generated on demand and never retained, so the measured heap is the
// scanner's own retention rather than the fixture's. A materialized fixture for a 5,000-block
// range at realistic transaction counts is ~1.7 GB and hides the thing being measured.
function lazyClient(transactionsPerBlock, head) {
  const digest = (label) => keccak256(Buffer.from(label, "utf8"));
  const blockHash = (number) => digest(`block:${number}`);
  const txHash = (number, index) => digest(`tx:${number}:${index}`);
  const transactions = (number) => Array.from({ length: transactionsPerBlock }, (_, index) => txHash(number, index));
  return {
    async getChainId() { return 8453; },
    async getBlockNumber() { return Number(head); },
    async getBlock(number) {
      return { number: Number(number), hash: blockHash(Number(number)),
        parentHash: blockHash(Number(number) - 1), timestamp: 1_700_000_000 + Number(number) * 2,
        transactions: transactions(Number(number)) };
    },
    async getBlockHeader(number) {
      return { number: toQuantity(Number(number)), hash: blockHash(Number(number)),
        parentHash: blockHash(Number(number) - 1), timestamp: toQuantity(1_700_000_000 + Number(number) * 2),
        transactions: transactions(Number(number)) };
    },
    async getBlockTransactionCount(number) { return toQuantity(transactionsPerBlock); },
    async getBlockReceipts(number) {
      return Array.from({ length: transactionsPerBlock }, (_, index) => ({
        status: "0x1", transactionHash: txHash(Number(number), index),
        blockNumber: toQuantity(Number(number)), blockHash: blockHash(Number(number)), logs: [],
      }));
    },
    async getTransactionReceipt() { return null; },
    async getTransaction() { return null; },
  };
}

function parseArgs(argv) {
  const args = { blocks: 5_000, tx: 150, concurrency: 64, adapter: "../packages/server/src/gate/base-settlement-adapter" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--blocks") { args.blocks = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--tx") { args.tx = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--concurrency") { args.concurrency = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--adapter") { args.adapter = argv[index + 1]; index += 1; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { createBaseSettlementAdapter } = require(args.adapter);
  const from = 1_000n;
  const through = from + BigInt(args.blocks) - 1n;
  const base = lazyClient(args.tx, through + 1n);

  let inFlight = 0;
  let peakInFlight = 0;
  const tracked = {};
  for (const method of ["getBlock", "getBlockHeader", "getBlockTransactionCount", "getBlockReceipts"]) {
    const original = base[method].bind(base);
    tracked[method] = async (...rest) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        // Yield to the macrotask queue so this models real I/O and so the memory sampler, which
        // is a timer, actually gets to run instead of being starved by a microtask-only chain.
        await new Promise((resolve) => { setImmediate(resolve); });
        return await original(...rest);
      } finally { inFlight -= 1; }
    };
  }
  const client = { ...base, ...tracked };

  if (global.gc) global.gc();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  // Sample aggressively: the scan's transient peak is short-lived.
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeap = Math.max(peakHeap, usage.heapUsed);
  }, 2);

  const adapter = createBaseSettlementAdapter({ client, chainId: 8453, splitter: SPLITTER,
    maxBlockRange: 200_000, rpcTimeoutMs: 60_000,
    ...(args.adapter.includes("main") ? {} : { scanConcurrency: args.concurrency }) });
  const started = Date.now();
  const result = await adapter.scanRange({ fromBlock: from, throughBlock: through });
  const elapsedMs = Date.now() - started;
  clearInterval(sampler);

  const mb = (bytes) => Math.round(bytes / 1e6);
  process.stdout.write(`${JSON.stringify({
    adapter: args.adapter,
    blocks: result.canonicalBlocks.length,
    transactionsPerBlock: args.tx,
    configuredConcurrency: args.concurrency,
    peakInFlightRpcs: peakInFlight,
    baselineHeapMB: mb(baseline.heapUsed),
    peakHeapMB: mb(peakHeap),
    peakHeapDeltaMB: mb(peakHeap - baseline.heapUsed),
    baselineRssMB: mb(baseline.rss),
    peakRssMB: mb(peakRss),
    retainedBlockKeys: Object.keys(result.canonicalBlocks[0]).sort(),
    elapsedMs,
  }, null, 2)}\n`);
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
