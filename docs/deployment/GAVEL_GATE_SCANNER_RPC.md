# Gavel Gate — Base settlement scanner RPC shape

How `BaseSettlementAdapter.scanRange()` spends RPC calls, why the per-block header read
is not removable, and what an operator can tune.

## Before

Every scanned block cost three sequential RPCs:

| RPC | Per block | Why |
| --- | --- | --- |
| `eth_getBlockByNumber(n, true)` | 1 | hash, parentHash, timestamp, transaction hash set |
| `eth_getBlockTransactionCountByNumber(n)` | 1 | independent check that the receipt set is not truncated |
| `eth_getBlockReceipts(n)` | 1 | enumerate every log to find `QuoteSettled` |

A 5,000-block backfill: **15,003 JSON-RPC calls in 15,003 sequential round trips.**

## After

| RPC | Count | Why |
| --- | --- | --- |
| `eth_chainId` | 1 | chain identity is verified, never assumed from config |
| `eth_getLogs` | `ceil(range / maxLogRange)` | discovery: exact splitter, exact `QuoteSettled` topic0, exact span |
| `eth_getBlockByNumber(n, false)` | 1 per block + 2 boundary re-reads | contiguous canonical coverage (see below) |
| `eth_getBlockTransactionCountByNumber` + `eth_getBlockReceipts` | 2 per **bloom-positive** block | the only source of accepted settlement evidence |
| `eth_getTransactionReceipt` | 0 during a scan | receipts already arrive with the block |

Complexity: `O(1) + O(log query chunks) + O(range) headers + O(bloom-positive blocks)`.

## Why headers are still one per block

`gate.record_scanner_range` (`packages/server/migrations/001_gate.sql`) requires

```sql
jsonb_array_length(p_metadata->'canonicalBlocks') <> p_through-p_from+1
  -> 'scanner result does not completely describe its canonical range'
```

and then walks that array asserting `parentHash` chaining block by block, and finally that
every block from the deployment block through the checkpoint exists. `store-memory.js`
enforces the same. Contiguous coverage — which is what capacity release consumes — therefore
cannot be proven with fewer headers. **This is a hard floor, not a tuning choice.** The win
on this path is round trips, not calls: the header reads are issued with bounded concurrency,
so `JsonRpcProvider` coalesces them into JSON-RPC batches.

`eth_getBlockByNumber(n, false)` returns everything the scanner needs — hash, parentHash,
timestamp, the transaction hash set, and `logsBloom` — in one call, so the old
`(n, true)` read plus a separate transaction-count read are both gone.

## Why an empty `eth_getLogs` is never a release proof

A block header's `logsBloom` is the union of its receipt blooms, and every log contributes
its address and each of its topics. The filter has false positives but **never** false
negatives. So:

- **bloom-negative block** — proven to hold no `QuoteSettled` log from the splitter, using the
  same canonical header evidence the checkpoint already rests on. No receipt read.
- **bloom-positive block** — full canonical receipt enumeration, byte for byte the
  pre-optimization path. The receipt set is authoritative.

`eth_getLogs` is an accelerator and an integrity probe, never evidence:

- a discovered log the receipts do **not** contain → fails closed (injection)
- a discovered log in a bloom-negative block → fails closed (the header contradicts the index)
- a discovered log on a non-canonical block hash → dropped, exactly as the receipt path drops it
- a log the receipts contain that `eth_getLogs` **omitted** → still accepted, because the bloom
  already forced that block's receipts to be read

That last case is the one that matters for `record_scanner_range`'s release predicate: a lossy
log index cannot manufacture canonical no-match coverage.

Worst case (every block bloom-positive) degrades to the previous call shape rather than breaking.

## Measured

Synthetic 5,000-block range driven through a real `ethers` `JsonRpcProvider` whose transport
adds 5 ms per HTTP payload (`scripts/scanner-transport-benchmark.js`):

| | JSON-RPC calls | HTTP round trips | Elapsed |
| --- | --- | --- | --- |
| before | 15,003 | 15,003 | 231,870 ms |
| after | 5,008 | 87 | 1,520 ms |

**2.99x fewer calls, 172x fewer round trips, 152x faster.**

Bloom false-positive rate rises with log density per block (measured over 2,000 blocks):

| logs/block | bloom-positive blocks | total calls |
| --- | --- | --- |
| ~50 | 1 (0.05%) | 2,007 |
| ~150 | 24 (1.2%) | 2,053 |
| ~300 | 324 (16%) | 2,653 |

Even at 16% fallback the scan stays well under the 6,003-call baseline for that range.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAVEL_GATE_SETTLEMENT_MAX_LOG_RANGE` | 1000 | starting `eth_getLogs` span; clamped to `MAX_BLOCK_RANGE`. Lower it for providers with tight log caps. |
| `GAVEL_GATE_SETTLEMENT_HEADER_CONCURRENCY` | 64 | in-flight header reads; max 256. Lower it for rate-limited providers, raise it to fill a larger provider batch. |

A span a provider rejects for width or result count is halved recursively until it is accepted;
a chunk is never skipped. Errors that are not range limits abort the scan without retrying, and
the worker retries the whole range on its next tick.

## Client contract

`createRpcClient` must provide `getBlockHeader(number)` (raw `eth_getBlockByNumber(n, false)`,
because ethers' `Block` does not expose `logsBloom`) and `getLogs(filter)`. The adapter fails
fast at construction if either is missing, and fails closed mid-scan if a header arrives without
a well-formed 256-byte `logsBloom` — it never silently falls back to trusting `eth_getLogs`.

## Rollback

Revert the commit. There is no schema change, no migration, and no persisted-format change:
`canonicalBlocks` is written with the same four fields as before, so ranges recorded by the new
scanner and the old one are interchangeable and generation/replay comparisons are unaffected.
A rolled-back deployment keeps the two extra client methods harmlessly unused.
