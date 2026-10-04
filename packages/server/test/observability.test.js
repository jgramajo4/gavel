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

test("worker failure diagnostics preserve safe error and cause fields alongside WORKER_FAILED", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); },
    clock: () => new Date("2026-09-17T12:00:00Z") });
  const cause = Object.assign(new Error("receipt read timed out after 10000ms"), { name: "TimeoutError", code: "ETIMEDOUT" });
  const error = Object.assign(new Error("scanner range failed"), { name: "ScanError", code: "SCAN_FAILED", cause });
  telemetry.workerFailure({ worker: "scan", error });
  telemetry.recordOperatorAlert({ source: "gate_worker", code: "WORKER_FAILED" });
  assert.deepEqual(parsed(lines), [
    { timestamp: "2026-09-17T12:00:00.000Z", level: "error", type: "worker_failure",
      worker: "scan", errorName: "ScanError", errorCode: "SCAN_FAILED", errorMessage: "scanner range failed",
      causeName: "TimeoutError", causeCode: "ETIMEDOUT", causeMessage: "receipt read timed out after 10000ms" },
    { timestamp: "2026-09-17T12:00:00.000Z", level: "error", type: "alert", source: "gate_worker", code: "WORKER_FAILED" },
  ]);
});

test("worker diagnostics redact unsafe provider messages and omit unsafe cause chains", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });
  const error = Object.assign(new Error("RPC failed at https://user:password@node.example/rpc?key=secret"), {
    code: "NETWORK_ERROR", cause: Object.assign(new Error("Authorization: Bearer sensitive-value"), { code: "SECRET_CODE" }),
    request: { body: "private signing payload" },
  });
  telemetry.workerFailure({ worker: "scan", error });
  telemetry.workerFailure({ worker: "scan", error: { name: "ProviderError", code: "https://secret.example", message: "password=hunter2", cause: error } });
  telemetry.workerFailure({ worker: "scan", error: new Error("provider rejected request abcdefghijklmnopqrstuvwxyz123456") });
  telemetry.workerFailure({ worker: "scan", error: Object.assign(new Error("opaque credential abc123"), {
    name: "sk_live_opaque123", code: "sk_live_opaque123",
    cause: Object.assign(new Error("sk_live_opaque123"), { name: "sk_live_opaque123", code: "sk_live_opaque123" }),
  }) });
  const events = parsed(lines);
  assert.equal(events.length, 4);
  assert.equal(events[2].errorMessage, "[redacted]");
  assert.deepEqual(Object.keys(events[3]).sort(), ["errorMessage", "level", "timestamp", "type", "worker"]);
  assert.equal(events[3].errorMessage, "[redacted]");
  assert.equal(events[0].errorCode, "NETWORK_ERROR");
  assert.equal(events[0].errorMessage, "[redacted]");
  assert.equal(events[0].cause, undefined);
  assert.equal(events[0].causeName, undefined);
  assert.equal(events[1].errorCode, undefined);
  assert.equal(events[1].causeName, undefined);
  assert.doesNotMatch(lines.join(""), /node\.example|secret\.example|password|hunter2|sensitive-value|private signing payload|Bearer/);
});

test("worker diagnostics preserve only the four reviewed first-party Gate errors", () => {
  const messages = [
    "Base RPC getTransaction timed out",
    "canonical block parent ancestry is inconsistent",
    "canonical boundary changed during scan",
    "settlement monitor receipt RPC result is incomplete",
  ];
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });
  for (const message of messages) {
    telemetry.workerFailure({ worker: "scan", error: new Error(message) });
    telemetry.workerFailure({ worker: "scan", error: new Error(`${message} https://user:pass@rpc.example/key`) });
  }
  const events = parsed(lines);
  assert.deepEqual(events.map(({ errorMessage }) => errorMessage),
    messages.flatMap((message) => [message, "[redacted]"]));
  assert.doesNotMatch(lines.join(""), /rpc\.example|user:pass/);
});

test("worker diagnostics keep existing timeout text and redact arbitrary upstream errors", () => {
  const messages = [
    ["Base RPC getBlockReceipts timed out", "Base RPC getBlockReceipts timed out"],
    ["Base RPC getTransaction timed out extra", "[redacted]"],
    ["Base RPC getTransaction timed out https://rpc.example/secret", "[redacted]"],
    ["ethers call exception action=call", "[redacted]"],
    ["PostgreSQL failed at user secret", "[redacted]"],
    ["fetch failed at https://user:pass@rpc.example", "[redacted]"],
  ];
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });
  for (const [message] of messages) telemetry.workerFailure({ worker: "scan", error: new Error(message) });
  assert.deepEqual(parsed(lines).map(({ errorMessage }) => errorMessage), messages.map(([, expected]) => expected));
  assert.doesNotMatch(lines.join(""), /rpc\.example|user:pass|PostgreSQL|ethers call exception|fetch failed/);
});

test("worker diagnostics emit only validated scanner RPC context", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });
  const error = new Error("Base RPC getBlockReceipts timed out");
  error.scannerContext = { rpcMethod: "getBlockReceipts", blockNumber: 47_555_503,
    scanFromBlock: 47_555_502n, scanToBlock: 47_560_501n, phase: "receipts" };
  telemetry.workerFailure({ worker: "scan", error });
  assert.deepEqual(parsed(lines).map(({ timestamp, ...event }) => event), [{
    level: "error", type: "worker_failure", worker: "scan", errorName: "Error",
    errorMessage: "Base RPC getBlockReceipts timed out", rpcMethod: "getBlockReceipts",
    blockNumber: 47_555_503, scanFromBlock: 47_555_502, scanToBlock: 47_560_501, phase: "receipts",
  }]);
});

test("worker diagnostics omit untrusted scanner metadata and redact provider errors", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });
  const badContexts = [
    { rpcMethod: "getBlockReceipts https://user:pass@rpc.example", blockNumber: 1001, scanFromBlock: 1000, scanToBlock: 1002, phase: "receipts" },
    { rpcMethod: "getBlockReceipts", blockNumber: "1001", scanFromBlock: 1000, scanToBlock: 1002, phase: "receipts" },
    { rpcMethod: "getBlockReceipts", blockNumber: 1001, scanFromBlock: 1000, scanToBlock: 1002, phase: "receipts plus token" },
    { rpcMethod: "getBlockReceipts", blockNumber: 1003, scanFromBlock: 1000, scanToBlock: 1002, phase: "receipts" },
    { rpcMethod: "getBlockReceipts", blockNumber: 1001, scanFromBlock: -1, scanToBlock: 1002, phase: "receipts" },
  ];
  for (const scannerContext of badContexts) {
    const error = new Error("provider failure https://user:pass@rpc.example/secret");
    error.scannerContext = scannerContext;
    telemetry.workerFailure({ worker: "scan", error });
  }
  for (const event of parsed(lines)) {
    assert.deepEqual(Object.keys(event).sort(), ["errorMessage", "errorName", "level", "timestamp", "type", "worker"]);
    assert.equal(event.errorMessage, "[redacted]");
  }
  assert.doesNotMatch(lines.join(""), /rpc\.example|user:pass|token/);
});

test("a throwing scanner context getter cannot suppress the worker failure event", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });
  const error = new Error("Base RPC getBlockReceipts timed out");
  Object.defineProperty(error, "scannerContext", { get() { throw new Error("provider secret"); } });
  telemetry.workerFailure({ worker: "scan", error });
  assert.deepEqual(parsed(lines).map(({ timestamp, ...event }) => event), [{
    level: "error", type: "worker_failure", worker: "scan", errorName: "Error",
    errorMessage: "Base RPC getBlockReceipts timed out",
  }]);
});

test("production worker error callback keeps WORKER_FAILED when diagnostics cannot write", () => {
  const { workerErrorHandler } = require("../bin/gavel-server");
  const lines = [];
  const telemetry = createGateObservability({ write(line) {
    if (JSON.parse(line).type === "worker_failure") throw new Error("sink unavailable");
    lines.push(line);
  } });
  workerErrorHandler(telemetry, (alert) => telemetry.recordOperatorAlert(alert))(
    new Error("provider URL https://user:pass@node.example/rpc"), { worker: "scan" });
  assert.deepEqual(parsed(lines).map(({ level, type, source, code }) => ({ level, type, source, code })),
    [{ level: "error", type: "alert", source: "gate_worker", code: "WORKER_FAILED" }]);
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

test("scanner RPC telemetry is allowlisted, emitted, truthfully named, and carries no content", () => {
  const lines = [];
  const telemetry = createGateObservability({ write(line) { lines.push(line); } });

  // Every name must be in the COUNTERS/GAUGES allowlist. metric() throws on an unlisted name and
  // observeWorkerResult swallows it, so an unlisted metric is silently dead rather than loud.
  telemetry.observeWorkerResult("scan", {
    scanned: 5_000, rpcMethodCalls: 15_003, headerMethodCalls: 5_002, receiptMethodCalls: 10_000,
    logQueryMethodCalls: 0, relevantLogs: 1, scanConcurrency: 64, scanElapsedMs: 143,
    httpPayloads: 240,
  });

  const events = parsed(lines).map(({ timestamp, level, type, ...event }) => event);
  assert.deepEqual(events, [
    { name: "gate_scanner_rpc_method_calls_total", value: 5_002, labels: { method: "headers" } },
    { name: "gate_scanner_rpc_method_calls_total", value: 10_000, labels: { method: "receipts" } },
    { name: "gate_scanner_rpc_method_calls_total", value: 1, labels: { method: "other" } },
    { name: "gate_scanner_range_blocks", value: 5_000 },
    { name: "gate_scanner_relevant_logs", value: 1 },
    { name: "gate_scanner_elapsed_milliseconds", value: 143 },
    { name: "gate_scanner_concurrency", value: 64 },
    { name: "gate_scanner_http_payloads_total", value: 240 },
  ]);
  // The labelled parts sum to the reported logical method total, so no metric double-counts.
  const parts = events.filter((event) => event.name === "gate_scanner_rpc_method_calls_total");
  assert.equal(parts.reduce((total, event) => total + event.value, 0), 15_003);
  // Method calls and HTTP payloads are distinct series and must never be conflated: 15,003
  // logical calls really did travel as 240 requests.
  const payloads = events.find((event) => event.name === "gate_scanner_http_payloads_total");
  assert.equal(payloads.value, 240);
  assert.notEqual(payloads.value, 15_003);
  // No address, hash, quote id or wallet may appear anywhere in the emitted telemetry.
  assert.doesNotMatch(lines.join("\n"), /0x[0-9a-fA-F]{8}/);
});
