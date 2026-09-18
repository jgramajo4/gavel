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
  telemetry.observeWorkerResult("notification", { claimed: 11, attempted: 7, failed: 3, reconciled: 2 });

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
    { name: "gate_notification_attempt_total", value: 7 },
    { name: "gate_notification_failure_total", value: 5 },
  ]);
});
