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

**Sparse 5,000-block range, 12 logs/block, 20 ms per round trip, concurrency 64:**

| | A. logical RPC calls | B. HTTP round trips | Elapsed |
| --- | --- | --- | --- |
| before — sequential, non-batching provider | 15,003 | 15,003 | 321,388 ms |
| after — concurrency 64, non-batching provider | 15,003 | 15,003 | 5,423 ms |
| after — concurrency 64, batching provider | 15,003 | 240 | 7,705 ms |

With one settlement present in the same range: 322,264 ms / 5,522 ms / 7,830 ms, same call
shape.

**Dense 1,000-block range, 500 logs/block, 20 ms per round trip, concurrency 64:**

| | A. logical RPC calls | B. HTTP round trips | Elapsed |
| --- | --- | --- | --- |
| before — sequential, non-batching provider | 3,003 | 3,003 | 65,673 ms |
| after — concurrency 64, non-batching provider | 3,003 | 3,003 | 2,086 ms |
| after — concurrency 64, batching provider | 3,003 | 51 | 2,604 ms |

**Logical calls are identical in every row — that is the point.** Round trips fall ~62x with
batching, and wall clock falls ~59x (sparse) and ~31x (dense).

Note that the call shape is `3N + 3` at *any* log density. A scanner that gated receipt reads on
a header bloom would degrade toward the sequential cost as blocks got busier; this one does not
depend on how many logs a block carries.

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

Lower the concurrency for rate-limited providers. `BATCH_MAX_COUNT >= SCAN_CONCURRENCY` gives one
round trip per wave, which is ideal for the header phase — but note that it also makes the receipt
phase send up to `SCAN_CONCURRENCY` blocks' worth of receipts in a single response, which is the
shape most likely to hit a provider's response-size cap or gateway timeout. If receipt batches are
rejected while header batches succeed, lower `BATCH_MAX_COUNT` rather than the concurrency.

## Resource bounds

Measured with `scripts/scanner-memory-probe.js` over a 5,000-block range at 150 transactions per
block, against a lazily generated chain so the figure is the scanner's own retention:

| | peak in-flight RPCs | peak heap delta |
| --- | --- | --- |
| before | 1 | 92–93 MB |
| after | 64 | 34–47 MB (median ~36) |

The `after` figure varies across runs because the 64-lane window is transient and GC timing moves
it; `before` is steady because its retention is durable. The direction and magnitude are not in
doubt, the precision is.

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

Metrics distinguish **logical JSON-RPC method calls** from **actual HTTP payloads**, and never
conflate the two. `JsonRpcProvider` emits one `debug` event with `action: "sendRpcPayload"` per
request it puts on the wire, batched or not, so the round-trip count is a real measurement rather
than an inference.

| Metric | Type | Meaning |
| --- | --- | --- |
| `gate_scanner_rpc_method_calls_total{method}` | counter | logical method calls, split into `headers` / `receipts` / `log_queries` / `other`; the parts sum to the total |
| `gate_scanner_range_blocks` | gauge | blocks in the scanned range |
| `gate_scanner_relevant_logs` | gauge | matching logs found in receipts |
| `gate_scanner_elapsed_milliseconds` | gauge | scan wall-clock time |
| `gate_scanner_concurrency` | gauge | configured in-flight bound (not observed parallelism) |
| `gate_scanner_http_payloads_total` | counter | real HTTP requests put on the wire |

Compare `gate_scanner_http_payloads_total` against `gate_scanner_rpc_method_calls_total` to see
batching working: the ratio is the mean batch size. **This is the only signal that the
optimization is still in effect** — a provider that quietly stops honouring batches, or a
`BATCH_MAX_COUNT=1` set during an incident and forgotten, is invisible in every other metric.

`log_queries` is always zero on the default path and exists so the series does not change shape if
supplemental log querying is ever added.

## Two operational notes about timeouts

**`GAVEL_GATE_BASE_RPC_TIMEOUT_MS` now bounds a batched round trip, not a single request.** With
64 concurrent calls coalesced into one payload, all 64 per-call timers cover the same HTTP round
trip, so the default 10 s must now cover a 64-block receipt batch where it previously covered one
block. The default was deliberately left unchanged, but an operator on a slow provider may need to
raise it, or to lower `BATCH_MAX_COUNT`.

**A timed-out call is abandoned, not cancelled.** `rpcCall` races a timer against the operation
and drops the loser; ethers plumbs no abort signal, and its `FetchRequest` retries a 429 internally
up to 12 times under a 300 s request timeout. So a rate-limited provider leaves each abandoned wave
retrying in the background while the worker restarts the whole scan. This pathology predates this
change, but concurrency multiplies it from one orphaned request at a time to up to
`SCAN_CONCURRENCY`. Lowering `SCAN_CONCURRENCY` is the mitigation until the follow-up below lands.

## Known follow-up, not addressed here

The worker scheduler retries a failed `scanOnce` every `pollIntervalMs` with no backoff or jitter
(`runtime.js`). Sequential RPC used to throttle that accidentally; concurrent reads remove the
brake. Combined with the abandoned-request behaviour above, a rate-limited provider can accumulate
overlapping in-flight waves. Adding exponential backoff to the job scheduler — and an abort path
for abandoned requests — is worth doing but sits outside the scanner/adapter and is deliberately
left out of this change. `runtime.js`'s scheduler is untouched by it.

## What the adapter returns vs. what is persisted

Worth stating explicitly, because two independent reviews of this change got it wrong in opposite
directions. `scanRange()` returns canonical blocks carrying only the four checkpoint fields, and
the previous scanner returned a fifth, `transactionHashes`. **Neither ever reached the database.**
Both stores normalize `canonicalBlocks` to exactly the four fields before building `p_metadata`
(`store.js`'s `recordScannerRange`, and `store-memory.js`'s equivalent), so `scanner_result` JSONB
is byte-identical between the two scanners.

Verified by intercepting the parameter passed to `gate.record_scanner_range`: given block entries
that carry `transactionHashes`, the persisted `p_metadata` contains only
`blockNumber` / `blockHash` / `parentHash` / `blockTimestamp`.

## Rollback

Revert the commits. There is no schema change, no migration, and no persisted-format change:
`canonicalBlocks` is written with the same four fields as before, so ranges recorded by this
scanner and by the previous one are interchangeable and generation/replay comparisons are
unaffected. A rolled-back deployment keeps the extra `getBlockHeader` client method harmlessly
unused.
