# Gavel Gate — Base settlement scanner RPC shape

How `BaseSettlementAdapter.scanRange()` spends RPC calls, why every block still costs the same
logical reads it always has, and what an operator can tune.

## Summary

The scanner's **evidence and trust model are unchanged**. It performs the same logical JSON-RPC
reads it always has — `3N + 3` for an `N`-block range — and settlement discovery still rests
entirely on block receipts.

What changed is **transport**. Those reads used to be issued one at a time, so an `N`-block range
cost `3N + 3` serialized network round trips. They are now issued with bounded concurrency, which
lets the provider transport coalesce them into JSON-RPC batches. A 5,000-block backfill goes from
**15,003 round trips and ~5 minutes** to **240 round trips and a few seconds**.

**This is not an asymptotic improvement in RPC method count, and it is not claimed as one.**
Logical calls remain O(N). Round trips fall by roughly two orders of magnitude.

## Logical reads per scan — unchanged

| RPC | Count | Why it is load-bearing |
| --- | --- | --- |
| `eth_chainId` | 1 | chain identity is verified, never assumed from config |
| `eth_getBlockByNumber(n, false)` | 1 per block | canonical coverage: hash, parentHash, timestamp, transaction set |
| `eth_getBlockTransactionCountByNumber` | 1 per block | **independent** cross-check that the receipt set is not truncated |
| `eth_getBlockReceipts` | 1 per block | the authoritative source of settlement logs |
| `eth_getBlockByNumber` (boundaries) | 2 | detects a canonical rewrite during the scan |

Total: `3N + 3`, identical to the sequential scanner.

`eth_getBlockTransactionCountByNumber` looks redundant against the receipt set's own transaction
hashes, but it is a *separate* RPC method answering from a *separate* index. It is retained
deliberately: proving it removable is a semantics argument, not a performance one.

## Why every block still needs a header

`gate.record_scanner_range` (`packages/server/migrations/001_gate.sql`) requires

```sql
jsonb_array_length(p_metadata->'canonicalBlocks') <> p_through-p_from+1
  -> 'scanner result does not completely describe its canonical range'
```

then walks that array asserting `parentHash` chaining block by block, and finally that every block
from the deployment block through the checkpoint exists. `store-memory.js` enforces the same.
Contiguous coverage — which is what capacity release consumes — cannot be proven with fewer
headers. **This is a hard floor, not a tuning choice.**

`eth_getBlockByNumber(n, false)` returns everything needed — hash, parentHash, timestamp and the
transaction hash set — in one call.

### Why headers are read with a raw `send`

`provider.getBlock()` routes through `AbstractProvider`'s request cache (`#perform`,
`cacheTimeout` 250 ms). The scanner re-reads both range boundaries *after* the scan specifically
to detect a canonical rewrite that happened during it. Now that a scan can finish in well under
250 ms, that re-read would be answered from cache and the check would silently stop detecting
anything. A raw `provider.send` bypasses the cache while still going through the batching queue.

## Receipts are authoritative

Settlement discovery consults **only** block receipts. The default scanner does not call
`eth_getLogs` and does not read a header's `logsBloom`.

That is a deliberate trust decision, not an oversight. An earlier revision of this work used
`eth_getLogs` plus header `logsBloom` to skip receipt reads for blocks the bloom said were empty.
It was rejected because it changes the trust model: go-ethereum's log filter selects candidate
blocks using those same header blooms, so a corrupted or inconsistent bloom index would hide a
settlement from the bloom gate **and** from `eth_getLogs`, consistently and undetectably. Sampled
auditing gives probabilistic detection, not semantic equivalence, and capacity release is not a
place for probabilistic evidence.

The guarantee this restores, and which the regression suite pins directly:

> A settlement cannot be hidden because a header bloom is wrong, an RPC log index is incomplete,
> or `eth_getLogs` omits it.

Tests corrupt each of those channels — empty `getLogs`, all-zero blooms on every header,
malformed and throwing `getLogs`, and a `getLogs` that both invents a settlement and hides a real
one — and assert that receipt-derived discovery is unaffected in every case.

The bloom/`getLogs` design is a separate future backlog item. It is not present in this code;
its history is in commits `7f62311` and `1bd050e` on this branch.

## Measured

Synthetic ranges driven through a real `ethers` `JsonRpcProvider` whose transport adds a fixed
delay per HTTP payload (`scripts/scanner-transport-benchmark.js --latency 20`). Each adapter runs
in the provider configuration it was written for: the sequential baseline against a non-batching
provider, so it is not charged ethers' 10 ms batch drain stall that a real sequential HTTP client
never pays. (`--unfair` reproduces that mis-measurement, which inflated an earlier version of
these numbers.)

**Sparse 5,000-block range, 20 ms per round trip, concurrency 64:**

| | A. logical RPC calls | B. HTTP round trips | Elapsed |
| --- | --- | --- | --- |
| before — sequential, non-batching provider | 15,003 | 15,003 | 321,529 ms |
| after — concurrency 64, non-batching provider | 15,003 | 15,003 | 5,374 ms |
| after — concurrency 64, batching provider | 15,003 | 240 | 7,677 ms |

Logical calls are **identical**. Round trips fall 62x with batching. Wall clock falls ~60x.

### Where the win comes from

**Concurrency, not batching.** Sixty-four in-flight requests is what collapses wall-clock time;
at 20 ms latency, concurrency alone is actually *faster* than concurrency plus batching, because
ethers charges each batch drain a 10 ms stall.

Batching is a separate lever with a different payoff: it cuts the number of requests the provider
actually receives by ~62x, which is what matters for rate limits, quotas and per-request billing.
It also becomes a wall-clock win once provider latency rises above the stall.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAVEL_GATE_SETTLEMENT_SCAN_CONCURRENCY` | 64 | in-flight RPCs per scan phase; max 256. Transport only — the same reads happen either way. |
| `GAVEL_GATE_BASE_RPC_BATCH_MAX_COUNT` | 100 | JSON-RPC batch width. Set to `1` for a provider that rejects batched payloads. |

Lower the concurrency for rate-limited providers. Keep `BATCH_MAX_COUNT >= SCAN_CONCURRENCY` to
get one round trip per wave.

## Resource bounds

Measured with `scripts/scanner-memory-probe.js` over a 5,000-block range at 150 transactions per
block, against a lazily generated chain so the figure is the scanner's own retention:

| | peak in-flight RPCs | peak heap delta |
| --- | --- | --- |
| before | 1 | 93 MB |
| after | 64 | 36 MB |

Concurrency is bounded by an explicit lane pool, so a scan never creates an unbounded promise set
however wide the range. Peak memory is *lower* than the sequential scanner despite 64x the
in-flight requests, because per-block transaction sets are retained as a digest of their canonical
sorted form rather than as the full hash array. The receipt cross-check compares the same sorted
canonical string either way, so the check is unchanged.

## Client contract

`createRpcClient` must provide `getBlockHeader(number)` — a raw `eth_getBlockByNumber(n, false)`,
for the cache reason above. The adapter fails fast at construction if it is missing.

Block tags are encoded with `toQuantity`, not `toBeHex`: JSON-RPC `QUANTITY` forbids leading zeros
and go-ethereum rejects them, while `toBeHex` pads to whole bytes (`0x02255100` for a 7-nibble
Base height).

Batching is a plain ethers `JsonRpcProvider` behaviour (`batchStallTime` 10 ms, `batchMaxCount`
100), with no negotiation and no fallback. A provider that rejects batched payloads or caps them
below the scan concurrency will fail every scan identically until
`GAVEL_GATE_BASE_RPC_BATCH_MAX_COUNT` is lowered.

## Observability

Metrics report **logical JSON-RPC method calls**, never HTTP requests — ethers does not expose
round-trip counts, so that figure is benchmark-only rather than an invented runtime metric.

| Metric | Type | Meaning |
| --- | --- | --- |
| `gate_scanner_rpc_method_calls_total{method}` | counter | logical method calls, split into `headers` / `receipts` / `log_queries` / `other`; the parts sum to the total |
| `gate_scanner_range_blocks` | gauge | blocks in the scanned range |
| `gate_scanner_relevant_logs` | gauge | matching logs found in receipts |
| `gate_scanner_elapsed_milliseconds` | gauge | scan wall-clock time |
| `gate_scanner_concurrency` | gauge | configured in-flight bound |

`log_queries` is always zero on the default path and exists so the series does not change shape if
supplemental log querying is ever added.

## Known follow-up, not addressed here

The worker scheduler retries a failed `scanOnce` every `pollIntervalMs` with no backoff or jitter
(`runtime.js`). Sequential RPC used to throttle that accidentally; concurrent reads remove the
brake. Adding exponential backoff to the job scheduler is worth doing but sits outside the
scanner/adapter and is deliberately left out of this change.

## Rollback

Revert the commits. There is no schema change, no migration, and no persisted-format change:
`canonicalBlocks` is written with the same four fields as before, so ranges recorded by this
scanner and by the previous one are interchangeable and generation/replay comparisons are
unaffected. A rolled-back deployment keeps the extra `getBlockHeader` client method harmlessly
unused.
