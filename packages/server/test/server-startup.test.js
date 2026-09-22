"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { createGateHttpServer } = require("../src/gate/http");

const ROOT = path.resolve(__dirname, "../../..");

function services() {
  return {
    authService: { issueChallenge() {}, verifyProof() {}, authenticateSession() {} },
    profileService: { updateProfile() {}, listPublicProfiles() {}, getPublicProfile() {} },
  };
}

async function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

test("Gate HTTP health is a fixed no-secret readiness projection", async () => {
  const server = createGateHttpServer(services());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await request(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, status: "ready" });
    assert.equal(response.body.includes("secret"), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("canonical entrypoint validates the least-privilege role and installed Gate migration", async () => {
  const { assertDatabaseReady } = require("../bin/gavel-server");
  const calls = [];
  const result = await assertDatabaseReady({
    async query(sql) {
      calls.push(sql);
      return { rows: [{ currentUser: "gavel_gate", migrationVersion: "gate/001_gate-v3",
        migrationChecksum: "sha256:gate-001-v5-relay-account-lock", manifestMatches: true, missingPrivileges: [], isSuperuser: false,
        canCreateDb: false, canCreateRole: false, bypassRls: false, canReplicate: false, inheritsRoles: false,
        membershipCount: "0", ownershipCount: "0", hasGateUsage: true }] };
    },
  });
  assert.equal(result.role, "gavel_gate");
  assert.equal(calls.length, 1);
  await assert.rejects(assertDatabaseReady({ async query() { return { rows: [{ currentUser: "gavel_gate",
    migrationVersion: null, migrationChecksum: null, manifestMatches: false, missingPrivileges: [], isSuperuser: false,
    canCreateDb: false, canCreateRole: false, bypassRls: false, canReplicate: false, inheritsRoles: false,
    membershipCount: "0", ownershipCount: "0", hasGateUsage: true }] }; } }), /migration is missing/);
  await assert.rejects(assertDatabaseReady({ async query() { return { rows: [{ currentUser: "postgres",
    migrationVersion: "gate/001_gate-v3", migrationChecksum: "sha256:gate-001-v5-relay-account-lock",
    manifestMatches: true, missingPrivileges: [], isSuperuser: true, canCreateDb: true, canCreateRole: true, bypassRls: true,
    canReplicate: true, inheritsRoles: true, membershipCount: "1", ownershipCount: "1",
    hasGateUsage: true }] }; } }),
  /least-privilege gavel_gate role/);
  for (const escalation of ["canReplicate", "inheritsRoles", "membershipCount", "ownershipCount"]) {
    const row = { currentUser: "gavel_gate", migrationVersion: "gate/001_gate-v3",
      migrationChecksum: "sha256:gate-001-v5-relay-account-lock", manifestMatches: true, missingPrivileges: [], isSuperuser: false,
      canCreateDb: false, canCreateRole: false, bypassRls: false, canReplicate: false, inheritsRoles: false,
      membershipCount: "0", ownershipCount: "0", hasGateUsage: true };
    row[escalation] = escalation.endsWith("Count") ? "1" : true;
    await assert.rejects(assertDatabaseReady({ async query() { return { rows: [row] }; } }),
      /least-privilege gavel_gate role/, escalation);
  }
  await assert.rejects(assertDatabaseReady({ async query() { return { rows: [{ currentUser: "gavel_gate",
    migrationVersion: "gate/001_gate-v3", migrationChecksum: "sha256:gate-001-v5-relay-account-lock",
    manifestMatches: true, missingPrivileges: ["function:gate.public_profile(text):EXECUTE"], isSuperuser: false,
    canCreateDb: false, canCreateRole: false, bypassRls: false, canReplicate: false, inheritsRoles: false,
    membershipCount: "0", ownershipCount: "0", hasGateUsage: true }] }; } }), /runtime privilege.*public_profile/i);
});

test("canonical application starts workers only after checks and closes listener, workers, and store", async () => {
  const { startGateServer } = require("../bin/gavel-server");
  const events = [];
  const server = createGateHttpServer(services());
  const runtime = {
    server,
    start() { events.push("workers:start"); },
    async stop() { events.push("workers:stop"); },
  };
  server.once("close", () => events.push("server:close"));
  const application = await startGateServer({
    env: { GAVEL_GATE_HOST: "127.0.0.1", GAVEL_GATE_PORT: "0" },
    dependencies: {
      async compose() { events.push("compose"); return { runtime, store: { async close() { events.push("store:close"); } } }; },
      async checkDatabase() { events.push("db"); },
      async checkIndex() { events.push("index"); },
    },
    installSignalHandlers: false,
  });
  assert.deepEqual(events, ["compose", "db", "index", "workers:start"]);
  const response = await request(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(response.status, 200);
  await application.stop();
  await application.stop();
  assert.deepEqual(events, ["compose", "db", "index", "workers:start", "workers:stop", "server:close", "store:close"]);
  assert.equal(server.listening, false);
});

test("worker shutdown failure still closes the listener and pool", async () => {
  const { startGateServer } = require("../bin/gavel-server");
  const events = [];
  const server = createGateHttpServer(services());
  server.once("close", () => events.push("server:close"));
  const application = await startGateServer({
    env: { GAVEL_GATE_HOST: "127.0.0.1", GAVEL_GATE_PORT: "0" },
    dependencies: { async compose() { return {
      runtime: { server, start() {}, async stop() { events.push("workers:stop"); throw new Error("worker failed"); } },
      store: { async close() { events.push("store:close"); } },
    }; }, async checkDatabase() {}, async checkIndex() {} },
    installSignalHandlers: false,
  });
  await assert.rejects(application.stop(), /worker failed/);
  assert.deepEqual(events, ["workers:stop", "server:close", "store:close"]);
  assert.equal(server.listening, false);
});

test("post-start server errors fail closed instead of being consumed by the startup listener", async () => {
  const { startGateServer } = require("../bin/gavel-server");
  const events = [];
  const server = createGateHttpServer(services());
  const previousExitCode = process.exitCode;
  const application = await startGateServer({
    env: { GAVEL_GATE_HOST: "127.0.0.1", GAVEL_GATE_PORT: "0" },
    dependencies: { async compose() { return {
      runtime: { server, start() {}, async stop() { events.push("workers:stop"); } },
      store: { async close() { events.push("store:close"); } },
    }; }, async checkDatabase() {}, async checkIndex() {} },
    installSignalHandlers: false,
  });
  try {
    server.emit("error", new Error("listener failed"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.listening, false);
    assert.deepEqual(events, ["workers:stop", "store:close"]);
    assert.equal(process.exitCode, 1);
  } finally {
    await application.stop();
    process.exitCode = previousExitCode;
  }
});

test("RPC identity reads eth_chainId from the live transport instead of configured static metadata", async () => {
  const { createRpcClient } = require("../bin/gavel-server");
  const calls = [];
  const client = createRpcClient("http://rpc.invalid", "8453", {
    async send(method, params) { calls.push([method, params]); return "0x14a34"; },
  });
  assert.equal(await client.getChainId(), "84532");
  assert.deepEqual(calls, [["eth_chainId", []]]);
});

test("canonical index health requires every source timestamp and reports the oldest source", async () => {
  const { createCanonicalIndexSource } = require("../bin/gavel-server");
  const response = (sources) => {
    const bytes = Buffer.from(JSON.stringify({ sources }));
    return { status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  };
  const stale = "Mon, 01 Jan 2001 00:00:00 GMT";
  const fresh = "2026-09-17T00:00:00.000Z";
  let sources = [{ updatedAt: stale, lastError: null }, { updatedAt: fresh, lastError: null }];
  const source = createCanonicalIndexSource({ baseUrl: "https://index.example", ethereumProvider: {},
    fetchImpl: async () => response(sources) });
  assert.deepEqual(await source.getHealth("nouns"), { healthy: true, refreshedAt: stale, lastError: null });
  sources = [{ updatedAt: fresh, lastError: null }, { updatedAt: "invalid", lastError: null }];
  assert.deepEqual(await source.getHealth("nouns"), { healthy: false, refreshedAt: "invalid", lastError: "sync_failed" });
});

test("canonical Gate index source uses the dedicated Nouns proposal projection", async () => {
  const { createCanonicalIndexSource } = require("../bin/gavel-server");
  const calls = [];
  const proposal = {
    proposalId: "42", refreshedAt: "2026-09-17T00:00:00.000Z", sourceBlock: "123",
    sourceBlockHash: `0x${"1".repeat(64)}`, effectiveStatus: "ACTIVE",
    contentHash: `0x${"2".repeat(64)}`, actions: [],
  };
  const source = createCanonicalIndexSource({ baseUrl: "https://index.example/private?token=secret", ethereumProvider: {},
    fetchImpl: async (url) => {
      calls.push(url);
      const bytes = Buffer.from(JSON.stringify(proposal));
      return { status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    } });

  assert.deepEqual(await source.getProposal("nouns", "42"), { dao: "nouns", ...proposal });
  assert.deepEqual(calls, ["https://index.example/v1/gate/daos/nouns/proposals/42"]);
});

test("canonical index fetch cancels an oversized streamed response", async () => {
  const { createCanonicalIndexSource } = require("../bin/gavel-server");
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.alloc(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const source = createCanonicalIndexSource({ baseUrl: "https://index.example", ethereumProvider: {},
    fetchImpl: async () => ({ status: 200, body, async text() { throw new Error("must not buffer"); } }) });
  await assert.rejects(source.getHealth("nouns"), /canonical index unavailable/);
  assert.equal(cancelled, true);
});

test("startup failure stops workers before closing listener and pool", async () => {
  const { startGateServer } = require("../bin/gavel-server");
  const events = [];
  const server = createGateHttpServer(services());
  server.once("close", () => events.push("server:close"));
  await assert.rejects(startGateServer({
    env: { GAVEL_GATE_HOST: "127.0.0.1", GAVEL_GATE_PORT: "0" },
    dependencies: { async compose() { return {
      runtime: { server, start() { events.push("workers:start"); throw new Error("start failed"); },
        async stop() { events.push("workers:stop"); } },
      store: { async close() { events.push("store:close"); } },
    }; }, async checkDatabase() {}, async checkIndex() {} },
    installSignalHandlers: false,
  }), /start failed/);
  assert.deepEqual(events, ["workers:start", "workers:stop", "server:close", "store:close"]);
});

test("startup rejects stale canonical index health and closes resources", async () => {
  const { startGateServer } = require("../bin/gavel-server");
  const events = [];
  const server = createGateHttpServer(services());
  await assert.rejects(startGateServer({
    env: { GAVEL_GATE_HOST: "127.0.0.1", GAVEL_GATE_PORT: "0" },
    dependencies: { async compose() { return {
      config: { host: "127.0.0.1", port: 0, freshnessMs: 900_000 },
      runtime: { server, start() {}, async stop() { events.push("workers:stop"); } },
      store: { pool: {}, async close() { events.push("store:close"); } },
      indexSource: { async getHealth() { return { healthy: true, refreshedAt: "1970-01-01T00:00:00.000Z" }; } },
      ethereumClient: { async getChainId() { return "1"; } },
    }; }, async checkDatabase() {} },
    installSignalHandlers: false,
  }), /canonical index or Ethereum RPC is unhealthy/);
  assert.deepEqual(events, ["workers:stop", "store:close"]);
});

test("Gate packaging is isolated from the existing index compose and exposes one canonical command", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile.server"), "utf8");
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.server.yml"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/server/package.json"), "utf8"));
  assert.match(dockerfile, /ENTRYPOINT \["node","packages\/server\/bin\/gavel-server\.js"\]/);
  assert.equal(pkg.scripts.start, "node bin/gavel-server.js");
  assert.match(compose, /gate:\n[\s\S]*dockerfile: Dockerfile\.server/);
  assert.doesNotMatch(compose, /\n\s+(?:api|indexer|web|cli):/);
  assert.match(compose, /env_file:\s*\n\s*- \$\{GAVEL_GATE_ENV_FILE:-\.env\.server\.local\}/);
  assert.doesNotMatch(compose, /GAVEL_GATE_QUOTE_SIGNER|GAVEL_GATE_ENCRYPTION_KEY|AGENTMAIL_API_KEY/);
  const dockerignore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^\*\*$/m);
  assert.doesNotMatch(dockerignore, /^!\.env(?:\.|$)/m);
  const packageInclude = dockerignore.indexOf("!packages/**");
  for (const exclusion of ["**/.env", "**/.env.*", "**/node_modules/**", "**/private/**",
    "**/data/private/**", "**/secrets/**", "**/credentials/**", "**/*.log", "**/*.pem", "**/*.key"]) {
    assert.ok(dockerignore.indexOf(exclusion) > packageInclude, `${exclusion} must override recursive includes`);
  }
  const runbook = fs.readFileSync(path.join(ROOT, "docs/deployment/GAVEL_GATE_EXPERIMENTAL.md"), "utf8");
  for (const required of ["cursor", "bounded backlog", "post-downtime", "post-acceptance reorg",
    "deeper than 64", "old deployment", "every old quote", "final 64-confirmation check"]) {
    assert.match(runbook.toLowerCase(), new RegExp(required));
  }
});

test("scanner header reads bypass the provider cache and encode block tags as canonical QUANTITY", async () => {
  const { createRpcClient } = require("../bin/gavel-server");
  const sends = [];
  const performs = [];
  const client = createRpcClient("http://rpc.invalid", "8453", {
    async send(method, params) {
      sends.push([method, params]);
      if (method === "eth_getBlockByNumber") return { number: params[0], hash: `0x${"1".repeat(64)}` };
      return null;
    },
    // getBlockHeader must NOT reach any of AbstractProvider's cached getBlock plumbing.
    async getBlock(...rest) { performs.push(rest); return null; },
    async _perform(request) { performs.push(request); return null; },
  });

  await client.getBlockHeader(36_000_000);
  // A raw send: AbstractProvider caches getBlock results for cacheTimeout (250 ms), which would
  // serve the scanner's end-of-scan boundary re-read from cache and make its reorg check vacuous.
  assert.deepEqual(performs, []);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], "eth_getBlockByNumber");
  assert.equal(sends[0][1][1], false, "transaction hashes only, never full transaction objects");

  // JSON-RPC QUANTITY forbids leading zeros; toBeHex pads to whole bytes and go-ethereum rejects
  // the result. Every current Base height is an odd number of nibbles, so this always mattered.
  for (const [input, expected] of [[36_000_000, "0x2255100"], [1, "0x1"], [10, "0xa"], [0, "0x0"]]) {
    sends.length = 0;
    await client.getBlockHeader(input);
    assert.equal(sends[0][1][0], expected);
    assert.doesNotMatch(sends[0][1][0], /^0x0./, "QUANTITY must not carry a leading zero");
  }

  // The two sibling raw reads the scanner makes per block share the same encoding requirement.
  sends.length = 0;
  await client.getBlockTransactionCount(36_000_000);
  await client.getBlockReceipts(36_000_000);
  assert.deepEqual(sends.map(([method, params]) => [method, params[0]]), [
    ["eth_getBlockTransactionCountByNumber", "0x2255100"],
    ["eth_getBlockReceipts", "0x2255100"],
  ]);
});

test("the real provider is constructed so batchMaxCount and batching actually take effect", async () => {
  const { createRpcClient } = require("../bin/gavel-server");
  // Deliberately NO providerOverride: the other createRpcClient tests stub the provider and so
  // would not notice options being passed in the wrong constructor position -- JsonRpcProvider is
  // (url, network, options), and a fourth argument is silently ignored. That exact mistake
  // silently disabled this optimization once already.
  const defaulted = createRpcClient("http://rpc.invalid", "8453");
  assert.equal(defaulted.provider._getOption("batchMaxCount"), 100);
  assert.equal(defaulted.provider._getOption("staticNetwork"), true);

  for (const configured of [1, 7, 64, 250]) {
    const client = createRpcClient("http://rpc.invalid", "8453", undefined, { batchMaxCount: configured });
    assert.equal(client.provider._getOption("batchMaxCount"), configured,
      "batchMaxCount must reach the provider, not be dropped as an ignored 4th argument");
  }

  // batchMaxCount === 1 is the documented escape hatch for batch-hostile providers, and is the
  // only value for which ethers also zeroes the batch drain stall.
  const unbatched = createRpcClient("http://rpc.invalid", "8453", undefined, { batchMaxCount: 1 });
  assert.equal(unbatched.provider._getOption("batchMaxCount"), 1);
});

test("the scanner client reports real HTTP payload counts, not method counts", async () => {
  const { createRpcClient } = require("../bin/gavel-server");
  const listeners = [];
  const client = createRpcClient("http://rpc.invalid", "8453", {
    on(event, handler) { if (event === "debug") listeners.push(handler); return this; },
    async send() { return null; },
  });

  assert.equal(typeof client.transportStats, "function");
  assert.deepEqual(client.transportStats(), { httpPayloads: 0, jsonRpcRequests: 0 });

  // One batched payload carrying 64 requests is ONE round trip but 64 logical method calls.
  listeners[0]({ action: "sendRpcPayload", payload: Array.from({ length: 64 }, (_, id) => ({ id })) });
  listeners[0]({ action: "sendRpcPayload", payload: { id: 1 } });
  // Non-send debug events must not be counted.
  listeners[0]({ action: "receiveRpcResult", result: [] });

  assert.deepEqual(client.transportStats(), { httpPayloads: 2, jsonRpcRequests: 65 });
});
