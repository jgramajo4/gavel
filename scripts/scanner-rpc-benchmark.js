#!/usr/bin/env node
// Deterministic RPC call-shape benchmark for BaseSettlementAdapter.scanRange().
//
// No network and no transaction broadcasts: it runs the real adapter against the
// synthetic chain in packages/server/test/support/base-rpc-mock.js and reports the
// exact per-method JSON-RPC call counts plus wall-clock time.
//
//   node scripts/scanner-rpc-benchmark.js [--blocks 5000] [--json]
const { createBaseSettlementAdapter } = require("../packages/server/src/gate/base-settlement-adapter");
const { createSyntheticChain, createCountingClient } = require("../packages/server/test/support/base-rpc-mock");

const A = (digit) => `0x${digit.repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const SPLITTER = A("3");
const settlement = (block, nonce) => ({
  block, quoteId: H(nonce), payer: A("1"), voter: A("2"), attentionAmount: 1_000_000n,
  gavelRecipient: A("4"), token: A("5"), submissionHash: H("7"),
});

function parseArgs(argv) {
  const args = { blocks: 5_000, json: false, noiseLogsPerBlock: 6 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--blocks") { args.blocks = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--noise") { args.noiseLogsPerBlock = Number(argv[index + 1]); index += 1; }
    else if (argv[index] === "--json") args.json = true;
  }
  return args;
}

async function scenario(name, { blocks, settlements, noiseLogsPerBlock, adapterOptions = {} }) {
  const from = 1_000n;
  const through = from + BigInt(blocks) - 1n;
  const chain = createSyntheticChain({ fromBlock: from - 1n, head: through + 1n, splitter: SPLITTER,
    settlements, noiseLogsPerBlock, noiseTxPerBlock: 2 });
  const counting = createCountingClient(chain, { splitter: SPLITTER });
  const adapter = createBaseSettlementAdapter({ client: counting.client, chainId: 8453, splitter: SPLITTER,
    maxBlockRange: Math.max(blocks, 5_000), rpcTimeoutMs: 60_000, ...adapterOptions });
  const started = process.hrtime.bigint();
  const result = await adapter.scanRange({ fromBlock: from, throughBlock: through });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    scenario: name,
    rangeBlocks: blocks,
    relevantBlocks: new Set(settlements.map((item) => String(item.block))).size,
    candidates: result.candidates.length,
    anomalies: result.anomalies.length,
    canonicalBlocks: result.canonicalBlocks.length,
    elapsedMs: Number(elapsedMs.toFixed(1)),
    totalRpcCalls: counting.total,
    byMethod: counting.snapshot(),
    ...(result.rpcStats ? { rpcStats: result.rpcStats } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const big = args.blocks;
  const results = [];
  results.push(await scenario("A. sparse/empty range", { blocks: big, settlements: [], noiseLogsPerBlock: args.noiseLogsPerBlock }));
  results.push(await scenario("B. one settlement", { blocks: big, noiseLogsPerBlock: args.noiseLogsPerBlock,
    settlements: [settlement(1_000n + BigInt(Math.floor(big / 2)), "6")] }));
  results.push(await scenario("C. multiple settlements", { blocks: big, noiseLogsPerBlock: args.noiseLogsPerBlock,
    settlements: [settlement(1_010n, "6"), settlement(1_010n, "b"), settlement(1_500n, "c"),
      settlement(1_000n + BigInt(big) - 5n, "d")] }));
  results.push(await scenario("D. overlap re-scan (64 blocks)", { blocks: 64, noiseLogsPerBlock: args.noiseLogsPerBlock,
    settlements: [settlement(1_010n, "6")] }));
  if (args.json) { process.stdout.write(`${JSON.stringify(results, null, 2)}\n`); return; }
  for (const result of results) {
    process.stdout.write(`\n${result.scenario}\n`);
    process.stdout.write(`  range blocks        : ${result.rangeBlocks}\n`);
    process.stdout.write(`  relevant blocks     : ${result.relevantBlocks}\n`);
    process.stdout.write(`  candidates/anomalies: ${result.candidates}/${result.anomalies}\n`);
    process.stdout.write(`  total RPC calls     : ${result.totalRpcCalls}\n`);
    for (const [method, calls] of Object.entries(result.byMethod)) {
      process.stdout.write(`    ${method.padEnd(36)}: ${calls}\n`);
    }
    process.stdout.write(`  elapsed             : ${result.elapsedMs} ms\n`);
    if (result.rpcStats) process.stdout.write(`  adapter rpcStats    : ${JSON.stringify(result.rpcStats)}\n`);
  }
}

main().catch((error) => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
