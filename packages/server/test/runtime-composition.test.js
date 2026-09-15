"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const SPLITTER = `0x${"1".repeat(40)}`;
const durableProvider = () => Object.assign(() => {}, { durableIdempotency: true });

function loadRuntime() {
  delete require.cache[require.resolve("../src/gate/runtime")];
  return require("../src/gate/runtime");
}

function services() {
  return {
    authService: {},
    profileService: {},
    submissionService: {},
    store: { async markExpired() {} },
    baseClient: {},
    lifecycleReader() {},
    operatorAlert() {},
  };
}

test("the server package exports the canonical runtime composition", () => {
  const runtime = require("..");
  assert.equal(typeof runtime.createGateServerRuntime, "function");
  assert.equal(typeof runtime.settlementRuntimeConfigFromEnv, "function");
});

test("PR6 runtime config is opt-in, defaults to one confirmation and the canonical 64-block overlap", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.equal(settlementRuntimeConfigFromEnv({}), null);
  assert.deepEqual(settlementRuntimeConfigFromEnv({ GAVEL_GATE_SPLITTER: SPLITTER }), {
    chainId: "8453",
    splitter: SPLITTER,
    confirmationDepth: 1,
    overlap: 64,
    maxBlockRange: 5_000,
    pollIntervalMs: 5_000,
    rpcTimeoutMs: 10_000,
    notificationLeaseMs: 300_000,
  });
  assert.deepEqual(settlementRuntimeConfigFromEnv({
    GAVEL_GATE_SPLITTER: SPLITTER,
    GAVEL_GATE_BASE_CHAIN_ID: "84532",
    GAVEL_GATE_CONFIRMATION_DEPTH: "1",
    GAVEL_GATE_REORG_OVERLAP_BLOCKS: "12",
    GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE: "200",
    GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS: "9000",
    GAVEL_GATE_BASE_RPC_TIMEOUT_MS: "8000",
    GAVEL_GATE_NOTIFICATION_LEASE_MS: "420000",
  }), { chainId: "84532", splitter: SPLITTER, confirmationDepth: 1, overlap: 12,
    maxBlockRange: 200, pollIntervalMs: 9_000, rpcTimeoutMs: 8_000, notificationLeaseMs: 420_000 });
});

test("Base adapter config uses the canonical PR6 overlap setting", () => {
  const { settlementConfigFromEnv } = require("../src/gate/base-settlement-adapter");
  assert.deepEqual(settlementConfigFromEnv({
    GAVEL_GATE_CONFIRMATION_DEPTH: "1",
    GAVEL_GATE_REORG_OVERLAP_BLOCKS: "17",
  }), { confirmationDepth: 1, overlap: 17, maxBlockRange: 5_000 });
  assert.throws(() => settlementConfigFromEnv({ GAVEL_GATE_CONFIRMATION_DEPTH: "3" }), /exactly 1/);
});

test("partial or malformed settlement configuration fails closed", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_BASE_RPC_URL: "https://base.invalid" }),
    /GAVEL_GATE_SPLITTER is required/);
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_SPLITTER: "bad" }), /GAVEL_GATE_SPLITTER/);
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_SPLITTER: SPLITTER, GAVEL_GATE_CONFIRMATION_DEPTH: "0" }),
    /GAVEL_GATE_CONFIRMATION_DEPTH/);
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_SPLITTER: SPLITTER, GAVEL_GATE_CONFIRMATION_DEPTH: "2" }),
    /GAVEL_GATE_CONFIRMATION_DEPTH.*exactly 1/);
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_SPLITTER: SPLITTER,
    GAVEL_GATE_REORG_OVERLAP_BLOCKS: "64", GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE: "64" }),
  /GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE/);
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_SPLITTER: SPLITTER,
    GAVEL_GATE_BASE_RPC_TIMEOUT_MS: "60001" }), /GAVEL_GATE_BASE_RPC_TIMEOUT_MS/);
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_SPLITTER: SPLITTER,
    GAVEL_GATE_NOTIFICATION_LEASE_MS: "3600001" }), /GAVEL_GATE_NOTIFICATION_LEASE_MS/);
});

test("canonical server composes the adapter, settlement route, worker boundary, and injectable jobs", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const calls = [];
  const adapter = { adapter: true };
  const settlementService = {
    async scanOnce() { calls.push("scan"); },
    async reconcileSubmitted() { calls.push("reconcile"); },
    async monitorOnce() { calls.push("monitor"); },
  };
  const notificationWorker = { async runOnce() { calls.push("notify"); } };
  const server = { server: true };
  const input = services();
  input.store.markExpired = async () => { calls.push("expire"); };
  const runtime = createGateServerRuntime({
    ...input,
    env: { GAVEL_GATE_SPLITTER: SPLITTER },
    notificationProvider: durableProvider(),
    factories: {
      createBaseSettlementAdapter(options) { calls.push(["adapter", options]); return adapter; },
      createSettlementService(options) { calls.push(["service", options]); return settlementService; },
      createNotificationWorker(options) { calls.push(["worker", options]); return notificationWorker; },
      createGateHttpServer(options) { calls.push(["http", options]); return server; },
    },
  });

  assert.equal(runtime.server, server);
  assert.equal(calls[0][0], "adapter");
  assert.deepEqual(calls[0][1], {
    client: input.baseClient, chainId: "8453", splitter: SPLITTER, confirmationDepth: 1, overlap: 64,
    maxBlockRange: 5_000, rpcTimeoutMs: 10_000,
  });
  assert.equal(calls[1][1].store, input.store);
  assert.equal(calls[1][1].adapter, adapter);
  assert.equal(calls[1][1].lifecycleReader, input.lifecycleReader);
  assert.equal(calls[1][1].operatorAlert, input.operatorAlert);
  assert.deepEqual(calls[2][1], { store: input.store, provider: runtime.notificationProvider, leaseMs: 300_000 });
  assert.equal(calls[3][1].settlementService, settlementService);
  assert.equal(calls[3][1].authService, input.authService);
  assert.equal(calls[3][1].profileService, input.profileService);
  assert.equal(calls[3][1].submissionService, input.submissionService);

  await runtime.runOnce();
  assert.deepEqual(calls.slice(-5).sort(), ["expire", "monitor", "notify", "reconcile", "scan"]);
});

test("an unconfigured runtime exposes no settlement route or background jobs", async () => {
  const { createGateServerRuntime } = loadRuntime();
  let httpOptions;
  const runtime = createGateServerRuntime({
    ...services(), env: {},
    factories: {
      createBaseSettlementAdapter() { throw new Error("adapter must stay disabled"); },
      createSettlementService() { throw new Error("service must stay disabled"); },
      createNotificationWorker() { throw new Error("worker must stay disabled"); },
      createGateHttpServer(options) { httpOptions = options; return {}; },
    },
  });
  assert.equal(Object.hasOwn(httpOptions, "settlementService"), false);
  assert.equal(runtime.settlementService, null);
  assert.deepEqual(await runtime.runOnce(), []);
});

test("configured settlement refuses to expose a route without every runtime dependency", () => {
  const { createGateServerRuntime } = loadRuntime();
  const configured = { ...services(), env: { GAVEL_GATE_SPLITTER: SPLITTER } };
  for (const field of ["store", "baseClient", "lifecycleReader", "operatorAlert"]) {
    assert.throws(() => createGateServerRuntime({ ...configured, [field]: undefined }), new RegExp(field));
  }
});

test("start and stop own one serialized interval per composed job", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const scheduled = []; const cleared = [];
  const runtime = createGateServerRuntime({
    ...services(), env: { GAVEL_GATE_SPLITTER: SPLITTER }, notificationProvider: durableProvider(),
    scheduler: {
      setInterval(callback, delay) { scheduled.push({ callback, delay }); return scheduled.length; },
      clearInterval(id) { cleared.push(id); },
    },
    factories: {
      createBaseSettlementAdapter() { return {}; },
      createSettlementService() { return { scanOnce: async () => {}, reconcileSubmitted: async () => {}, monitorOnce: async () => {} }; },
      createNotificationWorker() { return { runOnce: async () => {} }; },
      createGateHttpServer() { return {}; },
    },
  });
  runtime.start();
  runtime.start();
  assert.equal(scheduled.length, 5);
  assert.ok(scheduled.every((item) => item.delay === 5_000));
  runtime.stop();
  assert.deepEqual(cleared, [1, 2, 3, 4, 5]);
});
