// Regression matrix for the transport-optimized BaseSettlementAdapter.scanRange().
//
// The optimization is transport-only: the scanner performs exactly the logical reads the
// sequential scanner performed (1 eth_chainId, one header per block, one transaction count and
// one receipt set per block, two boundary re-reads), issued with bounded concurrency so the
// provider can batch them.
//
// These tests pin two things. First, the RESTORED SEMANTIC GUARANTEE: receipts are the sole
// authority for settlement discovery, so no eth_getLogs answer and no header logsBloom -- however
// wrong, incomplete or hostile -- can hide a settlement the receipts contain. Second, the
// logical RPC shape, with explicit call-count assertions showing it is unchanged at 3N+3.
const assert = require("node:assert/strict");
const test = require("node:test");
const { QUOTE_SETTLED_TOPIC } = require("@gavel/gate");
const { createBaseSettlementAdapter } = require("../src/gate/base-settlement-adapter");
const { createSyntheticChain, createCountingClient, bloomHex } = require("./support/base-rpc-mock");

const A = (digit) => `0x${digit.repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const SPLITTER = A("3");

function settlement(block, quoteNonce, extra = {}) {
  return { block: BigInt(block), quoteId: H(quoteNonce), payer: A("1"), voter: A("2"),
    attentionAmount: 1_000_000n, gavelRecipient: A("4"), token: A("5"), submissionHash: H("7"), ...extra };
}

function harness({ from = 1_000n, through = 1_010n, settlements = [], noiseLogsPerBlock = 4,
  overrides = {}, options = {}, seed = "gavel" } = {}) {
  const chain = createSyntheticChain({ fromBlock: BigInt(from) - 1n, head: BigInt(through) + 1n,
    splitter: SPLITTER, settlements, noiseLogsPerBlock, noiseTxPerBlock: 2, seed });
  const counting = createCountingClient(chain, { splitter: SPLITTER, overrides });
  const adapter = createBaseSettlementAdapter({ client: counting.client, chainId: 8453, splitter: SPLITTER,
    maxBlockRange: 100_000, rpcTimeoutMs: 60_000, ...options });
  return { chain, counting, adapter, scan: () => adapter.scanRange({ fromBlock: BigInt(from), throughBlock: BigInt(through) }) };
}

// Logical reads per scan: 1 chainId + N headers + 2 boundary re-reads + 2 receipt calls per block.
const expectedHeaderCalls = (blocks) => blocks + (blocks > 1 ? 2 : 1);
const expectedTotalCalls = (blocks) => 1 + expectedHeaderCalls(blocks) + 2 * blocks;

// A clean chain whose client can be selectively corrupted, for the "receipts are authoritative"
// group. Each override models a provider lying through a channel the scanner must not depend on.
function pristine(from, through, settlements, overrides) {
  return harness({ from, through, settlements, overrides });
}

// ---------------------------------------------------------------------------
// The restored guarantee: nothing about eth_getLogs or logsBloom can hide a settlement.
// ---------------------------------------------------------------------------

test("1. eth_getLogs omitting a real settlement does not hide it from receipt evidence", async () => {
  const h = pristine(1_000n, 1_049n, [settlement(1_020n, "6")], { async getLogs() { return []; } });
  const result = await h.scan();

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].quoteId, H("6"));
  assert.equal(result.candidates[0].receiptBlock, "1020");
  // The scanner never asked in the first place.
  assert.equal(h.counting.calls("eth_getLogs"), 0);
  assert.equal(result.rpcStats.logQueryMethodCalls, 0);
});

test("2. a false-negative header bloom does not hide a settlement the receipts contain", async () => {
  // Every header in the range claims an all-zero bloom, which under a bloom-gated design would
  // "prove" the range empty. The receipt read is unconditional, so the settlement is still found.
  const h = harness({ from: 1_000n, through: 1_049n, settlements: [settlement(1_020n, "6")],
    overrides: { async getBlockHeader(number) {
      const header = await createCountingClient(h.chain).client.getBlockHeader(number);
      return { ...header, logsBloom: bloomHex(new Uint8Array(256)) };
    } } });
  const result = await h.scan();

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].quoteId, H("6"));
  // Receipts were read for every block, not just bloom-positive ones.
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 50);
});

test("3. an empty eth_getLogs result leaves the authoritative receipt scan untouched", async () => {
  const withLogs = harness({ from: 1_000n, through: 1_029n, settlements: [settlement(1_005n, "6"), settlement(1_020n, "b")] });
  const expected = await withLogs.scan();

  const silent = pristine(1_000n, 1_029n, [settlement(1_005n, "6"), settlement(1_020n, "b")],
    { async getLogs() { return []; } });
  const result = await silent.scan();

  assert.deepEqual(result.candidates, expected.candidates);
  assert.deepEqual(result.canonicalBlocks, expected.canonicalBlocks);
  assert.equal(result.candidates.length, 2);
});

test("4. malformed or throwing eth_getLogs cannot suppress receipt-derived evidence", async () => {
  for (const getLogs of [
    async () => { throw new Error("query returned more than 10000 results"); },
    async () => null,
    async () => [{ address: SPLITTER, topics: [QUOTE_SETTLED_TOPIC], data: "0x" }],
    async () => { throw new Error("429 Too Many Requests"); },
  ]) {
    const h = pristine(1_000n, 1_019n, [settlement(1_005n, "6")], { getLogs });
    const result = await h.scan();
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].quoteId, H("6"));
  }
});

test("5. when eth_getLogs and the receipts disagree, the receipts decide", async () => {
  // getLogs invents a settlement that no receipt contains, and hides one that does.
  const fabricated = { address: SPLITTER, topics: [QUOTE_SETTLED_TOPIC, H("c"), H("1"), H("2")],
    data: `0x${"11".repeat(160)}`, blockNumber: "0x3f2", blockHash: H("d"),
    transactionHash: H("e"), logIndex: "0x0" };
  const h = pristine(1_000n, 1_019n, [settlement(1_005n, "6")], { async getLogs() { return [fabricated]; } });
  const result = await h.scan();

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].quoteId, H("6"), "the receipt-backed settlement is the accepted one");
  assert.equal(result.candidates.some((item) => item.quoteId === H("c")), false,
    "a settlement only eth_getLogs claims is never accepted");
});

test("6. reservation release evidence cannot be produced from an absent log alone", async () => {
  // A no-match range is only ever produced when every block's receipts were read and contained
  // nothing. Removing the settlement from the chain entirely is what makes the range empty --
  // silencing eth_getLogs does not.
  const populated = pristine(1_000n, 1_029n, [settlement(1_010n, "6")], { async getLogs() { return []; } });
  const populatedResult = await populated.scan();
  assert.equal(populatedResult.candidates.length, 1, "a real settlement still blocks a no-match range");

  const empty = harness({ from: 1_000n, through: 1_029n, settlements: [] });
  const emptyResult = await empty.scan();
  assert.equal(emptyResult.candidates.length, 0);
  assert.equal(emptyResult.canonicalBlocks.length, 30);
  // The no-match conclusion rests on a receipt read for every single block in the range.
  assert.equal(empty.counting.calls("eth_getBlockReceipts"), 30);
  assert.equal(empty.counting.calls("eth_getBlockTransactionCountByNumber"), 30);
});

test("7. a block whose receipts are incomplete aborts rather than becoming no-match coverage", async () => {
  const h = harness({ from: 1_000n, through: 1_029n, settlements: [settlement(1_010n, "6")],
    overrides: { async getBlockReceipts(number) {
      return Number(number) === 1_010 ? [] : createCountingClient(h.chain).client.getBlockReceipts(number);
    } } });
  await assert.rejects(h.scan(), /receipt count RPC result is incomplete/i);
});

// ---------------------------------------------------------------------------
// Canonical coverage, ancestry, reorg, checkpoint.
// ---------------------------------------------------------------------------

test("8. the canonical block array covers every block in the range, in order and chained", async () => {
  const h = harness({ from: 1_000n, through: 1_099n, settlements: [settlement(1_042n, "6")] });
  const result = await h.scan();

  assert.equal(result.canonicalBlocks.length, 100);
  assert.deepEqual(result.canonicalBlocks.map((item) => Number(item.blockNumber)),
    Array.from({ length: 100 }, (_, index) => 1_000 + index));
  for (let index = 1; index < result.canonicalBlocks.length; index += 1) {
    assert.equal(result.canonicalBlocks[index].parentHash, result.canonicalBlocks[index - 1].blockHash);
  }
  // Exactly the four fields record_scanner_range validates, and nothing else.
  for (const block of result.canonicalBlocks) {
    assert.deepEqual(Object.keys(block).sort(), ["blockHash", "blockNumber", "blockTimestamp", "parentHash"]);
  }
  assert.equal(result.canonicalBlocks.at(-1).blockNumber, "1099");
});

test("9. parent-hash continuity still aborts a range that mixes forks", async () => {
  const h = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockHeader(number) {
      const header = await createCountingClient(h.chain).client.getBlockHeader(number);
      return Number(number) === 1_005 ? { ...header, parentHash: H("f") } : header;
    } } });
  await assert.rejects(h.scan(), /parent ancestry is inconsistent/i);
});

test("10. a boundary rewritten during the scan aborts the checkpoint", async () => {
  let reads = 0;
  const h = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockHeader(number) {
      reads += 1;
      const header = await createCountingClient(h.chain).client.getBlockHeader(number);
      return reads > 10 && Number(number) === 1_000 ? { ...header, hash: H("b") } : header;
    } } });
  await assert.rejects(h.scan(), /canonical boundary changed during scan/i);
});

test("11. the boundary re-read is a real second read, never served from a provider cache", async () => {
  const seen = [];
  const h = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockHeader(number) {
      seen.push(Number(number));
      return createCountingClient(h.chain).client.getBlockHeader(number);
    } } });
  await h.scan();

  // 10 range headers plus both boundaries re-read afterwards.
  assert.equal(seen.length, 12);
  assert.equal(seen.filter((number) => number === 1_000).length, 2);
  assert.equal(seen.filter((number) => number === 1_009).length, 2);
});

test("12. overlap re-scan and post-reorg re-scan behave exactly as before", async () => {
  const settlements = [settlement(1_005n, "6")];
  const first = harness({ from: 1_000n, through: 1_063n, settlements });
  const firstResult = await first.scan();
  const overlap = harness({ from: 1_000n, through: 1_063n, settlements });
  const overlapResult = await overlap.scan();
  assert.deepEqual(overlapResult.canonicalBlocks, firstResult.canonicalBlocks);
  assert.deepEqual(overlapResult.candidates, firstResult.candidates);

  // A rewritten chain over the same span yields full canonical coverage with new hashes and no
  // observation, which is what record_scanner_range consumes to detect the disappearance.
  const reorged = harness({ from: 1_000n, through: 1_063n, settlements: [], seed: "reorged" });
  const reorgedResult = await reorged.scan();
  assert.equal(reorgedResult.candidates.length, 0);
  assert.equal(reorgedResult.canonicalBlocks.length, 64);
  assert.notEqual(reorgedResult.canonicalBlocks[5].blockHash, firstResult.canonicalBlocks[5].blockHash);
});

test("13. exact-log settlement acceptance is unchanged in shape and content", async () => {
  const h = harness({ from: 1_000n, through: 1_009n, settlements: [settlement(1_005n, "6")] });
  const result = await h.scan();
  const [candidate] = result.candidates;
  const block = h.chain.blocks.get("1005");

  assert.deepEqual(Object.keys(candidate).sort(),
    ["event", "evidence", "logIndex", "quoteId", "receiptBlock", "receiptBlockHash", "receiptBlockTimestamp",
      "settledAt", "txHash"]);
  assert.equal(candidate.receiptBlockHash, block.hash);
  assert.equal(candidate.receiptBlockTimestamp.valueOf(), block.timestamp * 1_000);
  assert.deepEqual(candidate.evidence, { chainId: "8453", splitter: SPLITTER, canonical: true,
    scannerVerified: true, oneConfirmation: true, confirmations: 1 });
  assert.deepEqual(candidate.event, { quoteId: H("6"), payer: A("1"), voter: A("2"), attentionAmount: "1000000",
    gavelRecipient: A("4"), gavelFeeAmount: "250000", token: A("5"), submissionHash: H("7") });
});

test("14. a failed settlement transaction is still an anomaly, with a decimal block number", async () => {
  const h = harness({ from: 1_000n, through: 1_009n, settlements: [settlement(1_005n, "6", { status: 0 })] });
  const result = await h.scan();

  assert.equal(result.candidates.length, 0);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].code, "INVALID_SETTLEMENT_EVIDENCE");
  // Receipts carry hex quantities; observations persist as numeric(78,0).
  assert.match(String(result.anomalies[0].blockNumber), /^\d{1,78}$/);
  assert.equal(result.anomalies[0].blockNumber, "1005");
  assert.equal(result.canonicalBlocks.length, 10);
});

// ---------------------------------------------------------------------------
// Transport: concurrency, association, partial responses, bounds.
// ---------------------------------------------------------------------------

test("15. a missing entry in a concurrent response set aborts instead of leaving a coverage hole", async () => {
  for (const missing of [null, undefined]) {
    const h = harness({ from: 1_000n, through: 1_009n,
      overrides: { async getBlockHeader(number) {
        if (Number(number) === 1_004) return missing;
        return createCountingClient(h.chain).client.getBlockHeader(number);
      } } });
    await assert.rejects(h.scan(), /canonical block unavailable/i);
  }

  const noReceipts = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockReceipts(number) {
      return Number(number) === 1_004 ? undefined : createCountingClient(noReceipts.chain).client.getBlockReceipts(number);
    } } });
  await assert.rejects(noReceipts.scan(), /receipt count RPC result is incomplete/i);
});

test("16. out-of-order responses are associated by request, not by arrival", async () => {
  const outOfOrder = harness({ from: 1_000n, through: 1_049n,
    overrides: {
      async getBlockHeader(number) {
        const header = await createCountingClient(outOfOrder.chain).client.getBlockHeader(number);
        // Later blocks resolve first, so arrival order is the reverse of request order.
        await new Promise((resolve) => { setTimeout(resolve, Math.max(0, 1_050 - Number(number)) % 7); });
        return header;
      },
      async getBlockReceipts(number) {
        const receipts = await createCountingClient(outOfOrder.chain).client.getBlockReceipts(number);
        await new Promise((resolve) => { setTimeout(resolve, Number(number) % 5); });
        return receipts;
      },
    } });
  const result = await outOfOrder.scan();

  assert.deepEqual(result.canonicalBlocks.map((item) => Number(item.blockNumber)),
    Array.from({ length: 50 }, (_, index) => 1_000 + index));

  // A response answering with the wrong block is a mis-association and fails closed.
  const mismatched = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockHeader(number) {
      const shifted = Number(number) === 1_005 ? 1_006 : Number(number);
      return createCountingClient(mismatched.chain).client.getBlockHeader(shifted);
    } } });
  await assert.rejects(mismatched.scan(), /canonical block unavailable/i);
});

test("17. settlement ordering follows the chain, not response completion order", async () => {
  const settlements = [settlement(1_005n, "6"), settlement(1_005n, "b"), settlement(1_030n, "c"), settlement(1_012n, "d")];
  const h = harness({ from: 1_000n, through: 1_049n, settlements,
    overrides: { async getBlockReceipts(number) {
      const receipts = await createCountingClient(h.chain).client.getBlockReceipts(number);
      // Earlier blocks answer last.
      await new Promise((resolve) => { setTimeout(resolve, (1_050 - Number(number)) % 11); });
      return receipts;
    } } });
  const result = await h.scan();

  assert.deepEqual(result.candidates.map((item) => item.receiptBlock), ["1005", "1005", "1012", "1030"]);
  assert.deepEqual(result.candidates.map((item) => item.quoteId), [H("6"), H("b"), H("d"), H("c")]);
});

test("18. concurrency is bounded and never exceeds the configured limit", async () => {
  for (const limit of [1, 4, 32]) {
    let inFlight = 0;
    let peak = 0;
    const h = harness({ from: 1_000n, through: 1_199n, options: { scanConcurrency: limit },
      overrides: {
        async getBlockHeader(number) {
          inFlight += 1; peak = Math.max(peak, inFlight);
          try {
            await new Promise((resolve) => { setTimeout(resolve, 1); });
            return await createCountingClient(h.chain).client.getBlockHeader(number);
          } finally { inFlight -= 1; }
        },
        async getBlockReceipts(number) {
          inFlight += 1; peak = Math.max(peak, inFlight);
          try {
            await new Promise((resolve) => { setTimeout(resolve, 1); });
            return await createCountingClient(h.chain).client.getBlockReceipts(number);
          } finally { inFlight -= 1; }
        },
      } });
    const result = await h.scan();
    assert.equal(result.canonicalBlocks.length, 200);
    assert.ok(peak <= limit, `scanConcurrency=${limit} but ${peak} requests were in flight`);
    assert.equal(result.rpcStats.concurrency, limit);
  }

  assert.throws(() => createBaseSettlementAdapter({ client: harness().counting.client, chainId: 8453,
    splitter: SPLITTER, scanConcurrency: 257 }), /scanConcurrency must not exceed 256/);
});

test("19. a concurrent failure reports the lowest-indexed block, matching sequential scan order", async () => {
  // Two blocks are broken. The sequential scanner would have raised the earlier one; concurrency
  // must not make which error surfaces depend on scheduling.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const h = harness({ from: 1_000n, through: 1_049n,
      overrides: { async getBlockHeader(number) {
        const header = await createCountingClient(h.chain).client.getBlockHeader(number);
        if (Number(number) === 1_010) return { ...header, hash: "not-a-hash" };
        if (Number(number) === 1_040) return null;
        return header;
      } } });
    await assert.rejects(h.scan(), /block hash must be bytes32/,
      "the earlier broken block must always be the reported failure");
  }
});

test("20. a chain identity mismatch aborts before any block work", async () => {
  const h = harness({ overrides: { async getChainId() { return 1; } } });
  await assert.rejects(h.scan(), /RPC chain 1 does not match configured chain 8453/);
  assert.equal(h.counting.calls("eth_getBlockByNumber"), 0);
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 0);
});

test("21. hung header or receipt reads time out and abort the range", async () => {
  const hungHeader = harness({ from: 1_000n, through: 1_009n, options: { rpcTimeoutMs: 20 },
    overrides: { getBlockHeader() { return new Promise(() => {}); } } });
  await assert.rejects(hungHeader.scan(), /Base RPC getBlock timed out/);

  const hungReceipts = harness({ from: 1_000n, through: 1_009n, options: { rpcTimeoutMs: 20 },
    overrides: { getBlockReceipts() { return new Promise(() => {}); } } });
  await assert.rejects(hungReceipts.scan(), /Base RPC getBlockReceipts timed out/);
});

// ---------------------------------------------------------------------------
// Logical RPC shape.
// ---------------------------------------------------------------------------

test("22. the logical RPC shape is exactly the sequential scanner's: 1 + (N+2) + 2N", async () => {
  for (const blocks of [1, 10, 100]) {
    const h = harness({ from: 1_000n, through: 1_000n + BigInt(blocks) - 1n });
    const result = await h.scan();

    assert.equal(result.canonicalBlocks.length, blocks);
    assert.equal(h.counting.calls("eth_chainId"), 1);
    assert.equal(h.counting.calls("eth_getBlockByNumber"), expectedHeaderCalls(blocks));
    assert.equal(h.counting.calls("eth_getBlockTransactionCountByNumber"), blocks);
    assert.equal(h.counting.calls("eth_getBlockReceipts"), blocks);
    assert.equal(h.counting.calls("eth_getLogs"), 0);
    assert.equal(h.counting.total, expectedTotalCalls(blocks));
    assert.equal(result.rpcStats.rpcMethodCalls, expectedTotalCalls(blocks));
    assert.equal(result.rpcStats.headerMethodCalls, expectedHeaderCalls(blocks));
    assert.equal(result.rpcStats.receiptMethodCalls, 2 * blocks);
  }
});

test("23. a 5,000-block range performs the full authoritative read set, not a reduced one", async () => {
  const h = harness({ from: 1_000n, through: 5_999n, settlements: [settlement(3_000n, "6")] });
  const result = await h.scan();

  assert.equal(result.canonicalBlocks.length, 5_000);
  assert.equal(result.candidates.length, 1);
  // Deliberately NOT O(relevant blocks): every block is still read authoritatively.
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 5_000);
  assert.equal(h.counting.calls("eth_getBlockTransactionCountByNumber"), 5_000);
  assert.equal(h.counting.calls("eth_getBlockByNumber"), 5_002);
  assert.equal(h.counting.total, 15_003, "the logical call count matches the sequential scanner exactly");
});

test("24. scan RPC stats are not polluted by concurrent monitor work", async () => {
  const h = harness({ from: 1_000n, through: 1_099n, settlements: [settlement(1_050n, "6")] });
  const block = h.chain.blocks.get("1050");
  const monitor = { quoteId: H("6"), receiptBlock: "1050", receiptBlockHash: block.hash,
    txHash: block.receipts.at(-1).transactionHash, logIndex: block.receipts.at(-1).logs[0].index };

  const [scanned] = await Promise.all([
    h.scan(),
    (async () => { for (let round = 0; round < 5; round += 1) await h.adapter.revalidateMonitor(monitor); })(),
  ]);

  assert.equal(scanned.rpcStats.rpcMethodCalls, expectedTotalCalls(100));
  assert.equal(scanned.rpcStats.headerMethodCalls, expectedHeaderCalls(100));
  assert.ok(h.counting.total > scanned.rpcStats.rpcMethodCalls,
    "expected concurrent monitor calls to be counted by the client but not by the scan");
});
