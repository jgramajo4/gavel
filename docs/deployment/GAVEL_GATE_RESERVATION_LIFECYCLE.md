# Gate reservation / capacity lifecycle (main at 591536f)

Investigation snapshot before productionizing scanner-owned release.
This file records the starting state. Implementation must not rewrite it.

## Current states (schema + stores)

`gate.reservation_state`: `active | expiry_pending_reconciliation | released | consumed`

Quote `reservation_state` stays `reserved` until release/consume.

```
issue (atomic with quote)
  → active

wall-clock expiry (markExpired / expired hint paths)
  → expiry_pending_reconciliation
  (quote public expired; capacity still pending)

scanner recordScannerRange / record_scanner_range
  no current exact_log with block_timestamp < quote.expiry
  AND checkpoint timestamp >= quote.expiry
  AND contiguous canonical coverage from deployment through checkpoint
  → released

settle (canonical QuoteSettled, receipt timestamp < expiry)
  from active | expiry_pending_reconciliation | released
  → consumed (final)

post-acceptance reorg
  → consumed stays consumed; private settlement_reorged_at only
```

## Transitions

| From | To | Function | Production caller | Tx | Idempotent | Retry |
| --- | --- | --- | --- | --- | --- | --- |
| (none) | active | `issue` | HTTP quote issuance | yes | unique hash / lock | safe as duplicate resume |
| active | expiry_pending_reconciliation | `markExpired` | runtime job `expire` → `store.markExpired` every `pollIntervalMs` | yes | UPDATE quoted→expired | safe |
| active | expiry_pending_reconciliation | `recordSettlementHint` / `resolveSettlementHint` | HTTP hint + job `reconcile` | yes | state guards | safe |
| expiry_pending_reconciliation | released | `record_scanner_range` via `recordScannerRange` | runtime job `scan` → `settlementService.scanOnce` | yes, with cursor | generation replay returns `released: 0` | safe |
| active / expiry_pending / released | consumed | `settle` | `scanOnce` → `settleDurableObservations` | yes | settled replay returns false | safe |
| consumed | released | forbidden | — | trigger | — | — |

`releaseReservation` is **not** a production caller. Memory store throws
`reservation release is owned by recordScannerRange`. Postgres helper
`gate.release_expired_reservation` still requires persisted scanner coverage;
only tests invoke it.

## Release conditions

1. Unpaid quote expires without settlement → pending, then release after scanner coverage.
2. Abandoned quote → same as expiry.
3. Auth/payment fail before on-chain settle → no reservation, or hint reverse; no consume.
4. Settlement attempt fails before canonical settle → stay pending.
5. Reservation without inbox → only after consume; inbox is same tx as consume.
6. Scanner sees expiry/no match → release.
7. Crash between steps → expire job + scanner cursor resume.
8. Restart with pending rows → same workers; no extra startup sweeper.
9. Duplicate reconciliation → replay `released: 0`.
10. Reorg of accepted settlement → do **not** free capacity.
11. Settlement final after wall-clock expiry → consume (even from released).
12. Delayed scanner observation of pre-expiry log → consume; do not release if current exact_log exists.
13. Manual/test `releaseReservation` must not become an operator path.

## Invariants (unchanged)

Settlement precedence over wall-clock. Consumed is final. Release at most once
semantically. Capacity pending = `active` + `expiry_pending_reconciliation`.
Replicas serialize on `settlement_cursors FOR UPDATE` and reservation state
predicates.

## Missing production path (this slice)

The scanner **does** release inside `record_scanner_range`.
`scanOnce` does **not** return `released`, so `observeWorkerResult("scan")`
never counts releases. No reservation gauges exist.

Do not add a new cron, request-path release, or admin force-release.
