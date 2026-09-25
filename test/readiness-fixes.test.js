const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const {
  configPath,
  defaultGavelConfig,
  LocalSignerWalletProvider,
  resolveIndexApiEndpoint,
  resolveRuntimeReadiness,
  saveGavelConfig,
  WalletErrorCode,
  classifyOperationalFailure,
} = require("../packages/core");
const { configCommand, readinessCommand } = require("../packages/cli/runtime-commands");
const { IndexApiClient } = require("../packages/governance-index");

const SENTINEL = "GAVEL_INDEX_SECRET_SENTINEL";
const PRIVATE_URL = `https://private.example/v1?banana=${SENTINEL}`;
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "packages", "cli", "bin", "gavel.js");
const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";

function config(runtime = {}) {
  return {
    ...defaultGavelConfig(),
    runtime: { ...defaultGavelConfig().runtime, ...runtime },
  };
}

async function startCountingServer(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, url: `http://127.0.0.1:${server.address().port}` };
}

async function runTuiConfig(dataDir, env = {}) {
  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  const { stdout, stderr } = await execFileAsync(tsx, ["-e", [
    "import { loadConfig } from './packages/tui/src/config.ts';",
    "void (async () => {",
    "  const loaded = await loadConfig();",
    "  console.log(JSON.stringify({ url: loaded.indexApiUrl, metadata: loaded.indexApiEndpoint }));",
    "})();",
  ].join("\n")], {
    cwd: ROOT,
    env: { ...process.env, GAVEL_DATA_DIR: dataDir, ...env },
  });
  return { document: JSON.parse(stdout), stdout, stderr };
}

test("a named index variable resolves privately and exposes only redacted metadata", () => {
  const resolved = resolveIndexApiEndpoint(
    config({ indexApiUrlVariable: "MY_PRIVATE_INDEX" }),
    { MY_PRIVATE_INDEX: PRIVATE_URL },
  );

  assert.equal(resolved.url, PRIVATE_URL);
  assert.deepEqual(resolved.metadata, {
    source: "environment",
    variable: "MY_PRIVATE_INDEX",
    status: "configured",
  });
  assert.ok(!JSON.stringify(resolved).includes(SENTINEL));
  assert.deepEqual(Object.keys(resolved), ["metadata"]);
});

test("direct configuration deterministically beats named and legacy variables", () => {
  const resolved = resolveIndexApiEndpoint(
    config({ indexApiUrl: "https://direct.example/v1", indexApiUrlVariable: "MY_PRIVATE_INDEX" }),
    { MY_PRIVATE_INDEX: PRIVATE_URL, GAVEL_INDEX_API_URL: "https://legacy.example" },
  );
  assert.equal(resolved.url, "https://direct.example/v1");
  assert.deepEqual(resolved.metadata, { source: "config", variable: null, status: "configured" });
});

test("empty direct configuration remains an explicit index opt-out", () => {
  const resolved = resolveIndexApiEndpoint(
    config({ indexApiUrl: "", indexApiUrlVariable: "MY_PRIVATE_INDEX" }),
    { MY_PRIVATE_INDEX: PRIVATE_URL, GAVEL_INDEX_API_URL: "https://legacy.example" },
  );
  assert.equal(resolved.url, "");
  assert.deepEqual(resolved.metadata, { source: "config", variable: null, status: "disabled" });
});

test("missing or trim-empty named variables fail closed without falling back", () => {
  for (const env of [
    { GAVEL_INDEX_API_URL: "https://legacy.example" },
    { MY_PRIVATE_INDEX: "  ", GAVEL_INDEX_API_URL: "https://legacy.example" },
  ]) {
    assert.throws(
      () => resolveIndexApiEndpoint(config({ indexApiUrlVariable: "MY_PRIVATE_INDEX" }), env),
      (error) => {
        assert.equal(error.code, "INDEX_API_URL_VARIABLE_MISSING");
        assert.match(error.message, /MY_PRIVATE_INDEX/);
        assert.ok(!error.message.includes(SENTINEL));
        return true;
      },
    );
  }
});

test("legacy override and built-in default preserve their precedence", () => {
  const legacy = resolveIndexApiEndpoint(config(), { GAVEL_INDEX_API_URL: " https://legacy.example/v1 " });
  assert.equal(legacy.url, "https://legacy.example/v1");
  assert.deepEqual(legacy.metadata, {
    source: "environment",
    variable: "GAVEL_INDEX_API_URL",
    status: "configured",
  });

  const fallback = resolveIndexApiEndpoint(config(), {});
  assert.equal(fallback.url, "https://index.0773h.com");
  assert.deepEqual(fallback.metadata, { source: "default", variable: null, status: "configured" });
});

test("every non-empty endpoint must be HTTP(S) and errors never include its value", () => {
  for (const runtime of [
    { indexApiUrl: "file:///tmp/private" },
    { indexApiUrlVariable: "MY_PRIVATE_INDEX" },
  ]) {
    assert.throws(
      () => resolveIndexApiEndpoint(config(runtime), { MY_PRIVATE_INDEX: `ftp://private.example/${SENTINEL}` }),
      (error) => error.code === "INDEX_API_URL_INVALID" && !error.message.includes(SENTINEL),
    );
  }
});

test("a credential-bearing direct URL is rejected before operational use", () => {
  assert.throws(
    () => resolveIndexApiEndpoint(config({ indexApiUrl: PRIVATE_URL }), {}),
    (error) => error.code === "INDEX_URL_CARRIES_CREDENTIALS" && !error.message.includes(SENTINEL),
  );
});

test("core readiness reports the canonical redacted endpoint state", () => {
  const ready = resolveRuntimeReadiness({
    config: config({ indexApiUrlVariable: "MY_PRIVATE_INDEX" }),
    env: { MY_PRIVATE_INDEX: PRIVATE_URL },
  });
  assert.equal(ready.signals.indexEndpoint, "ready");
  assert.deepEqual(ready.indexEndpoint, {
    source: "environment",
    variable: "MY_PRIVATE_INDEX",
    status: "configured",
  });
  assert.ok(!JSON.stringify(ready).includes(SENTINEL));

  const missing = resolveRuntimeReadiness({
    config: config({ indexApiUrlVariable: "MY_PRIVATE_INDEX" }),
    env: { GAVEL_INDEX_API_URL: "https://legacy.example" },
  });
  assert.equal(missing.signals.indexEndpoint, "unavailable");
  assert.equal(missing.reasons.find((reason) => reason.code === "INDEX_API_URL_VARIABLE_MISSING").severity, "error");
  assert.equal(missing.indexEndpoint.status, "missing");
});

test("CLI status surfaces share resolver metadata without persisting or printing the endpoint", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-index-resolver-"));
  await saveGavelConfig(config({ indexApiUrlVariable: "MY_PRIVATE_INDEX" }), { dataDir });
  const persisted = await fs.readFile(configPath(dataDir), "utf8");
  assert.ok(!persisted.includes(PRIVATE_URL));
  assert.ok(!persisted.includes(SENTINEL));

  const outputs = [];
  const io = {
    dataDir,
    env: { MY_PRIVATE_INDEX: PRIVATE_URL },
    dataDirWritable: true,
    write: (chunk) => outputs.push(String(chunk)),
  };
  await readinessCommand(["--json"], io);
  const readiness = JSON.parse(outputs.pop());
  assert.deepEqual(readiness.runtime.indexEndpoint, {
    source: "environment",
    variable: "MY_PRIVATE_INDEX",
    status: "configured",
  });

  await configCommand(["show", "--json"], io);
  const shown = JSON.parse(outputs.pop());
  for (const surface of [readiness, shown]) {
    assert.ok(!JSON.stringify(surface).includes(SENTINEL));
  }
});

test("CLI operational index reads use the named variable from Gavel config", async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const body = request.url.split("?")[0].endsWith("/sync-status")
      ? { dao: "ens", sources: [{ sourceId: "governor-logs", finalizedHead: "500", updatedAt: new Date().toISOString(), lastError: null }] }
      : request.url.split("?")[0].endsWith("/history")
        ? { items: [{ chainId: 1, proposalId: "1", voter: VOTER, support: "FOR", reason: null, blockNumber: "150", timestamp: "2023-11-14T22:15:00.000Z", voteWeight: "5", clientId: 0, sourceKind: "ens-governor", sourceEndpoint: "https://rpc.example", entityId: "e1", transactionHash: `0x${"a".repeat(64)}`, logIndex: 0, observedHead: "500" }], nextCursor: null }
        : { id: "1", contentHash: crypto.createHash("sha256").update("ens-1").digest("hex"), title: "Indexed", description: "Body", proposer: VOTER, state: "EXECUTED", outcome: "PASSED", createdBlock: "100", createdAt: "2023-11-14T22:13:20.000Z", startBlock: "110", endBlock: "200", quorumVotes: "10", forVotes: "9", againstVotes: "1", abstainVotes: "0", actions: [], dao: "ens", chainId: 1, identity: { dao: "ens", chainId: 1, governorAddress: "0x323a76393544d5ecca80cd6ef2a560c6a395b7e3", proposalId: "1" } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-index-operational-"));
  await saveGavelConfig(config({ indexApiUrlVariable: "MY_PRIVATE_INDEX" }), { dataDir });

  const { stdout } = await execFileAsync(process.execPath, [CLI, "history", VOTER, "--dao", "ens", "--stdout"], {
    cwd: ROOT,
    env: { ...process.env, GAVEL_DATA_DIR: dataDir, MY_PRIVATE_INDEX: url, GAVEL_INDEX_API_URL: "http://127.0.0.1:1" },
  });

  assert.equal(JSON.parse(stdout).source.endpoint, url);
  assert.ok(requests.some((request) => request.includes("/history")));

  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  const tui = await execFileAsync(tsx, ["-e", [
    "import { loadConfig } from './packages/tui/src/config.ts';",
    "void (async () => {",
    "  const loaded = await loadConfig();",
    "  console.log(JSON.stringify({ metadata: loaded.indexApiEndpoint, matches: loaded.indexApiUrl === process.env.MY_PRIVATE_INDEX }));",
    "})();",
  ].join("\n")], {
    cwd: ROOT,
    env: { ...process.env, GAVEL_DATA_DIR: dataDir, MY_PRIVATE_INDEX: url, GAVEL_INDEX_API_URL: "http://127.0.0.1:1" },
  });
  assert.deepEqual(JSON.parse(tui.stdout), {
    metadata: { source: "environment", variable: "MY_PRIVATE_INDEX", status: "configured" },
    matches: true,
  });
});

test("TUI configuration uses the shared endpoint resolver rather than deriving its own URL", async () => {
  const source = await fs.readFile(path.join(ROOT, "packages", "tui", "src", "config.ts"), "utf8");
  assert.match(source, /resolveIndexApiEndpoint/);
  assert.doesNotMatch(source, /process\.env\.GAVEL_INDEX_API_URL/);
});

test("a disconnected local signer cannot become false-ready through plain connect", async () => {
  const broadcasts = [];
  const signer = {
    address: async () => VOTER,
    signTypedData: async () => "0xsig",
  };
  const provider = new LocalSignerWalletProvider({
    signer,
    broadcaster: { broadcast: async (request) => (broadcasts.push(request), { transactionHash: "0xok" }) },
    chainId: 1,
    source: { kind: "environment", variable: "GAVEL_PRIVATE_KEY" },
  });
  const transaction = {
    chainId: 1,
    from: VOTER,
    to: "0x2222222222222222222222222222222222222222",
    value: "0",
    data: "0x1234",
    intentHash: "a".repeat(64),
  };

  assert.equal((await provider.connect()).canSign, true);
  assert.equal(await provider.requestSignature({ domain: { chainId: 1 }, types: {}, message: {} }), "0xsig");
  assert.equal((await provider.requestTransaction(transaction)).transactionHash, "0xok");

  const disconnected = await provider.disconnect();
  assert.equal(disconnected.canSign, false);
  assert.deepEqual(disconnected.capabilities, ["read"]);
  await assert.rejects(provider.requestSignature({ domain: { chainId: 1 }, types: {}, message: {} }), (error) => error.code === WalletErrorCode.NOT_CONNECTED);
  await assert.rejects(provider.requestTransaction(transaction), (error) => error.code === WalletErrorCode.NOT_CONNECTED);

  await assert.rejects(provider.connect(), (error) => error.code === WalletErrorCode.NOT_CONNECTED);
  const afterPlainConnect = await provider.getStatus();
  assert.equal(afterPlainConnect.state, "disconnected");
  assert.equal(afterPlainConnect.canSign, false);
  assert.deepEqual(afterPlainConnect.capabilities, ["read"]);

  const reconnected = await provider.reconnect();
  assert.equal(reconnected.state, "connected");
  assert.equal(reconnected.canSign, true);
  assert.equal((await provider.requestTransaction(transaction)).transactionHash, "0xok");
  assert.equal(broadcasts.length, 2);

  await provider.disconnect();
  await provider.disconnect();
  await assert.rejects(provider.reconnect(), (error) => error.code === WalletErrorCode.NOT_CONNECTED);
  assert.equal((await provider.getStatus()).canSign, false);
});

test("userinfo and malformed endpoint values fail safely without leaking their sentinel", async () => {
  const secret = "SENTINEL_N1_REVIEW_556677";
  const cases = [
    { runtime: { indexApiUrl: `https://u:${secret}@index.example` }, env: {} },
    { runtime: { indexApiUrlVariable: "MY_IDX" }, env: { MY_IDX: `https://u:${secret}@127.0.0.1:9/` } },
    { runtime: {}, env: { GAVEL_INDEX_API_URL: `https://u:${secret}@127.0.0.1:9/` } },
    { runtime: { indexApiUrlVariable: "MY_IDX" }, env: { MY_IDX: `not-a-url-${secret}` } },
  ];
  for (const entry of cases) {
    assert.throws(
      () => resolveIndexApiEndpoint(config(entry.runtime), entry.env),
      (error) => !String(error.message).includes(secret) && error.metadata?.status === "invalid",
    );
  }

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-index-leak-"));
  await saveGavelConfig(config({ indexApiUrlVariable: "MY_IDX" }), { dataDir });
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "history", VOTER, "--dao", "ens", "--stdout"], {
      cwd: ROOT,
      env: { ...process.env, GAVEL_DATA_DIR: dataDir, MY_IDX: `https://u:${secret}@127.0.0.1:9/` },
    }),
    (error) => !`${error.stdout}\n${error.stderr}\n${error.message}`.includes(secret),
  );

  const write = [];
  await readinessCommand(["--json"], {
    dataDir,
    env: { MY_IDX: `https://u:${secret}@127.0.0.1:9/` },
    write: (chunk) => write.push(String(chunk)),
  });
  await configCommand(["show", "--json"], {
    dataDir,
    env: { MY_IDX: `https://u:${secret}@127.0.0.1:9/` },
    write: (chunk) => write.push(String(chunk)),
  });
  assert.ok(!write.join("\n").includes(secret));

  for (const referencedUrl of [
    `http://127.0.0.1:9/private/${secret}`,
    `http://127.0.0.1:9/private?token=${secret}`,
  ]) {
    const statusOutput = [];
    await readinessCommand(["--json"], {
      dataDir,
      env: { MY_IDX: referencedUrl },
      write: (chunk) => statusOutput.push(String(chunk)),
    });
    await configCommand(["show", "--json"], {
      dataDir,
      env: { MY_IDX: referencedUrl },
      write: (chunk) => statusOutput.push(String(chunk)),
    });
    assert.doesNotMatch(statusOutput.join("\n"), new RegExp(secret));

    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "history", VOTER, "--dao", "ens", "--stdout"], {
        cwd: ROOT,
        env: {
          ...process.env,
          GAVEL_DATA_DIR: dataDir,
          GAVEL_STRUCTURED_ERRORS: "1",
          MY_IDX: referencedUrl,
        },
      }),
      (error) => {
        const output = `${error.stdout}\n${error.stderr}\n${error.message}`;
        return !output.includes(secret) && /RETRYABLE_INFRASTRUCTURE/.test(output);
      },
    );
  }
});

test("transport errors retain a safe cause code but never raw fetch text", async () => {
  const secret = "GAVEL_FETCH_ERROR_SECRET_SENTINEL";
  const client = new IndexApiClient({
    baseUrl: "https://index.example",
    fetch: async () => {
      const error = new Error(`fetch failed for https://index.example/?banana=${secret}`);
      error.cause = { code: "ECONNREFUSED" };
      throw error;
    },
  });
  await assert.rejects(
    client.fetchHistory("ens", VOTER),
    (error) => /ECONNREFUSED/.test(error.message) && !error.message.includes(secret) && !/banana/.test(error.message),
  );
});

test("Railgun proposal stays on RPC unless an index endpoint is explicitly configured", async (t) => {
  const rpc = await startCountingServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "RPC_ROUTE_PROVED" } }));
  });
  t.after(() => rpc.server.close());

  for (const runtime of [{}, { indexApiUrl: "" }, { indexApiUrlVariable: "MISSING_INDEX" }]) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-railgun-rpc-"));
    await saveGavelConfig(config(runtime), { dataDir });
    const before = rpc.requests.length;
    const env = { ...process.env, GAVEL_DATA_DIR: dataDir };
    if (runtime.indexApiUrl === "") env.GAVEL_INDEX_API_URL = "https://ignored.example";
    else delete env.GAVEL_INDEX_API_URL;
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "proposal", "1", "--dao", "railgun-eth", "--rpc", rpc.url, "--stdout"], {
        cwd: ROOT,
        env,
        timeout: 10_000,
      }),
      (error) => !/INDEX_API_URL_VARIABLE_MISSING/.test(`${error.stderr}\n${error.message}`),
    );
    assert.ok(rpc.requests.length > before, JSON.stringify(runtime));
  }
});

test("Railgun proposal uses direct, named, and legacy index overrides", async (t) => {
  const index = await startCountingServer((request, response) => {
    const pathname = request.url.split("?")[0];
    const body = pathname.endsWith("/sync-status")
      ? { sources: [{ sourceId: "voting-logs", finalizedHead: "500", updatedAt: new Date().toISOString(), lastError: null }] }
      : { id: "1", dao: "railgun-eth", chainId: 1, contentHash: "ab".repeat(32), source: "INDEX_ROUTE_PROVED", identity: { dao: "railgun-eth", chainId: 1, governorAddress: "0xc480f68a3dcc3edd82134fab45c14a0fcf1da3cc", proposalId: "1" } };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  t.after(() => index.server.close());

  const cases = [
    { runtime: { indexApiUrl: index.url }, env: {} },
    { runtime: { indexApiUrlVariable: "MY_IDX" }, env: { MY_IDX: index.url } },
    { runtime: {}, env: { GAVEL_INDEX_API_URL: index.url } },
  ];
  for (const entry of cases) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-railgun-index-"));
    await saveGavelConfig(config(entry.runtime), { dataDir });
    const { stdout } = await execFileAsync(process.execPath, [CLI, "proposal", "1", "--dao", "railgun-eth", "--stdout"], {
      cwd: ROOT,
      env: { ...process.env, GAVEL_DATA_DIR: dataDir, ...entry.env },
    });
    assert.equal(JSON.parse(stdout).source, "INDEX_ROUTE_PROVED");
  }
});

test("Nouns explicit subgraph does not resolve an unrelated missing index variable", async (t) => {
  const subgraph = await startCountingServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "SUBGRAPH_ROUTE_PROVED" }));
  });
  t.after(() => subgraph.server.close());
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-nouns-subgraph-"));
  await saveGavelConfig(config({ indexApiUrlVariable: "MISSING_INDEX" }), { dataDir });
  await assert.rejects(
    execFileAsync(process.execPath, [CLI, "history", VOTER, "--dao", "nouns", "--endpoint", subgraph.url, "--stdout"], {
      cwd: ROOT,
      env: { ...process.env, GAVEL_DATA_DIR: dataDir },
    }),
    (error) => !/INDEX_API_URL_VARIABLE_MISSING/.test(`${error.stderr}\n${error.message}`),
  );
  assert.ok(subgraph.requests.length > 0);
});

test("index configuration errors are classified as user correction", () => {
  for (const code of [
    "INDEX_API_URL_INVALID",
    "INDEX_API_URL_VARIABLE_INVALID",
    "INDEX_API_URL_VARIABLE_MISSING",
    "INDEX_URL_CARRIES_CREDENTIALS",
  ]) {
    const error = Object.assign(new Error("fix index configuration"), { code });
    const failure = classifyOperationalFailure("history", error);
    assert.equal(failure.category, "USER_CORRECTION_REQUIRED");
    assert.equal(failure.retryable, false);
  }
});

test("TUI resolves index precedence after persisted config and degrades invalid references", async () => {
  let dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-tui-direct-"));
  await saveGavelConfig(config({ indexApiUrl: "https://direct.example", indexApiUrlVariable: "MISSING_INDEX" }), { dataDir });
  let loaded = await runTuiConfig(dataDir, { GAVEL_INDEX_API_URL: "junk" });
  assert.deepEqual(loaded.document, {
    url: "https://direct.example",
    metadata: { source: "config", variable: null, status: "configured" },
  });

  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-tui-missing-"));
  await saveGavelConfig(config({ indexApiUrlVariable: "MISSING_INDEX" }), { dataDir });
  loaded = await runTuiConfig(dataDir, {});
  assert.equal(loaded.document.url, "");
  assert.deepEqual(loaded.document.metadata, { source: "environment", variable: "MISSING_INDEX", status: "missing" });

  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-tui-invalid-"));
  await saveGavelConfig(config(), { dataDir });
  loaded = await runTuiConfig(dataDir, { GAVEL_INDEX_API_URL: "junk" });
  assert.equal(loaded.document.url, "");
  assert.equal(loaded.document.metadata.status, "invalid");

  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-tui-disabled-"));
  await saveGavelConfig(config({ indexApiUrl: "" }), { dataDir });
  loaded = await runTuiConfig(dataDir, { GAVEL_INDEX_API_URL: "junk" });
  assert.deepEqual(loaded.document, {
    url: "",
    metadata: { source: "config", variable: null, status: "disabled" },
  });
});
