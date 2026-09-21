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

- **bloom-negative block** — no `QuoteSettled` log from the splitter, on the strength of the
  same canonical header the checkpoint already rests on. No receipt read.
- **bloom-positive block** — full canonical receipt enumeration, byte for byte the
  pre-optimization path. The receipt set is authoritative.

### The residual trust delta — read this before tuning the audit to zero

Be precise about what "never false negatives" buys. That is a property of the **real** header
bloom. Nothing here verifies `keccak256(rlp(header)) == header.hash`, so the `logsBloom` the
scanner reads is **provider-asserted**, not proven. The pre-optimization scanner never read this
field: it enumerated every block's receipts, so a provider's bloom index could not hide anything.

`eth_getLogs` does **not** independently corroborate the bloom. go-ethereum's log filter selects
candidate blocks using those same header blooms (`filters.Filter` → `bloomFilter(header.Bloom, …)`,
and the bloombits index is built from them), so a provider serving a corrupted bloom hides a log
from the bloom gate **and** from `eth_getLogs`, consistently and silently. The cross-check at
"canonical block header contradicts settlement log discovery" only catches a provider that
corrupts the bloom while leaving its log index intact.

That is a real reduction in evidence strength against a faulty or hostile RPC, and it is the one
place this change is not semantically equivalent to its predecessor. Two things bound it:

1. **The bloom audit.** A bounded random sample of bloom-negative blocks is read in full anyway
   (`GAVEL_GATE_SETTLEMENT_BLOOM_AUDIT_RATE`, default 1%, capped at 64 blocks per scan). A
   sampled block whose receipts contain a `QuoteSettled` log aborts the scan — no checkpoint, no
   release. This gives probabilistic detection of a corrupted bloom index, **not a proof**: a
   single wrong block has only a sampling chance of being caught, while systemic corruption is
   caught quickly.
2. **Operator signal.** `gate_scanner_log_discovery_omissions_total` and
   `gate_scanner_non_canonical_logs_total` are the early warning that a provider's log index
   disagrees with its own receipts. A sustained non-zero rate on either warrants investigation.

Deployments that treat the RPC provider as untrusted should raise the audit rate (1.0 restores
the pre-optimization guarantee at the pre-optimization cost) or cross-check against a second
independent provider.

`eth_getLogs` itself is an accelerator and an integrity probe, never evidence:

- a discovered log the receipts do **not** contain → fails closed (injection)
- a discovered log in a bloom-negative block → fails closed (the header contradicts the index)
- a discovered log on a non-canonical block hash → dropped, exactly as the receipt path drops it
- a log the receipts contain that `eth_getLogs` **omitted** → still accepted, because the bloom
  already forced that block's receipts to be read

That last case is the one that matters for `record_scanner_range`'s release predicate: a lossy
log index cannot manufacture canonical no-match coverage.

**Worst case.** If every block is bloom-positive the cost is `3N + chunks + 3`, i.e. the previous
`3N + 3` plus the log queries — marginally *worse* than the code it replaces, not equal to it. A
provider that range-errors on every span would multiply the log queries, so the halving is capped
by an explicit per-scan query budget (`max(64, 8 × chunks)`); beyond it the scan fails closed
rather than degrading further.

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
| `GAVEL_GATE_BASE_RPC_BATCH_MAX_COUNT` | 100 | JSON-RPC batch width. **Must be ≥ header concurrency to get the round-trip win.** Set it to `1` for a provider that rejects batched payloads. |
| `GAVEL_GATE_SETTLEMENT_BLOOM_AUDIT_RATE` | 0.01 | fraction of bloom-negative blocks read in full anyway; `0` disables the audit, `1` restores the pre-optimization guarantee and cost. |

A span a provider rejects **for width or result count** is halved recursively until it is accepted;
a chunk is never skipped, and the total number of log queries per scan is bounded. Rate-limit
shapes are deliberately **not** treated as range errors — splitting a throttled query would
multiply requests at a provider that is already throttling. Errors that are not range limits abort
the scan without retrying, and the worker retries the whole range on its next tick.

### Known follow-up, not addressed here

The worker scheduler retries a failed `scanOnce` every `pollIntervalMs` with no backoff or jitter
(`runtime.js`). Sequential RPC used to throttle that accidentally; concurrent reads remove the
brake. Adding exponential backoff to the job scheduler is worth doing but sits outside the
scanner/adapter and is deliberately left out of this change.

## Client contract

`createRpcClient` must provide `getBlockHeader(number)` (raw `eth_getBlockByNumber(n, false)`,
because ethers' `Block` does not expose `logsBloom`) and `getLogs(filter)`. The adapter fails
fast at construction if either is missing, and fails closed mid-scan if a header arrives without
a well-formed 256-byte `logsBloom` — it never silently falls back to trusting `eth_getLogs`.

Block tags are encoded with `toQuantity`, not `toBeHex`: JSON-RPC `QUANTITY` forbids leading
zeros and go-ethereum rejects them, while `toBeHex` pads to whole bytes (`0x02255100` for a
7-nibble Base height).

Batching is a plain ethers `JsonRpcProvider` behaviour (`batchStallTime` 10 ms, `batchMaxCount`
100), with no negotiation and no fallback. A provider that rejects batched payloads or caps them
below the header concurrency will fail every scan identically until
`GAVEL_GATE_BASE_RPC_BATCH_MAX_COUNT` is lowered.

## Rollback

Revert the commit. There is no schema change, no migration, and no persisted-format change:
`canonicalBlocks` is written with the same four fields as before, so ranges recorded by the new
scanner and the old one are interchangeable and generation/replay comparisons are unaffected.
A rolled-back deployment keeps the two extra client methods harmlessly unused.
