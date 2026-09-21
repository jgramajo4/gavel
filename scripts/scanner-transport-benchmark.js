#!/usr/bin/env node
// Transport-level before/after benchmark for BaseSettlementAdapter.scanRange().
//
// The call-count benchmark (scanner-rpc-benchmark.js) measures JSON-RPC METHOD calls.
// This one measures what actually costs wall-clock time against a real provider: HTTP
// round trips. It drives a real ethers JsonRpcProvider whose transport is replaced with an
// in-process handler that adds a fixed per-payload latency, so JSON-RPC batching and
// request concurrency are modelled exactly as ethers would perform them over the network.
//
// No network and no transaction broadcasts.
//
//   node scripts/scanner-transport-benchmark.js [--blocks 5000] [--latency 20] [--baseline <path>]
const { JsonRpcProvider, toBeHex } = require("ethers");
const { createSyntheticChain, rawHeader, rawLog, matchingLogs } = require("../packages/server/test/support/base-rpc-mock");
const { QUOTE_SETTLED_TOPIC } = require("@gavel/gate");

const A = (digit) => `0x${digit.repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const SPLITTER = A("3");

function parseArgs(argv) {
  const args = { blocks: 5_000, latency: 20, baseline: null, noise: 6, unfair: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--blocks") { args.blocks = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--latency") { args.latency = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--noise") { args.noise = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--baseline") { args.baseline = argv[index + 1]; index += 1; }
    else if (argv[index] === "--unfair") args.unfair = true;
  }
  return args;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function createProbe(chain, latencyMs, batchMaxCount) {
  const stats = { httpPayloads: 0, jsonRpcCalls: 0, byMethod: {}, batchSizes: [] };
  const block = (tag) => chain.blocks.get(BigInt(tag).toString());
  class ProbeProvider extends JsonRpcProvider {
    async _send(payload) {
      const batch = Array.isArray(payload) ? payload : [payload];
      stats.httpPayloads += 1;
      stats.jsonRpcCalls += batch.length;
      stats.batchSizes.push(batch.length);
      for (const request of batch) stats.byMethod[request.method] = (stats.byMethod[request.method] || 0) + 1;
      // One latency charge per HTTP payload, exactly like a real round trip.
      if (latencyMs > 0) await delay(latencyMs);
      return batch.map(({ method, params, id }) => {
        const ok = (result) => ({ id, jsonrpc: "2.0", result });
        if (method === "eth_chainId") return ok("0x2105");
        if (method === "eth_blockNumber") return ok(toBeHex(chain.last));
        if (method === "eth_getBlockByNumber") {
          const found = block(params[0]);
          if (!found) return { id, jsonrpc: "2.0", error: { code: -32000, message: "unknown block" } };
          const header = rawHeader(found);
          return ok(params[1] ? { ...header, transactions: found.transactions } : header);
        }
        if (method === "eth_getBlockTransactionCountByNumber") return ok(toBeHex(block(params[0]).transactions.length));
        if (method === "eth_getBlockReceipts") return ok(block(params[0]).receipts.map((receipt) => ({
          ...receipt, status: receipt.status ? "0x1" : "0x0", blockNumber: toBeHex(receipt.blockNumber),
          logs: receipt.logs.map(rawLog),
        })));
        if (method === "eth_getLogs") {
          const [filter] = params;
          return ok(matchingLogs(chain, { address: filter.address, topic: filter.topics?.[0] ?? QUOTE_SETTLED_TOPIC,
            fromBlock: BigInt(filter.fromBlock), toBlock: BigInt(filter.toBlock) }).map(rawLog));
        }
        if (method === "eth_getTransactionReceipt") {
          const receipt = chain.receiptsByTx.get(String(params[0]).toLowerCase());
          return ok(receipt ? { ...receipt, status: receipt.status ? "0x1" : "0x0", blockNumber: toBeHex(receipt.blockNumber),
            logs: receipt.logs.map(rawLog) } : null);
        }
        return { id, jsonrpc: "2.0", error: { code: -32601, message: `unexpected ${method}` } };
      });
    }
  }
  // batchMaxCount matters for fairness. ethers only sets stallTime to 0 when batchMaxCount === 1
  // (provider-jsonrpc.js), so a batching-enabled provider charges every payload a 10 ms drain
  // stall -- including the lone requests a sequential adapter issues. Measuring the sequential
  // BEFORE adapter on a batching provider therefore bills it a stall it would never pay against
  // a real HTTP endpoint. Each adapter is run in the provider configuration it is written for,
  // and the cross rows below show the effect in isolation.
  const provider = new ProbeProvider("http://probe.invalid", 8453,
    { staticNetwork: true, ...(batchMaxCount === undefined ? {} : { batchMaxCount }) });
  const client = {
    getChainId: async () => BigInt(await provider.send("eth_chainId", [])).toString(),
    getBlockNumber: async () => Number(await provider.send("eth_blockNumber", [])),
    // Legacy surface, kept so the pre-optimization adapter runs against the same transport.
    getBlock: async (number) => {
      const raw = await provider.send("eth_getBlockByNumber", [toBeHex(number), true]);
      return { ...raw, number: Number(raw.number), timestamp: Number(raw.timestamp) };
    },
    getBlockHeader: (number) => provider.send("eth_getBlockByNumber", [toBeHex(number), false]),
    getLogs: (filter) => provider.send("eth_getLogs", [filter]),
    getBlockTransactionCount: async (number) => Number(await provider.send("eth_getBlockTransactionCountByNumber", [toBeHex(number)])),
    getBlockReceipts: (number) => provider.send("eth_getBlockReceipts", [toBeHex(number)]),
    getTransactionReceipt: (hash) => provider.send("eth_getTransactionReceipt", [hash]),
    getTransaction: (hash) => provider.send("eth_getTransactionByHash", [hash]),
  };
  return { client, stats };
}

async function run(label, factory, chain, { from, through, latency, batchMaxCount }) {
  const { client, stats } = createProbe(chain, latency, batchMaxCount);
  const adapter = factory({ client, chainId: 8453, splitter: SPLITTER, maxBlockRange: 100_000,
    rpcTimeoutMs: 60_000, bloomAuditRate: 0 });
  const started = Date.now();
  const result = await adapter.scanRange({ fromBlock: from, throughBlock: through });
  const elapsedMs = Date.now() - started;
  return {
    label,
    blocks: result.canonicalBlocks.length,
    candidates: result.candidates.length,
    batchMaxCount: batchMaxCount ?? 100,
    jsonRpcCalls: stats.jsonRpcCalls,
    httpRoundTrips: stats.httpPayloads,
    meanBatchSize: Number((stats.jsonRpcCalls / stats.httpPayloads).toFixed(1)),
    byMethod: stats.byMethod,
    elapsedMs,
  };
}

function report(result) {
  process.stdout.write(`\n${result.label}\n`);
  process.stdout.write(`  blocks scanned   : ${result.blocks}  (provider batchMaxCount=${result.batchMaxCount})\n`);
  process.stdout.write(`  candidates       : ${result.candidates}\n`);
  process.stdout.write(`  JSON-RPC calls   : ${result.jsonRpcCalls}\n`);
  for (const [method, calls] of Object.entries(result.byMethod).sort()) {
    process.stdout.write(`    ${method.padEnd(36)}: ${calls}\n`);
  }
  process.stdout.write(`  HTTP round trips : ${result.httpRoundTrips} (mean batch ${result.meanBatchSize})\n`);
  process.stdout.write(`  elapsed          : ${result.elapsedMs} ms\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const from = 1_000n;
  const through = from + BigInt(args.blocks) - 1n;
  const settlements = [{ block: from + 10n, quoteId: H("6"), payer: A("1"), voter: A("2"),
    attentionAmount: 1_000_000n, gavelRecipient: A("4"), token: A("5"), submissionHash: H("7") }];
  process.stdout.write(`range=${args.blocks} blocks  simulated per-round-trip latency=${args.latency} ms\n`);
  for (const [name, list] of [["sparse (no settlements)", []], ["one settlement", settlements]]) {
    const chain = createSyntheticChain({ fromBlock: from - 1n, head: through + 1n, splitter: SPLITTER,
      settlements: list, noiseLogsPerBlock: args.noise, noiseTxPerBlock: 2 });
    process.stdout.write(`\n=== ${name} ===\n`);
    if (args.baseline) {
      const { createBaseSettlementAdapter: before } = require(args.baseline);
      // Fair baseline: a sequential adapter against a non-batching provider pays no drain stall.
      report(await run("BEFORE (per-block receipts, sequential; no batching)", before, chain,
        { from, through, latency: args.latency, batchMaxCount: 1 }));
      if (args.unfair) {
        // Kept behind a flag for reproducing the measurement error this benchmark used to make:
        // ethers only zeroes batchStallTime when batchMaxCount === 1, so a batching provider
        // charges a sequential adapter a 10 ms drain stall on every single-request payload --
        // a cost it would never pay against a real HTTP endpoint.
        report(await run("BEFORE (batching provider -- charges a stall it would not pay in reality)",
          before, chain, { from, through, latency: args.latency }));
      }
    }
    const { createBaseSettlementAdapter } = require("../packages/server/src/gate/base-settlement-adapter");
    report(await run("AFTER  (getLogs + bloom-gated receipts, no batching)", createBaseSettlementAdapter, chain,
      { from, through, latency: args.latency, batchMaxCount: 1 }));
    report(await run("AFTER  (getLogs + bloom-gated receipts, batching provider)", createBaseSettlementAdapter, chain,
      { from, through, latency: args.latency }));
  }
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
