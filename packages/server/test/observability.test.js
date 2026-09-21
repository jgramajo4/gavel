"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createGateObservability } = require("../src/gate/observability");

function parsed(lines) { return lines.map((line) => JSON.parse(line)); }

test("observability emits only allowlisted structured counters, gauges, and alerts", () => {
  const lines = [];
  const telemetry = createGateObservability({
    write(line) { lines.push(line); },
    clock: () => new Date("2026-09-17T12:00:00.000Z"),
  });

  telemetry.counter("gate_quote_issued_total", 1);
  telemetry.counter("gate_quote_rejected_total", 2, { reason: "rate_limited" });
  telemetry.counter("gate_settlement_reorg_total", 1, { phase: "post_acceptance", source: "monitor" });
  telemetry.gauge("gate_dao_freshness_age_seconds", 12.5, { health: "healthy" });
  telemetry.alert({ source: "monitor", code: "FINAL_CHECK_FAILED" });

  assert.deepEqual(parsed(lines), [
    { timestamp: "2026-09-17T12:00:00.000Z", level: "info", type: "counter", name: "gate_quote_issued_total", value: 1 },
    { timestamp: "2026-09-17T12:00:00.000Z", level: "info", type: "counter", name: "gate_quote_rejected_total", value: 2, labels: { reason: "rate_limited" } },
    { timestamp: "2026-09-17T12:00:00.000Z", level: "info", type: "counter", name: "gate_settlement_reorg_total", value: 1, labels: { phase: "post_acceptance", source: "monitor" } },
    { timestamp: "2026-09-17T12:00:00.000Z", level: "info", type: "gauge", name: "gate_dao_freshness_age_seconds", value: 12.5, labels: { health: "healthy" } },
    { timestamp: "2026-09-17T12:00:00.000Z", level: "error", type: "alert", source: "monitor", code: "FINAL_CHECK_FAILED" },
  ]);
});

test("observability rejects unknown names and labels without writing sensitive values", () => {
  const secret = "0x" + "ab".repeat(32);
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });

  assert.throws(() => telemetry.counter("gate_unknown_total", 1), /allowlisted/);
  assert.throws(() => telemetry.counter("gate_quote_rejected_total", 1, { reason: secret }), /allowlisted/);
  assert.throws(() => telemetry.gauge("gate_confirmation_lag_blocks", 1, { txHash: secret }), /labels/);
  assert.throws(() => telemetry.alert({ source: secret, code: secret }), /allowlisted/);
  assert.equal(lines.join(""), "");
});

test("observability sink failures never escape", () => {
  const telemetry = createGateObservability({ write() { throw new Error("disk full with secret"); } });
  assert.doesNotThrow(() => telemetry.counter("gate_inbox_created_total", 1));
  assert.doesNotThrow(() => telemetry.alert({ source: "monitor", code: "FINAL_CHECK_FAILED" }));
});

test("observability consumes asynchronous sink rejection", async () => {
  let unhandled;
  const listener = (error) => { unhandled = error; };
  process.once("unhandledRejection", listener);
  createGateObservability({ write: async () => { throw new Error("async sink failed"); } })
    .counter("gate_quote_issued_total");
  await new Promise((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", listener);
  assert.equal(unhandled, undefined);
});

test("observability converts exact operational failures into counters plus redacted alerts", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });

  telemetry.recordOperatorAlert({ source: "cursor", code: "CHECKPOINT_FAILED" });
  telemetry.recordOperatorAlert({ source: "monitor", code: "FINAL_CHECK_FAILED" });

  const events = parsed(lines).map(({ timestamp, level, type, ...event }) => ({ level, type, ...event }));
  assert.deepEqual(events, [
    { level: "info", type: "counter", name: "gate_forward_cursor_checkpoint_failure_total", value: 1 },
    { level: "error", type: "alert", source: "cursor", code: "CHECKPOINT_FAILED" },
    { level: "info", type: "counter", name: "gate_monitor_final_check_failure_total", value: 1 },
    { level: "error", type: "alert", source: "monitor", code: "FINAL_CHECK_FAILED" },
  ]);
});

test("operator reorg interface emits the required operator-source metric and redacted alert", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });
  telemetry.recordSettlementReorg({ phase: "pre_acceptance", source: "operator" });
  const events = parsed(lines).map(({ timestamp, level, type, ...event }) => ({ level, type, ...event }));
  assert.deepEqual(events, [
    { level: "info", type: "counter", name: "gate_settlement_reorg_total", value: 1,
      labels: { phase: "pre_acceptance", source: "operator" } },
    { level: "error", type: "alert", source: "operator", code: "PRE_ACCEPTANCE_SETTLEMENT_REORG" },
  ]);
});

test("worker result observation turns only committed outcome counts and lag snapshots into telemetry", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });

  telemetry.observeWorkerResult("expire", 3);
  telemetry.observeWorkerResult("scan", { accepted: 2, unknownQuotes: 1, mismatches: 4, preAcceptanceReorged: 2, reorged: 1,
    confirmationLag: 5, cursorLag: 6, overlapLag: 7 });
  telemetry.observeWorkerResult("monitor", { reorged: 1, queueDepth: 8, oldestAgeSeconds: 9,
    progressLag: 10 });
  telemetry.observeWorkerResult("scan", { released: 3, active: 4, expiryPending: 5, releasedRows: 6,
    consumedRows: 7, oldestPendingAgeSeconds: 8 });
  telemetry.observeWorkerResult("notification", { claimed: 11, attempted: 7, failed: 3, reconciled: 2 });
  telemetry.observeWorkerResult("scan", { released: 0, checkpointFailed: true });
  telemetry.observeWorkerResult("scan", { released: 2 }); // second committed release batch


  const events = parsed(lines).map(({ timestamp, level, type, ...event }) => event);
  assert.deepEqual(events, [
    { name: "gate_quote_expired_total", value: 3 },
    { name: "gate_settlement_verified_total", value: 2 },
    { name: "gate_inbox_created_total", value: 2 },
    { name: "gate_settlement_unknown_quote_total", value: 1 },
    { name: "gate_settlement_mismatch_total", value: 4 },
    { name: "gate_settlement_reorg_total", value: 2, labels: { phase: "pre_acceptance", source: "overlap" } },
    { name: "gate_settlement_reorg_total", value: 1, labels: { phase: "post_acceptance", source: "overlap" } },
    { name: "gate_confirmation_lag_blocks", value: 5 },
    { name: "gate_forward_cursor_lag_blocks", value: 6 },
    { name: "gate_overlap_lag_blocks", value: 7 },
    { name: "gate_settlement_reorg_total", value: 1, labels: { phase: "post_acceptance", source: "monitor" } },
    { name: "gate_monitor_queue_depth", value: 8 },
    { name: "gate_monitor_oldest_age_seconds", value: 9 },
    { name: "gate_monitor_progress_lag_blocks", value: 10 },
    { name: "gate_reservation_released_total", value: 3 },
    { name: "gate_reservation_release_batch", value: 3 },
    { name: "gate_reservation_active_total", value: 4 },
    { name: "gate_reservation_expiry_pending_total", value: 5 },
    { name: "gate_reservation_released_current", value: 6 },
    { name: "gate_reservation_consumed_current", value: 7 },
    { name: "gate_reservation_oldest_pending_age_seconds", value: 8 },
    { name: "gate_notification_attempt_total", value: 7 },
    { name: "gate_notification_failure_total", value: 5 },
    { name: "gate_reservation_release_batch", value: 0 },
    { name: "gate_reservation_released_total", value: 2 },
    { name: "gate_reservation_release_batch", value: 2 },
  ]);
});

test("scanner RPC telemetry is allowlisted, emitted, and carries no settlement content", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });

  // Every name must be in the COUNTERS/GAUGES allowlist. metric() throws on an unlisted name and
  // observeWorkerResult swallows it, so an unlisted metric is silently dead rather than loud.
  telemetry.observeWorkerResult("scan", {
    scanned: 5_000, rpcCalls: 5_010, getLogsCalls: 5, headerCalls: 5_002, receiptCalls: 2,
    relevantBlocks: 1, relevantLogs: 1, scanElapsedMs: 143,
    discoveryOmissions: 2, nonCanonicalLogs: 1, auditedBlocks: 50,
  });

  const events = parsed(lines).map(({ timestamp, level, type, ...event }) => event);
  assert.deepEqual(events, [
    { name: "gate_scanner_rpc_calls_total", value: 5, labels: { method: "get_logs" } },
    { name: "gate_scanner_rpc_calls_total", value: 5_002, labels: { method: "headers" } },
    { name: "gate_scanner_rpc_calls_total", value: 2, labels: { method: "receipts" } },
    { name: "gate_scanner_rpc_calls_total", value: 1, labels: { method: "other" } },
    { name: "gate_scanner_range_blocks", value: 5_000 },
    { name: "gate_scanner_relevant_blocks", value: 1 },
    { name: "gate_scanner_relevant_logs", value: 1 },
    { name: "gate_scanner_elapsed_milliseconds", value: 143 },
    { name: "gate_scanner_log_discovery_omissions_total", value: 2 },
    { name: "gate_scanner_non_canonical_logs_total", value: 1 },
    { name: "gate_scanner_bloom_audited_blocks_total", value: 50 },
  ]);
  // The labelled parts sum to the reported total, so no metric double-counts.
  const parts = events.filter((event) => event.name === "gate_scanner_rpc_calls_total");
  assert.equal(parts.reduce((total, event) => total + event.value, 0), 5_010);
  // No address, hash, quote id or wallet may appear anywhere in the emitted telemetry.
  assert.doesNotMatch(lines.join("\n"), /0x[0-9a-fA-F]{8}/);
});
