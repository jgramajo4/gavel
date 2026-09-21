"use strict";

const COUNTERS = new Map([
  ["gate_quote_issued_total", {}],
  ["gate_quote_rejected_total", { reason: new Set(["unauthorized", "not_accepting", "not_found", "canonical_data_unavailable", "active_quote_exists", "sender_proposal_limit", "sender_blocked", "rate_limited", "invalid_request", "request_too_large", "internal_error"]) }],
  ["gate_quote_expired_total", {}],
  ["gate_settlement_pending_total", {}],
  ["gate_settlement_verified_total", {}],
  ["gate_settlement_mismatch_total", {}],
  ["gate_settlement_unknown_quote_total", {}],
  ["gate_settlement_reorg_total", { phase: new Set(["pre_acceptance", "post_acceptance"]), source: new Set(["overlap", "monitor", "operator"]) }],
  ["gate_inbox_created_total", {}],
  ["gate_notification_attempt_total", {}],
  ["gate_notification_failure_total", {}],
  ["gate_forward_cursor_checkpoint_failure_total", {}],
  ["gate_monitor_final_check_failure_total", {}],
  ["gate_reservation_released_total", {}],
  // Scanner LOGICAL JSON-RPC method calls -- not HTTP requests, which ethers does not report.
  // Parts only, never an overlapping grand total, so summing the label dimension gives the
  // true method count.
  ["gate_scanner_rpc_method_calls_total", { method: new Set(["headers", "receipts", "log_queries", "other"]) }],
  // Real HTTP payloads put on the wire, which is what batching reduces. Emitted only when the
  // transport can report it; compare against rpc_method_calls_total to see batching working.
  ["gate_scanner_http_payloads_total", {}],
]);

const GAUGES = new Map([
  ["gate_dao_freshness_age_seconds", { health: new Set(["healthy", "stale", "unhealthy"]) }],
  ["gate_confirmation_lag_blocks", {}],
  ["gate_forward_cursor_lag_blocks", {}],
  ["gate_overlap_lag_blocks", {}],
  ["gate_monitor_queue_depth", {}],
  ["gate_monitor_oldest_age_seconds", {}],
  ["gate_monitor_progress_lag_blocks", {}],
  ["gate_reservation_release_batch", {}],
  ["gate_reservation_active_total", {}],
  ["gate_reservation_expiry_pending_total", {}],
  ["gate_reservation_released_current", {}],
  ["gate_reservation_consumed_current", {}],
  ["gate_reservation_oldest_pending_age_seconds", {}],
  ["gate_scanner_range_blocks", {}],
  ["gate_scanner_relevant_logs", {}],
  ["gate_scanner_elapsed_milliseconds", {}],
  ["gate_scanner_concurrency", {}],
]);

const ALERT_SOURCES = new Set(["gate", "gate_worker", "index", "cursor", "overlap", "monitor", "notification_worker", "email_notifier", "operator"]);
const ALERT_CODES = new Set([
  "WORKER_FAILED", "CHECKPOINT_FAILED", "FINAL_CHECK_FAILED", "POST_ACCEPTANCE_SETTLEMENT_REORG",
  "PRE_ACCEPTANCE_SETTLEMENT_REORG", "UNKNOWN_QUOTE", "MISMATCHED_SETTLEMENT",
  "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED", "PROVIDER_IDEMPOTENCY_CONFLICT", "DESTINATION_UNAVAILABLE",
  "PROVIDER_ERROR", "INVALID_JOB", "OPERATION_FAILED",
]);

function labelsFor(definition, labels) {
  const supplied = labels ?? {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new TypeError("metric labels are invalid");
  const expected = Object.keys(definition).sort();
  const actual = Object.keys(supplied).sort();
  if (actual.join("\0") !== expected.join("\0")) throw new TypeError("metric labels must exactly match the allowlisted labels");
  const result = {};
  for (const name of expected) {
    if (!definition[name].has(supplied[name])) throw new TypeError(`${name} label value is not allowlisted`);
    result[name] = supplied[name];
  }
  return result;
}

function createGateObservability({ write = (line) => process.stderr.write(line), clock = () => new Date() } = {}) {
  if (typeof write !== "function") throw new TypeError("observability write sink is required");
  if (typeof clock !== "function") throw new TypeError("observability clock is required");

  function emit(payload) {
    let timestamp;
    try {
      timestamp = new Date(clock()).toISOString();
    } catch {
      timestamp = "1970-01-01T00:00:00.000Z";
    }
    try {
      const pending = write(`${JSON.stringify({ timestamp, ...payload })}\n`);
      if (pending && typeof pending.then === "function") Promise.resolve(pending).catch(() => {});
    } catch {}
  }

  function metric(type, definitions, name, value, labels) {
    const definition = definitions.get(name);
    if (!definition) throw new TypeError(`${type} name is not allowlisted`);
    if (!Number.isFinite(value) || value < 0 || (type === "counter" && !Number.isSafeInteger(value))) {
      throw new TypeError(`${type} value must be a non-negative ${type === "counter" ? "integer" : "number"}`);
    }
    const safeLabels = labelsFor(definition, labels);
    emit({ level: "info", type, name, value, ...(Object.keys(safeLabels).length ? { labels: safeLabels } : {}) });
  }

  const api = {
    counter(name, value = 1, labels) { metric("counter", COUNTERS, name, value, labels); },
    gauge(name, value, labels) { metric("gauge", GAUGES, name, value, labels); },
    alert({ source, code } = {}) {
      if (!ALERT_SOURCES.has(source) || !ALERT_CODES.has(code)) throw new TypeError("alert source or code is not allowlisted");
      emit({ level: "error", type: "alert", source, code });
    },
    recordOperatorAlert({ source, code } = {}) {
      if (code === "CHECKPOINT_FAILED") api.counter("gate_forward_cursor_checkpoint_failure_total");
      if (code === "FINAL_CHECK_FAILED") api.counter("gate_monitor_final_check_failure_total");
      api.alert({ source, code });
    },
    recordSettlementReorg({ phase, source } = {}) {
      if (source !== "operator" || !new Set(["pre_acceptance", "post_acceptance"]).has(phase)) {
        throw new TypeError("operator settlement reorg phase is invalid");
      }
      api.counter("gate_settlement_reorg_total", 1, { phase, source });
      api.alert({ source, code: phase === "pre_acceptance"
        ? "PRE_ACCEPTANCE_SETTLEMENT_REORG" : "POST_ACCEPTANCE_SETTLEMENT_REORG" });
    },
    observeWorkerResult(job, result) {
      const count = (name, value, labels) => { if (Number.isSafeInteger(value) && value > 0) api.counter(name, value, labels); };
      const gauge = (name, value) => { if (Number.isFinite(value) && value >= 0) api.gauge(name, value); };
      try {
        if (job === "expire") count("gate_quote_expired_total", result);
        if (job === "scan") {
          count("gate_settlement_verified_total", result?.accepted);
          count("gate_inbox_created_total", result?.accepted);
          count("gate_settlement_unknown_quote_total", result?.unknownQuotes);
          count("gate_settlement_mismatch_total", result?.mismatches);
          count("gate_settlement_reorg_total", result?.preAcceptanceReorged, { phase: "pre_acceptance", source: "overlap" });
          count("gate_settlement_reorg_total", result?.reorged, { phase: "post_acceptance", source: "overlap" });
          count("gate_reservation_released_total", result?.released);
          gauge("gate_confirmation_lag_blocks", result?.confirmationLag);
          gauge("gate_forward_cursor_lag_blocks", result?.cursorLag);
          gauge("gate_overlap_lag_blocks", result?.overlapLag);
          if (Number.isSafeInteger(result?.released) && result.released >= 0) {
            gauge("gate_reservation_release_batch", result.released);
          }
          gauge("gate_reservation_active_total", result?.active);
          gauge("gate_reservation_expiry_pending_total", result?.expiryPending);
          gauge("gate_reservation_released_current", result?.releasedRows);
          gauge("gate_reservation_consumed_current", result?.consumedRows);
          gauge("gate_reservation_oldest_pending_age_seconds", result?.oldestPendingAgeSeconds);
          // Scanner logical JSON-RPC method shape. Counts and timings only: no wallet, quote or
          // submission content. These are method calls, NOT HTTP requests -- how many round trips
          // they become is a provider-transport property ethers does not expose.
          count("gate_scanner_rpc_method_calls_total", result?.headerMethodCalls, { method: "headers" });
          count("gate_scanner_rpc_method_calls_total", result?.receiptMethodCalls, { method: "receipts" });
          count("gate_scanner_rpc_method_calls_total", result?.logQueryMethodCalls, { method: "log_queries" });
          count("gate_scanner_rpc_method_calls_total", Number(result?.rpcMethodCalls)
            - Number(result?.headerMethodCalls) - Number(result?.receiptMethodCalls)
            - Number(result?.logQueryMethodCalls), { method: "other" });
          gauge("gate_scanner_range_blocks", result?.scanned);
          gauge("gate_scanner_relevant_logs", result?.relevantLogs);
          gauge("gate_scanner_elapsed_milliseconds", result?.scanElapsedMs);
          gauge("gate_scanner_concurrency", result?.scanConcurrency);
          count("gate_scanner_http_payloads_total", result?.httpPayloads);
        }
        if (job === "monitor") {
          count("gate_settlement_reorg_total", result?.reorged, { phase: "post_acceptance", source: "monitor" });
          gauge("gate_monitor_queue_depth", result?.queueDepth);
          gauge("gate_monitor_oldest_age_seconds", result?.oldestAgeSeconds);
          gauge("gate_monitor_progress_lag_blocks", result?.progressLag);
        }
        if (job === "notification") {
          count("gate_notification_attempt_total", result?.attempted);
          count("gate_notification_failure_total", (result?.failed ?? 0) + (result?.reconciled ?? 0));
        }
      } catch {}
    },
  };
  return Object.freeze(api);
}

module.exports = { createGateObservability };
