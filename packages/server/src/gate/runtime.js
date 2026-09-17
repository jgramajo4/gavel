"use strict";

const { createBaseSettlementAdapter } = require("./base-settlement-adapter");
const { createGateHttpServer } = require("./http");
const { createNotificationWorker } = require("./notification-worker");
const { createSettlementService } = require("./settlement-service");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const SETTLEMENT_CONFIG_KEYS = Object.freeze([
  "GAVEL_GATE_SPLITTER",
  "GAVEL_GATE_BASE_RPC_URL",
  "GAVEL_GATE_BASE_CHAIN_ID",
  "GAVEL_GATE_CONFIRMATION_DEPTH",
  "GAVEL_GATE_REORG_OVERLAP_BLOCKS",
  "GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE",
  "GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS",
  "GAVEL_GATE_BASE_RPC_TIMEOUT_MS",
  "GAVEL_GATE_NOTIFICATION_LEASE_MS",
]);

function positive(value, name, fallback) {
  const raw = value === undefined ? String(fallback) : String(value);
  if (!DECIMAL.test(raw)) throw new TypeError(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} must be a positive safe integer`);
  return parsed;
}

function settlementRuntimeConfigFromEnv(env = process.env) {
  const configured = SETTLEMENT_CONFIG_KEYS.some((key) => env[key] !== undefined && env[key] !== "");
  if (!configured) return null;
  if (typeof env.GAVEL_GATE_SPLITTER !== "string" || !env.GAVEL_GATE_SPLITTER) {
    throw new TypeError("GAVEL_GATE_SPLITTER is required when settlement is configured");
  }
  if (!ADDRESS.test(env.GAVEL_GATE_SPLITTER)) throw new TypeError("GAVEL_GATE_SPLITTER must be an Ethereum address");
  const chainId = String(env.GAVEL_GATE_BASE_CHAIN_ID ?? "8453");
  if (!DECIMAL.test(chainId)) throw new TypeError("GAVEL_GATE_BASE_CHAIN_ID must be a positive decimal integer");
  const overlap = positive(env.GAVEL_GATE_REORG_OVERLAP_BLOCKS, "GAVEL_GATE_REORG_OVERLAP_BLOCKS", 64);
  const maxBlockRange = positive(env.GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE,
    "GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE", 5_000);
  if (maxBlockRange <= overlap) {
    throw new TypeError("GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE must be greater than GAVEL_GATE_REORG_OVERLAP_BLOCKS");
  }
  const notificationLeaseMs = positive(env.GAVEL_GATE_NOTIFICATION_LEASE_MS,
    "GAVEL_GATE_NOTIFICATION_LEASE_MS", 5 * 60_000);
  if (notificationLeaseMs > 3_600_000) throw new TypeError("GAVEL_GATE_NOTIFICATION_LEASE_MS must not exceed 3600000");
  const confirmationDepth = positive(env.GAVEL_GATE_CONFIRMATION_DEPTH, "GAVEL_GATE_CONFIRMATION_DEPTH", 1);
  if (confirmationDepth !== 1) throw new TypeError("GAVEL_GATE_CONFIRMATION_DEPTH must be exactly 1 for the MVP");
  const rpcTimeoutMs = positive(env.GAVEL_GATE_BASE_RPC_TIMEOUT_MS, "GAVEL_GATE_BASE_RPC_TIMEOUT_MS", 10_000);
  if (rpcTimeoutMs > 60_000) throw new TypeError("GAVEL_GATE_BASE_RPC_TIMEOUT_MS must not exceed 60000");
  return Object.freeze({
    chainId,
    splitter: env.GAVEL_GATE_SPLITTER.toLowerCase(),
    confirmationDepth,
    overlap,
    maxBlockRange,
    pollIntervalMs: positive(env.GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS, "GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS", 5_000),
    rpcTimeoutMs,
    notificationLeaseMs,
  });
}

function createGateServerRuntime(options = {}) {
  const config = settlementRuntimeConfigFromEnv(options.env ?? process.env);
  const factories = {
    createBaseSettlementAdapter,
    createSettlementService,
    createNotificationWorker,
    createGateHttpServer,
    ...options.factories,
  };
  const scheduler = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    ...options.scheduler,
  };
  const onError = options.onError ?? (() => {});
  if (typeof onError !== "function") throw new TypeError("onError must be a function");

  let adapter = null;
  let settlementService = null;
  let notificationWorker = null;
  const jobs = [];

  if (config) {
    if (!options.store || typeof options.store !== "object") throw new TypeError("store is required for configured settlement");
    if (typeof options.store.markExpired !== "function") throw new TypeError("store.markExpired is required for configured settlement");
    if (!options.baseClient || typeof options.baseClient !== "object") throw new TypeError("baseClient is required for configured settlement");
    if (typeof options.lifecycleReader !== "function") throw new TypeError("lifecycleReader is required for configured settlement");
    if (typeof options.operatorAlert !== "function") throw new TypeError("operatorAlert is required for configured settlement");
    if (options.notificationProvider !== undefined && typeof options.notificationProvider !== "function") {
      throw new TypeError("notificationProvider must be a function");
    }
    adapter = factories.createBaseSettlementAdapter({
      client: options.baseClient,
      chainId: config.chainId,
      splitter: config.splitter,
      confirmationDepth: config.confirmationDepth,
      overlap: config.overlap,
      maxBlockRange: config.maxBlockRange,
      rpcTimeoutMs: config.rpcTimeoutMs,
    });
    settlementService = factories.createSettlementService({
      store: options.store,
      adapter,
      lifecycleReader: options.lifecycleReader,
      operatorAlert: options.operatorAlert,
    });
    jobs.push(() => options.store.markExpired(), settlementService.scanOnce,
      settlementService.reconcileSubmitted, settlementService.monitorOnce);
    if (options.notificationProvider) {
      notificationWorker = factories.createNotificationWorker({
        store: options.store, provider: options.notificationProvider, leaseMs: config.notificationLeaseMs,
      });
      jobs.push(notificationWorker.runOnce);
    }
  }

  const httpOptions = {
    authService: options.authService,
    profileService: options.profileService,
    ...(options.submissionService === undefined ? {} : { submissionService: options.submissionService }),
    ...(options.inboxService === undefined ? {} : { inboxService: options.inboxService }),
    ...(settlementService ? { settlementService } : {}),
  };
  const server = factories.createGateHttpServer(httpOptions);
  const timers = [];
  const running = new Set();

  async function invoke(job) {
    if (running.has(job)) return undefined;
    running.add(job);
    try { return await job(); }
    finally { running.delete(job); }
  }

  function start() {
    if (timers.length || !config) return;
    for (const job of jobs) {
      const timer = scheduler.setInterval(() => invoke(job).catch(onError), config.pollIntervalMs);
      if (typeof timer?.unref === "function") timer.unref();
      timers.push(timer);
    }
  }

  function stop() {
    while (timers.length) scheduler.clearInterval(timers.shift());
  }

  return Object.freeze({
    server,
    config,
    adapter,
    settlementService,
    notificationWorker,
    notificationProvider: options.notificationProvider,
    runOnce: () => Promise.all(jobs.map(invoke)),
    start,
    stop,
  });
}

module.exports = { createGateServerRuntime, settlementRuntimeConfigFromEnv };
