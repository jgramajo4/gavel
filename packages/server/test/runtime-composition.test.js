"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface, TypedDataEncoder, keccak256 } = require("ethers");

const SPLITTER = `0x${"1".repeat(40)}`;
const SIGNER = `0x${"3".repeat(40)}`;
const GAVEL_RECIPIENT = `0x${"4".repeat(40)}`;
const CANONICAL_BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TEST_TOKEN = `0x${"2".repeat(40)}`;
const DEPLOYED_BYTECODE = "0x60006000";
const CONTRACT_CODE_HASH = keccak256(DEPLOYED_BYTECODE);
const splitterReads = new Interface([
  "function usdc() view returns (address)", "function quoteSigner() view returns (address)",
  "function gavelRecipient() view returns (address)", "function GAVEL_FEE_AMOUNT() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const tokenReads = new Interface([
  "function name() view returns (string)", "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const durableProvider = () => Object.assign(() => {}, { durableIdempotency: true });
const productionEnv = (overrides = {}) => ({
  GAVEL_GATE_ENVIRONMENT: "production",
  GAVEL_GATE_BASE_CHAIN_ID: "8453",
  GAVEL_GATE_BASE_USDC: CANONICAL_BASE_USDC,
  GAVEL_GATE_SPLITTER: SPLITTER,
  GAVEL_GATE_QUOTE_SIGNER_ADDRESS: SIGNER,
  GAVEL_GATE_OWNER_RECIPIENT: GAVEL_RECIPIENT,
  ...overrides,
});

function loadRuntime() {
  delete require.cache[require.resolve("../src/gate/runtime")];
  return require("../src/gate/runtime");
}

function services() {
  const deployment = {
    id: "deployment-1", environment: "production", chainId: "8453", splitter: SPLITTER,
    token: CANONICAL_BASE_USDC.toLowerCase(), signer: SIGNER, gavelRecipient: GAVEL_RECIPIENT,
    contractCodeHash: CONTRACT_CODE_HASH, config: { environment: "production" },
  };
  const domainSeparator = TypedDataEncoder.hashDomain({
    name: "GavelGateSplitter", version: "1", chainId: 8453, verifyingContract: SPLITTER,
  });
  const tokenDomainSeparator = TypedDataEncoder.hashDomain({
    name: "USD Coin", version: "2", chainId: 8453, verifyingContract: CANONICAL_BASE_USDC,
  });
  const attestation = { deployedBytecode: DEPLOYED_BYTECODE, usdc: CANONICAL_BASE_USDC,
    quoteSigner: SIGNER, gavelRecipient: GAVEL_RECIPIENT, gavelFeeAmount: 250000n,
    domainSeparator, tokenName: "USD Coin", tokenVersion: "2", tokenDomainSeparator };
  return {
    authService: {},
    profileService: {},
    submissionService: { runtimeIdentity: {
      deploymentId: deployment.id, chainId: deployment.chainId, splitter: deployment.splitter,
      token: deployment.token, codeHash: deployment.contractCodeHash, quoteSigner: deployment.signer,
    } },
    store: { async markExpired() {}, async getDeployment() { return deployment; } },
    baseClient: {
      attestation,
      async getChainId() { return "8453"; },
      async getCode() { return this.attestation.deployedBytecode; },
      async call({ to, data }) {
        const iface = to.toLowerCase() === SPLITTER.toLowerCase() ? splitterReads : tokenReads;
        const method = iface.getFunction(data.slice(0, 10)).name;
        const key = to.toLowerCase() === SPLITTER.toLowerCase()
          ? ({ usdc: "usdc", quoteSigner: "quoteSigner", gavelRecipient: "gavelRecipient",
            GAVEL_FEE_AMOUNT: "gavelFeeAmount", DOMAIN_SEPARATOR: "domainSeparator" })[method]
          : ({ name: "tokenName", version: "tokenVersion", DOMAIN_SEPARATOR: "tokenDomainSeparator" })[method];
        return iface.encodeFunctionResult(method, [this.attestation[key]]);
      },
    },
    lifecycleReader() {},
    operatorAlert() {},
  };
}

test("the server package exports the canonical runtime composition", () => {
  const runtime = require("..");
  assert.equal(typeof runtime.createGateServerRuntime, "function");
  assert.equal(typeof runtime.settlementRuntimeConfigFromEnv, "function");
});

test("production settlement config requires exact Base mainnet and canonical native USDC", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.deepEqual(settlementRuntimeConfigFromEnv(productionEnv()), {
    environment: "production",
    chainId: "8453",
    token: CANONICAL_BASE_USDC.toLowerCase(),
    splitter: SPLITTER,
    quoteSigner: SIGNER,
    gavelRecipient: GAVEL_RECIPIENT,
    confirmationDepth: 1,
    overlap: 64,
    maxBlockRange: 5_000,
    pollIntervalMs: 5_000,
    rpcTimeoutMs: 10_000,
    notificationLeaseMs: 300_000,
  });
});

test("test settlement config accepts exact Base Sepolia with an explicitly labeled token", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.deepEqual(settlementRuntimeConfigFromEnv({
    GAVEL_GATE_ENVIRONMENT: "test",
    GAVEL_GATE_BASE_CHAIN_ID: "84532",
    GAVEL_GATE_BASE_USDC: TEST_TOKEN,
    GAVEL_GATE_TEST_TOKEN_LABEL: "base-sepolia-eip3009-test-token",
    GAVEL_GATE_SPLITTER: SPLITTER,
    GAVEL_GATE_QUOTE_SIGNER_ADDRESS: SIGNER,
    GAVEL_GATE_OWNER_RECIPIENT: GAVEL_RECIPIENT,
  }), {
    environment: "test",
    chainId: "84532",
    token: TEST_TOKEN,
    testTokenLabel: "base-sepolia-eip3009-test-token",
    splitter: SPLITTER,
    quoteSigner: SIGNER,
    gavelRecipient: GAVEL_RECIPIENT,
    confirmationDepth: 1,
    overlap: 64,
    maxBlockRange: 5_000,
    pollIntervalMs: 5_000,
    rpcTimeoutMs: 10_000,
    notificationLeaseMs: 300_000,
  });
});

test("test settlement config rejects Base mainnet", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv({
    GAVEL_GATE_ENVIRONMENT: "test",
    GAVEL_GATE_BASE_CHAIN_ID: "8453",
    GAVEL_GATE_BASE_USDC: TEST_TOKEN,
    GAVEL_GATE_TEST_TOKEN_LABEL: "test-token",
    GAVEL_GATE_SPLITTER: SPLITTER,
    GAVEL_GATE_QUOTE_SIGNER_ADDRESS: SIGNER,
    GAVEL_GATE_OWNER_RECIPIENT: GAVEL_RECIPIENT,
  }), /test.*84532/i);
});

test("production settlement config rejects Base Sepolia", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv({
    GAVEL_GATE_ENVIRONMENT: "production",
    GAVEL_GATE_BASE_CHAIN_ID: "84532",
    GAVEL_GATE_BASE_USDC: CANONICAL_BASE_USDC,
    GAVEL_GATE_SPLITTER: SPLITTER,
    GAVEL_GATE_QUOTE_SIGNER_ADDRESS: SIGNER,
    GAVEL_GATE_OWNER_RECIPIENT: GAVEL_RECIPIENT,
  }), /production.*8453/i);
});

test("settlement config rejects unknown environments and chains", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv({
    GAVEL_GATE_ENVIRONMENT: "staging",
    GAVEL_GATE_BASE_CHAIN_ID: "1",
    GAVEL_GATE_BASE_USDC: TEST_TOKEN,
    GAVEL_GATE_SPLITTER: SPLITTER,
  }), /environment.*production.*test/i);
});

test("production settlement config rejects a non-canonical token", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv({
    GAVEL_GATE_ENVIRONMENT: "production",
    GAVEL_GATE_BASE_CHAIN_ID: "8453",
    GAVEL_GATE_BASE_USDC: TEST_TOKEN,
    GAVEL_GATE_SPLITTER: SPLITTER,
  }), /production.*canonical.*USDC/i);
});

test("test settlement config rejects an unlabeled test token", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv({
    GAVEL_GATE_ENVIRONMENT: "test",
    GAVEL_GATE_BASE_CHAIN_ID: "84532",
    GAVEL_GATE_BASE_USDC: TEST_TOKEN,
    GAVEL_GATE_SPLITTER: SPLITTER,
  }), /test token label/i);
});

test("a test token label by itself is partial settlement configuration", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv({ GAVEL_GATE_TEST_TOKEN_LABEL: "test-token" }),
    /GAVEL_GATE_SPLITTER is required/);
});

test("production settlement config rejects a nonblank test token label", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.throws(() => settlementRuntimeConfigFromEnv(productionEnv({ GAVEL_GATE_TEST_TOKEN_LABEL: "not-production" })),
    /production.*test token label/i);
});

test("production settlement config rejects any test token label presence", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  for (const label of ["", "   ", null]) {
    assert.throws(() => settlementRuntimeConfigFromEnv(productionEnv({ GAVEL_GATE_TEST_TOKEN_LABEL: label })),
      /production.*test token label/i, JSON.stringify(label));
  }
});

test("PR6 runtime config is opt-in, defaults to one confirmation and the canonical 64-block overlap", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  assert.equal(settlementRuntimeConfigFromEnv({}), null);
  assert.deepEqual(settlementRuntimeConfigFromEnv(productionEnv()), {
    environment: "production",
    chainId: "8453",
    token: CANONICAL_BASE_USDC.toLowerCase(),
    splitter: SPLITTER,
    quoteSigner: SIGNER,
    gavelRecipient: GAVEL_RECIPIENT,
    confirmationDepth: 1,
    overlap: 64,
    maxBlockRange: 5_000,
    pollIntervalMs: 5_000,
    rpcTimeoutMs: 10_000,
    notificationLeaseMs: 300_000,
  });
  assert.deepEqual(settlementRuntimeConfigFromEnv(productionEnv({
    GAVEL_GATE_CONFIRMATION_DEPTH: "1",
    GAVEL_GATE_REORG_OVERLAP_BLOCKS: "12",
    GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE: "200",
    GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS: "9000",
    GAVEL_GATE_BASE_RPC_TIMEOUT_MS: "8000",
    GAVEL_GATE_NOTIFICATION_LEASE_MS: "420000",
  })), { environment: "production", chainId: "8453", token: CANONICAL_BASE_USDC.toLowerCase(),
    splitter: SPLITTER, quoteSigner: SIGNER, gavelRecipient: GAVEL_RECIPIENT,
    confirmationDepth: 1, overlap: 12, maxBlockRange: 200,
    pollIntervalMs: 9_000, rpcTimeoutMs: 8_000, notificationLeaseMs: 420_000 });
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
  assert.throws(() => settlementRuntimeConfigFromEnv(productionEnv({ GAVEL_GATE_CONFIRMATION_DEPTH: "0" })),
    /GAVEL_GATE_CONFIRMATION_DEPTH/);
  assert.throws(() => settlementRuntimeConfigFromEnv(productionEnv({ GAVEL_GATE_CONFIRMATION_DEPTH: "2" })),
    /GAVEL_GATE_CONFIRMATION_DEPTH.*exactly 1/);
  assert.throws(() => settlementRuntimeConfigFromEnv(productionEnv({
    GAVEL_GATE_REORG_OVERLAP_BLOCKS: "64", GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE: "64" })),
  /GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE/);
  assert.throws(() => settlementRuntimeConfigFromEnv(productionEnv({
    GAVEL_GATE_BASE_RPC_TIMEOUT_MS: "60001" })), /GAVEL_GATE_BASE_RPC_TIMEOUT_MS/);
  assert.throws(() => settlementRuntimeConfigFromEnv(productionEnv({
    GAVEL_GATE_NOTIFICATION_LEASE_MS: "3600001" })), /GAVEL_GATE_NOTIFICATION_LEASE_MS/);
});

test("canonical server composes only after authoritative deployment parity", async () => {
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
  const runtime = await createGateServerRuntime({
    ...input,
    env: productionEnv(),
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
  assert.deepEqual(calls[2][1], {
    store: input.store, provider: runtime.notificationProvider, leaseMs: 300_000,
    operatorAlert: input.operatorAlert,
  });
  assert.equal(calls[3][1].settlementService, settlementService);
  assert.equal(calls[3][1].authService, input.authService);
  assert.equal(calls[3][1].profileService, input.profileService);
  assert.equal(calls[3][1].submissionService, input.submissionService);

  await runtime.runOnce();
  assert.deepEqual(calls.slice(-5).sort(), ["expire", "monitor", "notify", "reconcile", "scan"]);
});

test("an unconfigured runtime exposes neither settlement nor quote issuance", async () => {
  const { createGateServerRuntime } = loadRuntime();
  let httpOptions;
  const runtime = await createGateServerRuntime({
    ...services(), env: {},
    factories: {
      createBaseSettlementAdapter() { throw new Error("adapter must stay disabled"); },
      createSettlementService() { throw new Error("service must stay disabled"); },
      createNotificationWorker() { throw new Error("worker must stay disabled"); },
      createGateHttpServer(options) { httpOptions = options; return {}; },
    },
  });
  assert.equal(Object.hasOwn(httpOptions, "settlementService"), false);
  assert.equal(Object.hasOwn(httpOptions, "submissionService"), false);
  assert.equal(runtime.settlementService, null);
  assert.deepEqual(await runtime.runOnce(), []);
});

test("configured settlement refuses to expose a route without every runtime dependency", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const configured = { ...services(), env: productionEnv() };
  for (const field of ["store", "baseClient", "lifecycleReader", "operatorAlert"]) {
    await assert.rejects(createGateServerRuntime({ ...configured, [field]: undefined }), new RegExp(field));
  }
});

test("configured settlement requires store-backed deployment lookup and concrete RPC attestation", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const missingLookup = services();
  delete missingLookup.store.getDeployment;
  await assert.rejects(createGateServerRuntime({ ...missingLookup, env: productionEnv() }), /store\.getDeployment/);
  const missingCode = services(); delete missingCode.baseClient.getCode;
  await assert.rejects(createGateServerRuntime({ ...missingCode, env: productionEnv() }), /baseClient\.getCode/);
  const missingCall = services(); delete missingCall.baseClient.call;
  await assert.rejects(createGateServerRuntime({ ...missingCall, env: productionEnv() }), /baseClient\.call/);
});

test("configured settlement binds the exposed quote issuer to the attested deployment", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const input = services();
  input.submissionService = { runtimeIdentity: { ...input.submissionService.runtimeIdentity, quoteSigner: TEST_TOKEN } };
  await assert.rejects(createGateServerRuntime({ ...input, env: productionEnv() }),
    /submission service.*deployment identity/i);
});

test("configured settlement requires explicit signer and recipient identity", () => {
  const { settlementRuntimeConfigFromEnv } = loadRuntime();
  const signerMissing = productionEnv(); delete signerMissing.GAVEL_GATE_QUOTE_SIGNER_ADDRESS;
  const recipientMissing = productionEnv(); delete recipientMissing.GAVEL_GATE_OWNER_RECIPIENT;
  assert.throws(() => settlementRuntimeConfigFromEnv(signerMissing), /QUOTE_SIGNER_ADDRESS/);
  assert.throws(() => settlementRuntimeConfigFromEnv(recipientMissing), /OWNER_RECIPIENT/);
});

test("configured settlement fails before composition when persisted deployment identity differs", async () => {
  const { createGateServerRuntime } = loadRuntime();
  let composed = false;
  const input = services();
  input.store.getDeployment = async () => ({
    environment: "test", chainId: "84532", token: TEST_TOKEN, splitter: SPLITTER,
    signer: SIGNER, gavelRecipient: GAVEL_RECIPIENT, contractCodeHash: CONTRACT_CODE_HASH,
    config: { environment: "test", testTokenLabel: "base-sepolia-test-token" },
  });
  await assert.rejects(createGateServerRuntime({
    ...input, env: productionEnv(),
    factories: {
      createBaseSettlementAdapter() { composed = true; return {}; },
      createGateHttpServer() { composed = true; return {}; },
    },
  }), /authoritative deployment.*match/i);
  assert.equal(composed, false);
});

test("configured settlement reads the exact deployment from the store and attests RPC before composition", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const input = services();
  const events = [];
  const originalLookup = input.store.getDeployment;
  const originalGetCode = input.baseClient.getCode;
  input.store.getDeployment = async (query) => { events.push(["store", query]); return originalLookup(query); };
  input.baseClient.getChainId = async () => { events.push("chain"); return "8453"; };
  input.baseClient.getCode = async function getCode(address) {
    events.push(["onchain", { client: input.baseClient, chainId: "8453", splitter: address,
      token: CANONICAL_BASE_USDC.toLowerCase(), rpcTimeoutMs: 10_000 }]);
    return originalGetCode.call(this, address);
  };
  await createGateServerRuntime({ ...input, env: productionEnv(), factories: {
    createBaseSettlementAdapter() { events.push("adapter"); return {}; },
    createSettlementService() { return { scanOnce() {}, reconcileSubmitted() {}, monitorOnce() {} }; },
    createGateHttpServer() { events.push("http"); return {}; },
  } });
  assert.deepEqual(events[0], ["store", { chainId: "8453", splitter: SPLITTER }]);
  assert.equal(events[1], "chain");
  assert.deepEqual(events[2][0], "onchain");
  assert.equal(events[2][1].client, input.baseClient);
  assert.deepEqual({ ...events[2][1], client: undefined }, {
    client: undefined, chainId: "8453", splitter: SPLITTER, token: CANONICAL_BASE_USDC.toLowerCase(),
    rpcTimeoutMs: 10_000,
  });
  assert.deepEqual(events.slice(3), ["adapter", "http"]);
});

test("configured settlement rejects an RPC chain mismatch before composition", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const input = services();
  input.baseClient.getChainId = async () => "84532";
  let composed = false;
  await assert.rejects(createGateServerRuntime({ ...input, env: productionEnv(), factories: {
    createBaseSettlementAdapter() { composed = true; return {}; },
    createGateHttpServer() { composed = true; return {}; },
  } }), /RPC chain 84532.*8453/i);
  assert.equal(composed, false);
});

test("configured startup bounds registry, chain, and deployment attestation reads", async () => {
  const { createGateServerRuntime } = loadRuntime();
  for (const method of ["getChainId", "getCode", "call"]) {
    const input = services();
    input.baseClient[method] = () => new Promise(() => {});
    await assert.rejects(createGateServerRuntime({ ...input,
      env: productionEnv({ GAVEL_GATE_BASE_RPC_TIMEOUT_MS: "1" }) }), /timed out/i, method);
  }
  const input = services();
  input.store.getDeployment = () => new Promise(() => {});
  await assert.rejects(createGateServerRuntime({ ...input,
    env: productionEnv({ GAVEL_GATE_BASE_RPC_TIMEOUT_MS: "1" }) }), /deployment registry read timed out/i);
});

test("configured settlement rejects each mismatched onchain deployment attestation before composition", async (t) => {
  const { createGateServerRuntime } = loadRuntime();
  const cases = [
    ["missing bytecode", { deployedBytecode: "0x" }],
    ["bytecode hash", { deployedBytecode: "0x6001" }],
    ["splitter token", { usdc: TEST_TOKEN }],
    ["quote signer", { quoteSigner: TEST_TOKEN }],
    ["Gavel recipient", { gavelRecipient: TEST_TOKEN }],
    ["immutable fee", { gavelFeeAmount: "250001" }],
    ["splitter domain", { domainSeparator: `0x${"0".repeat(64)}` }],
    ["token name", { tokenName: "USDC" }],
    ["token version", { tokenVersion: "1" }],
    ["token domain", { tokenDomainSeparator: `0x${"0".repeat(64)}` }],
  ];
  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const input = services();
      Object.assign(input.baseClient.attestation, patch);
      let composed = false;
      await assert.rejects(createGateServerRuntime({ ...input, env: productionEnv(), factories: {
        createBaseSettlementAdapter() { composed = true; return {}; },
        createGateHttpServer() { composed = true; return {}; },
      } }), /onchain deployment attestation/i);
      assert.equal(composed, false);
    });
  }
});

test("start and stop own one serialized interval per composed job", async () => {
  const { createGateServerRuntime } = loadRuntime();
  const scheduled = []; const cleared = [];
  const runtime = await createGateServerRuntime({
    ...services(), env: productionEnv(), notificationProvider: durableProvider(),
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
