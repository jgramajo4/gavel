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
        migrationChecksum: "sha256:gate-001-v3-atomic-auth-session", manifestMatches: true, isSuperuser: false,
        canCreateDb: false, canCreateRole: false, bypassRls: false, canReplicate: false, inheritsRoles: false,
        membershipCount: "0", ownershipCount: "0", hasGateUsage: true }] };
    },
  });
  assert.equal(result.role, "gavel_gate");
  assert.equal(calls.length, 1);
  await assert.rejects(assertDatabaseReady({ async query() { return { rows: [{ currentUser: "gavel_gate",
    migrationVersion: null, migrationChecksum: null, manifestMatches: false, isSuperuser: false,
    canCreateDb: false, canCreateRole: false, bypassRls: false, canReplicate: false, inheritsRoles: false,
    membershipCount: "0", ownershipCount: "0", hasGateUsage: true }] }; } }), /migration is missing/);
  await assert.rejects(assertDatabaseReady({ async query() { return { rows: [{ currentUser: "postgres",
    migrationVersion: "gate/001_gate-v3", migrationChecksum: "sha256:gate-001-v3-atomic-auth-session",
    manifestMatches: true, isSuperuser: true, canCreateDb: true, canCreateRole: true, bypassRls: true,
    canReplicate: true, inheritsRoles: true, membershipCount: "1", ownershipCount: "1",
    hasGateUsage: true }] }; } }),
  /least-privilege gavel_gate role/);
  for (const escalation of ["canReplicate", "inheritsRoles", "membershipCount", "ownershipCount"]) {
    const row = { currentUser: "gavel_gate", migrationVersion: "gate/001_gate-v3",
      migrationChecksum: "sha256:gate-001-v3-atomic-auth-session", manifestMatches: true, isSuperuser: false,
      canCreateDb: false, canCreateRole: false, bypassRls: false, canReplicate: false, inheritsRoles: false,
      membershipCount: "0", ownershipCount: "0", hasGateUsage: true };
    row[escalation] = escalation.endsWith("Count") ? "1" : true;
    await assert.rejects(assertDatabaseReady({ async query() { return { rows: [row] }; } }),
      /least-privilege gavel_gate role/, escalation);
  }
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
