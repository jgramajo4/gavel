// Regression matrix for the optimized BaseSettlementAdapter.scanRange() discovery path.
//
// The optimization replaces per-block receipt enumeration with one strictly filtered
// eth_getLogs plus header-logsBloom gating. These tests pin BOTH halves of that claim:
// the RPC call shape (explicit call-count assertions, including a 5,000-block range that
// must no longer be O(5,000) receipt reads) and the semantics that must not move
// (exact-log acceptance, canonical ancestry, reorg handling, and the canonical no-match
// evidence that capacity release consumes).
const assert = require("node:assert/strict");
const test = require("node:test");
const { QUOTE_SETTLED_TOPIC } = require("@gavel/gate");
const { createBaseSettlementAdapter } = require("../src/gate/base-settlement-adapter");
const { logsBloomMayContain, logsBloomMayContainEvent } = require("../src/gate/logs-bloom");
const { createSyntheticChain, createCountingClient, bloomAdd, bloomHex, rawLog, digest } = require("./support/base-rpc-mock");

const A = (digit) => `0x${digit.repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const SPLITTER = A("3");
const OTHER_CONTRACT = A("7");
const UNRELATED_TOPIC = H("e");

function settlement(block, quoteNonce, extra = {}) {
  return { block: BigInt(block), quoteId: H(quoteNonce), payer: A("1"), voter: A("2"),
    attentionAmount: 1_000_000n, gavelRecipient: A("4"), token: A("5"), submissionHash: H("7"), ...extra };
}

function harness({ from = 1_000n, through = 1_010n, settlements = [], noiseLogsPerBlock = 4,
  overrides = {}, clientOptions = {}, options = {}, seed = "gavel" } = {}) {
  const chain = createSyntheticChain({ fromBlock: BigInt(from) - 1n, head: BigInt(through) + 1n,
    splitter: SPLITTER, settlements, noiseLogsPerBlock, noiseTxPerBlock: 2, seed });
  const counting = createCountingClient(chain, { splitter: SPLITTER, overrides, ...clientOptions });
  const adapter = createBaseSettlementAdapter({ client: counting.client, chainId: 8453, splitter: SPLITTER,
    maxBlockRange: 100_000, rpcTimeoutMs: 60_000, ...options });
  return { chain, counting, adapter, scan: () => adapter.scanRange({ fromBlock: BigInt(from), throughBlock: BigInt(through) }) };
}

// Expected header reads: one per block in the range, plus the post-scan boundary re-reads
// (both endpoints, or just the single block when the range is one block wide).
const expectedHeaderCalls = (blocks) => blocks + (blocks > 1 ? 2 : 1);

test("1. an empty range proves contiguous canonical coverage without reading a single receipt", async () => {
  const h = harness({ from: 1_000n, through: 1_099n });
  const result = await h.scan();

  assert.equal(result.candidates.length, 0);
  assert.equal(result.anomalies.length, 0);
  // Contiguous coverage: recordScannerRange requires exactly one canonical block per block.
  assert.equal(result.canonicalBlocks.length, 100);
  assert.equal(result.canonicalBlocks[0].blockNumber, "1000");
  assert.equal(result.canonicalBlocks.at(-1).blockNumber, "1099");
  for (let index = 1; index < result.canonicalBlocks.length; index += 1) {
    assert.equal(result.canonicalBlocks[index].parentHash, result.canonicalBlocks[index - 1].blockHash);
  }
  assert.equal(h.counting.calls("eth_chainId"), 1);
  assert.equal(h.counting.calls("eth_getLogs"), 1);
  assert.equal(h.counting.calls("eth_getBlockByNumber"), expectedHeaderCalls(100));
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 0);
  assert.equal(h.counting.calls("eth_getBlockTransactionCountByNumber"), 0);
  assert.equal(h.counting.calls("eth_getTransactionReceipt"), 0);
});

test("2. a single settlement log is accepted from canonical receipts, reading only its own block", async () => {
  const h = harness({ from: 1_000n, through: 1_099n, settlements: [settlement(1_042n, "6")] });
  const result = await h.scan();

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].quoteId, H("6"));
  assert.equal(result.candidates[0].receiptBlock, "1042");
  assert.equal(result.canonicalBlocks.length, 100);
  // Exactly one block was receipt-enumerated: the one whose header bloom admitted the event.
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 1);
  assert.equal(h.counting.calls("eth_getBlockTransactionCountByNumber"), 1);
  assert.equal(h.counting.calls("eth_getLogs"), 1);
});

test("3. multiple settlement logs in one block are all accepted from a single receipt read", async () => {
  const h = harness({ from: 1_000n, through: 1_049n,
    settlements: [settlement(1_020n, "6"), settlement(1_020n, "b"), settlement(1_020n, "c")] });
  const result = await h.scan();

  assert.deepEqual(result.candidates.map((item) => item.quoteId).sort(), [H("6"), H("b"), H("c")]);
  assert.equal(new Set(result.candidates.map((item) => item.logIndex)).size, 3);
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 1);
});

test("4. settlement logs spread across blocks read exactly one receipt set per relevant block", async () => {
  const h = harness({ from: 1_000n, through: 1_099n,
    settlements: [settlement(1_005n, "6"), settlement(1_050n, "b"), settlement(1_099n, "c")] });
  const result = await h.scan();

  assert.deepEqual(result.candidates.map((item) => item.receiptBlock), ["1005", "1050", "1099"]);
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 3);
  assert.equal(result.rpcStats.relevantBlocks, 3);
});

test("5. a duplicated eth_getLogs entry is idempotent, and a conflicting duplicate fails closed", async () => {
  const base = harness({ settlements: [settlement(1_005n, "6")] });
  const original = await base.adapter.scanRange({ fromBlock: 1_000n, throughBlock: 1_010n });
  assert.equal(original.candidates.length, 1);

  const duplicated = harness({ settlements: [settlement(1_005n, "6")],
    overrides: { async getLogs(filter) { const logs = await base.counting.client.getLogs(filter); return [...logs, ...logs]; } } });
  const result = await duplicated.scan();
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].event, original.candidates[0].event);

  const conflicting = harness({ settlements: [settlement(1_005n, "6")],
    overrides: { async getLogs(filter) {
      const logs = await base.counting.client.getLogs(filter);
      return [...logs, { ...logs[0], data: `0x${"1".repeat(320)}` }];
    } } });
  await assert.rejects(conflicting.scan(), /conflicting duplicate logs/i);
});

test("6. a structurally malformed discovery result aborts the range instead of being ignored", async () => {
  const h = harness({ settlements: [settlement(1_005n, "6")],
    overrides: { async getLogs() { return [{ address: SPLITTER, topics: [QUOTE_SETTLED_TOPIC], data: "0x" }]; } } });
  await assert.rejects(h.scan(), /log discovery result is incomplete/i);

  const notAnArray = harness({ overrides: { async getLogs() { return null; } } });
  await assert.rejects(notAnArray.scan(), /log discovery result is incomplete/i);
});

test("7. a discovery result naming another contract fails closed rather than broadening matching", async () => {
  const source = harness({ settlements: [settlement(1_005n, "6")] });
  const logs = await source.counting.client.getLogs({ fromBlock: 1_000n, toBlock: 1_010n,
    address: SPLITTER, topics: [QUOTE_SETTLED_TOPIC] });
  const h = harness({ settlements: [settlement(1_005n, "6")],
    overrides: { async getLogs() { return [{ ...logs[0], address: OTHER_CONTRACT }]; } } });
  await assert.rejects(h.scan(), /from another contract/i);
});

test("8. a discovery result carrying another event topic fails closed", async () => {
  const source = harness({ settlements: [settlement(1_005n, "6")] });
  const logs = await source.counting.client.getLogs({ fromBlock: 1_000n, toBlock: 1_010n,
    address: SPLITTER, topics: [QUOTE_SETTLED_TOPIC] });
  const h = harness({ settlements: [settlement(1_005n, "6")],
    overrides: { async getLogs() { return [{ ...logs[0], topics: [UNRELATED_TOPIC, ...logs[0].topics.slice(1)] }]; } } });
  await assert.rejects(h.scan(), /unrelated event topic/i);
});

test("9. a chain identity mismatch aborts before any discovery or header work", async () => {
  const h = harness({ overrides: { async getChainId() { return 1; } } });
  await assert.rejects(h.scan(), /RPC chain 1 does not match configured chain 8453/);
  assert.equal(h.counting.calls("eth_getLogs"), 0);
  assert.equal(h.counting.calls("eth_getBlockByNumber"), 0);
});

test("10. an overlap re-scan of the same span reproduces identical evidence", async () => {
  const settlements = [settlement(1_005n, "6")];
  const first = harness({ from: 1_000n, through: 1_063n, settlements });
  const firstResult = await first.scan();
  // The overlap window re-covers an already-scanned span; the adapter is a pure function of
  // the chain, so the second pass must produce byte-identical canonical evidence.
  const second = harness({ from: 1_000n, through: 1_063n, settlements });
  const secondResult = await second.scan();

  assert.deepEqual(secondResult.canonicalBlocks, firstResult.canonicalBlocks);
  assert.deepEqual(secondResult.candidates, firstResult.candidates);
  assert.equal(secondResult.candidates.length, 1);
});

test("11. a canonical rewrite at a range boundary during the scan aborts the checkpoint", async () => {
  let headerReads = 0;
  const h = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockHeader(number) {
      headerReads += 1;
      const header = await createCountingClient(h.chain).client.getBlockHeader(number);
      // The post-scan boundary re-read observes a different canonical hash.
      if (headerReads > 10 && Number(number) === 1_000) return { ...header, hash: H("b") };
      return header;
    } } });
  await assert.rejects(h.scan(), /canonical boundary changed during scan/i);
});

test("12. a reorged header whose parent linkage mixes forks aborts the range", async () => {
  const h = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockHeader(number) {
      const header = await createCountingClient(h.chain).client.getBlockHeader(number);
      return Number(number) === 1_005 ? { ...header, parentHash: H("f") } : header;
    } } });
  await assert.rejects(h.scan(), /parent ancestry is inconsistent/i);
});

test("13. a previously observed exact log that a reorg removes simply stops being observed", async () => {
  const before = harness({ from: 1_000n, through: 1_009n, settlements: [settlement(1_005n, "6")] });
  const observed = await before.scan();
  assert.equal(observed.candidates.length, 1);

  // Same span, rewritten canonical chain (different seed => different hashes) with no settlement.
  const after = harness({ from: 1_000n, through: 1_009n, settlements: [], seed: "reorged" });
  const rescanned = await after.scan();
  assert.equal(rescanned.candidates.length, 0);
  assert.equal(rescanned.canonicalBlocks.length, 10);
  // The disappearance is expressed as canonical no-match coverage of the same span, which is
  // exactly what recordScannerRange consumes to detect a pre/post-acceptance reorg.
  assert.notEqual(rescanned.canonicalBlocks[5].blockHash, observed.canonicalBlocks[5].blockHash);
});

test("14. every scan returns full-span canonical evidence, so generation semantics are unchanged", async () => {
  for (const settlements of [[], [settlement(1_005n, "6")]]) {
    const h = harness({ from: 1_000n, through: 1_009n, settlements });
    const result = await h.scan();
    assert.equal(result.canonicalBlocks.length, 10);
    assert.deepEqual(Object.keys(result.canonicalBlocks[0]).sort(),
      ["blockHash", "blockNumber", "blockTimestamp", "parentHash"]);
  }
});

test("15. an empty discovery result over a bloom-negative span is canonical no-match coverage", async () => {
  const h = harness({ from: 1_000n, through: 1_049n });
  const result = await h.scan();

  assert.equal(result.candidates.length, 0);
  assert.equal(result.canonicalBlocks.length, 50);
  // No receipt was read, because every header's own logsBloom PROVED the absence of the event.
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 0);
  for (const block of h.chain.blocks.values()) {
    if (block.number < 1_000n || block.number > 1_049n) continue;
    assert.equal(logsBloomMayContainEvent(block.logsBloom, SPLITTER, QUOTE_SETTLED_TOPIC), false);
  }
});

test("16. an empty discovery result NEVER stands in for canonical evidence a bloom-positive block owes", async () => {
  // The chain really does contain a settlement; the provider's eth_getLogs hides it. The block's
  // own header bloom still forces the receipt read, so the log is found and capacity is not released.
  const h = harness({ from: 1_000n, through: 1_049n, settlements: [settlement(1_020n, "6")],
    overrides: { async getLogs() { return []; } } });
  const result = await h.scan();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].quoteId, H("6"));
  assert.equal(result.rpcStats.discoveryOmissions, 1);

  // And a provider that ALSO hides it from the receipts cannot produce a no-match range: the
  // bloom-positive block's receipt set no longer describes its own transactions, so the scan aborts.
  const hidden = harness({ from: 1_000n, through: 1_049n, settlements: [settlement(1_020n, "6")],
    overrides: { async getLogs() { return []; },
      async getBlockReceipts(number) { return Number(number) === 1_020 ? [] : h.chain.blocks.get(String(number)).receipts; } } });
  await assert.rejects(hidden.scan(), /receipt count RPC result is incomplete/i);

  // A header bloom that denies a log the receipts contain is a contradiction, not a no-match proof.
  const lyingBloom = harness({ from: 1_000n, through: 1_049n, settlements: [settlement(1_020n, "6")],
    overrides: { async getBlockHeader(number) {
      const header = await createCountingClient(lyingBloom.chain).client.getBlockHeader(number);
      return Number(number) === 1_020 ? { ...header, logsBloom: `0x${"00".repeat(256)}` } : header;
    } } });
  await assert.rejects(lyingBloom.scan(), /header contradicts settlement log discovery/i);
});

test("17. logs returned out of order are ordered by the chain, not by the provider's response", async () => {
  const settlements = [settlement(1_005n, "6"), settlement(1_005n, "b"), settlement(1_030n, "c"), settlement(1_012n, "d")];
  const ordered = harness({ from: 1_000n, through: 1_049n, settlements });
  const expected = await ordered.scan();

  const shuffled = harness({ from: 1_000n, through: 1_049n, settlements,
    overrides: { async getLogs(filter) {
      const logs = await createCountingClient(shuffled.chain).client.getLogs(filter);
      return [...logs].reverse();
    } } });
  const result = await shuffled.scan();

  assert.deepEqual(result.candidates.map((item) => `${item.receiptBlock}:${item.logIndex}`),
    expected.candidates.map((item) => `${item.receiptBlock}:${item.logIndex}`));
  assert.deepEqual(result.candidates.map((item) => item.receiptBlock), ["1005", "1005", "1012", "1030"]);
});

test("18. concurrent header responses are associated by request, not by arrival order", async () => {
  const outOfOrder = harness({ from: 1_000n, through: 1_049n,
    overrides: { async getBlockHeader(number) {
      const header = await createCountingClient(outOfOrder.chain).client.getBlockHeader(number);
      // Later blocks resolve first, so arrival order is the reverse of request order.
      await new Promise((resolve) => { setTimeout(resolve, Math.max(0, 1_050 - Number(number)) % 7); });
      return header;
    } } });
  const result = await outOfOrder.scan();
  assert.equal(result.canonicalBlocks.length, 50);
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

test("19. a missing entry in a batched header response aborts instead of leaving a coverage hole", async () => {
  for (const missing of [null, undefined]) {
    const h = harness({ from: 1_000n, through: 1_009n,
      overrides: { async getBlockHeader(number) {
        if (Number(number) === 1_004) return missing;
        return createCountingClient(h.chain).client.getBlockHeader(number);
      } } });
    await assert.rejects(h.scan(), /canonical block unavailable/i);
  }

  const truncated = harness({ from: 1_000n, through: 1_009n,
    overrides: { async getBlockHeader(number) {
      const header = await createCountingClient(truncated.chain).client.getBlockHeader(number);
      return Number(number) === 1_004 ? { ...header, logsBloom: undefined } : header;
    } } });
  await assert.rejects(truncated.scan(), /header is incomplete/i);
});

test("20. a provider eth_getLogs range limit is chunked down, never skipped", async () => {
  const settlements = [settlement(1_005n, "6"), settlement(1_400n, "b"), settlement(1_999n, "c")];
  const h = harness({ from: 1_000n, through: 1_999n, settlements, clientOptions: { logRangeLimit: 100 } });
  const result = await h.scan();

  assert.deepEqual(result.candidates.map((item) => item.receiptBlock), ["1005", "1400", "1999"]);
  assert.equal(result.canonicalBlocks.length, 1_000);
  // The 1,000-block query was halved until the provider accepted it; every sub-range was queried.
  assert.ok(h.counting.calls("eth_getLogs") > 1, "expected the range-limited query to be chunked");
  assert.ok(h.counting.calls("eth_getLogs") < 1_000, "chunking must not degrade to per-block queries");
  assert.equal(result.rpcStats.discoveredLogs, 3);
});

test("21. a non-range provider failure aborts the scan without retrying or skipping a chunk", async () => {
  let queries = 0;
  const rateLimited = harness({ from: 1_000n, through: 1_999n,
    overrides: { async getLogs() { queries += 1; throw new Error("429 Too Many Requests"); } } });
  await assert.rejects(rateLimited.scan(), /log discovery failed for blocks 1000-1999/);
  assert.equal(queries, 1);

  const hung = harness({ from: 1_000n, through: 1_009n, options: { rpcTimeoutMs: 20 },
    overrides: { getLogs() { return new Promise(() => {}); } } });
  await assert.rejects(hung.scan(), /Base RPC getLogs timed out/);

  const hungHeader = harness({ from: 1_000n, through: 1_009n, options: { rpcTimeoutMs: 20 },
    overrides: { getBlockHeader() { return new Promise(() => {}); } } });
  await assert.rejects(hungHeader.scan(), /Base RPC getBlock timed out/);
});

test("22. resuming a later window re-derives the same evidence for the blocks it re-covers", async () => {
  const settlements = [settlement(1_005n, "6"), settlement(1_070n, "b")];
  const first = harness({ from: 1_000n, through: 1_049n, settlements });
  const firstResult = await first.scan();
  assert.deepEqual(firstResult.candidates.map((item) => item.receiptBlock), ["1005"]);

  // Restart: a new adapter resumes from the checkpoint with the standard 64-block overlap.
  const resumed = harness({ from: 1_050n - 64n, through: 1_099n, settlements });
  const resumedResult = await resumed.scan();
  assert.deepEqual(resumedResult.candidates.map((item) => item.receiptBlock), ["1005", "1070"]);
  const overlapped = resumedResult.canonicalBlocks.find((item) => item.blockNumber === "1005");
  const original = firstResult.canonicalBlocks.find((item) => item.blockNumber === "1005");
  assert.deepEqual(overlapped, original);
  const reobserved = resumedResult.candidates.find((item) => item.receiptBlock === "1005");
  assert.deepEqual(reobserved, firstResult.candidates[0]);
});

test("23. accepted settlement evidence is byte-identical to the pre-optimization shape", async () => {
  const h = harness({ from: 1_000n, through: 1_009n, settlements: [settlement(1_005n, "6")] });
  const result = await h.scan();
  const [candidate] = result.candidates;
  const block = h.chain.blocks.get("1005");

  assert.deepEqual(Object.keys(candidate).sort(),
    ["event", "evidence", "logIndex", "quoteId", "receiptBlock", "receiptBlockHash", "receiptBlockTimestamp",
      "settledAt", "txHash"]);
  assert.equal(candidate.quoteId, H("6"));
  assert.equal(candidate.receiptBlock, "1005");
  assert.equal(candidate.receiptBlockHash, block.hash);
  assert.equal(candidate.receiptBlockTimestamp.valueOf(), block.timestamp * 1_000);
  assert.equal(candidate.settledAt.valueOf(), block.timestamp * 1_000);
  assert.deepEqual(candidate.evidence, { chainId: "8453", splitter: SPLITTER, canonical: true,
    scannerVerified: true, oneConfirmation: true, confirmations: 1 });
  assert.deepEqual(candidate.event, { quoteId: H("6"), payer: A("1"), voter: A("2"), attentionAmount: "1000000",
    gavelRecipient: A("4"), gavelFeeAmount: "250000", token: A("5"), submissionHash: H("7") });
});

test("24. a failed settlement transaction stays an anomaly and never becomes release evidence", async () => {
  const h = harness({ from: 1_000n, through: 1_009n, settlements: [settlement(1_005n, "6", { status: 0 })] });
  const result = await h.scan();

  assert.equal(result.candidates.length, 0);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].code, "INVALID_SETTLEMENT_EVIDENCE");
  assert.equal(String(result.anomalies[0].blockNumber), "1005");
  // An anomaly still rides a fully covered canonical range, so the checkpoint stays provable.
  assert.equal(result.canonicalBlocks.length, 10);
});

test("a 5,000-block sparse range is no longer O(blocks) in receipt reads", async () => {
  const h = harness({ from: 1_000n, through: 5_999n, settlements: [settlement(3_000n, "6")] });
  const result = await h.scan();

  assert.equal(result.canonicalBlocks.length, 5_000);
  assert.equal(result.candidates.length, 1);
  // Before: 5,000 eth_getBlockReceipts + 5,000 eth_getBlockTransactionCountByNumber (15,003 total).
  assert.equal(h.counting.calls("eth_getBlockReceipts"), 1);
  assert.equal(h.counting.calls("eth_getBlockTransactionCountByNumber"), 1);
  assert.equal(h.counting.calls("eth_getLogs"), 5);
  assert.equal(h.counting.calls("eth_chainId"), 1);
  assert.equal(h.counting.calls("eth_getBlockByNumber"), expectedHeaderCalls(5_000));
  assert.equal(h.counting.total, 5_010);
  assert.ok(h.counting.total < 15_003 / 2, "the 5,000-block call shape must be far below the 15,003-call baseline");
  assert.equal(result.rpcStats.rpcCalls, 5_010);
  assert.equal(result.rpcStats.headerCalls, 5_002);
  assert.equal(result.rpcStats.receiptCalls, 2);
});

test("the header bloom gate is a proof of absence, never merely a hint", async () => {
  // No false negatives: a bloom built from a log always admits that log's address and topics.
  const bloom = new Uint8Array(256);
  bloomAdd(bloom, SPLITTER);
  bloomAdd(bloom, QUOTE_SETTLED_TOPIC);
  const hex = bloomHex(bloom);
  assert.equal(logsBloomMayContain(hex, SPLITTER), true);
  assert.equal(logsBloomMayContain(hex, QUOTE_SETTLED_TOPIC), true);
  assert.equal(logsBloomMayContainEvent(hex, SPLITTER, QUOTE_SETTLED_TOPIC), true);
  // A bloom that never saw the splitter rejects it.
  assert.equal(logsBloomMayContainEvent(bloomHex(new Uint8Array(256)), SPLITTER, QUOTE_SETTLED_TOPIC), false);
  // And a malformed filter is rejected rather than silently treated as empty.
  assert.throws(() => logsBloomMayContain("0x00", SPLITTER), /logsBloom must be 256 bytes/);
  assert.throws(() => logsBloomMayContain(hex, "not-hex"), /bloom item must be non-empty bytes/);

  // Every synthetic block that holds a settlement is bloom-positive for it.
  const chain = createSyntheticChain({ fromBlock: 999n, head: 1_011n, splitter: SPLITTER,
    settlements: [settlement(1_005n, "6")], noiseLogsPerBlock: 8, noiseTxPerBlock: 2 });
  assert.equal(logsBloomMayContainEvent(chain.blocks.get("1005").logsBloom, SPLITTER, QUOTE_SETTLED_TOPIC), true);
});

test("a log pinned to an orphaned sibling block is dropped, not accepted and not fatal", async () => {
  const h = harness({ from: 1_000n, through: 1_009n, settlements: [settlement(1_005n, "6")],
    overrides: { async getLogs(filter) {
      const logs = await createCountingClient(h.chain).client.getLogs(filter);
      // Same log identity, but reported against a block hash that is not canonical.
      return [...logs, rawLog({ ...logs[0], blockNumber: 1_007, blockHash: digest("orphan"),
        index: 99, transactionHash: digest("orphan-tx"), address: SPLITTER,
        topics: logs[0].topics, data: logs[0].data })];
    } } });
  const result = await h.scan();

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].receiptBlock, "1005");
  assert.equal(result.rpcStats.nonCanonicalLogs, 1);
});
