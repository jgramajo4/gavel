const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFile, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const { IndexApiClient, DEFAULT_INDEX_API_URL } = require("../packages/governance-index");
const { classifyOperationalFailure } = require("../packages/core/src/operations/failure");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "packages", "cli", "bin", "gavel.js");
const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";
const TX = `0x${"a".repeat(64)}`;

function indexedProposal(dao = "ens") {
  const governors = {
    ens: "0x323a76393544d5ecca80cd6ef2a560c6a395b7e3",
    nouns: "0x6f3e6272a167e8accb32072d08e0957f9c79223d",
  };
  return {
    id: "1", contentHash: crypto.createHash("sha256").update("ens-1").digest("hex"),
    title: "Indexed", description: "Body", proposer: VOTER, state: "EXECUTED", outcome: "PASSED",
    createdBlock: "100", createdAt: "2023-11-14T22:13:20.000Z", startBlock: "110", endBlock: "200",
    quorumVotes: "10", forVotes: "9", againstVotes: "1", abstainVotes: "0", actions: [], dao, chainId: 1,
    identity: { dao, chainId: 1, governorAddress: governors[dao], proposalId: "1" },
  };
}

/** Minimal stand-in for the read-only API, on an ephemeral loopback port. */
async function startStubIndex() {
  const server = http.createServer((req, res) => {
    const pathname = req.url.split("?")[0];
    const body = pathname.endsWith("/sync-status")
      ? { dao: "ens", sources: [{ sourceId: "governor-logs", finalizedHead: "500", updatedAt: new Date().toISOString(), lastError: null }] }
      : pathname.endsWith("/history")
        ? { items: [{ chainId: 1, proposalId: "1", voter: VOTER, support: "FOR", reason: null, blockNumber: "150",
            timestamp: "2023-11-14T22:15:00.000Z", voteWeight: "5", clientId: 0, sourceKind: "ens-governor",
            sourceEndpoint: "https://rpc.example", entityId: "e1", transactionHash: TX, logIndex: 0, observedHead: "500" }], nextCursor: null }
        : indexedProposal(pathname.includes("/nouns/") ? "nouns" : "ens");
    const payload = JSON.stringify(body);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function startRateLimitedIndex() {
  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0].endsWith("/sync-status")) {
      const payload = JSON.stringify({
        dao: "nouns",
        sources: [{ sourceId: "nouns-subgraph", finalizedHead: "500", updatedAt: new Date().toISOString(), lastError: null }],
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
    res.end(JSON.stringify({ error: "rate_limited" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test("GAVEL_INDEX_API_URL overrides the default and serves an indexed history through the CLI", async (t) => {
  const { server, url } = await startStubIndex();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-index-endpoint-"));
  t.after(() => { server.close(); fs.rmSync(temporary, { recursive: true, force: true }); });

  // The stub runs in this process, so the child must be spawned asynchronously:
  // a synchronous spawn would block the event loop that has to serve it.
  const { stdout } = await execFileAsync(process.execPath, [cli, "history", VOTER, "--dao", "ens", "--stdout"], {
    cwd: temporary, encoding: "utf8",
    env: { ...process.env, GAVEL_INDEX_API_URL: url, GAVEL_DATA_DIR: path.join(temporary, "state") },
  });

  const document = JSON.parse(stdout);
  assert.equal(document.dao, "ens");
  assert.equal(document.voteCount, 1);
  assert.equal(document.source.endpoint, url, "an operator's index is used verbatim, not the public default");
});

test("ENS and Railgun no longer require GAVEL_INDEX_API_URL to be configured", () => {
  // The public default makes these zero-config. Whatever happens next is a
  // network or freshness outcome; it must never be a missing-configuration
  // error, which is what the CLI used to raise before an endpoint was set.
  for (const dao of ["ens", "railgun-eth"]) {
    const env = { ...process.env, GAVEL_STRUCTURED_ERRORS: "1" };
    delete env.GAVEL_INDEX_API_URL;
    const result = spawnSync(process.execPath, [cli, "history", VOTER, "--dao", dao, "--stdout"], {
      cwd: os.tmpdir(), encoding: "utf8", env, timeout: 60_000,
    });
    assert.doesNotMatch(result.stderr, /requires GAVEL_INDEX_API_URL/, dao);
    assert.doesNotMatch(result.stderr, /GAVEL_INDEX_API_URL must be an HTTP\(S\) URL/, dao);
  }
});

test("a transport failure names the endpoint and how to change it", async () => {
  const { IndexApiClient } = require("../packages/governance-index");
  const previous = process.env.GAVEL_INDEX_API_URL;
  const failing = async () => { throw new Error("fetch failed"); };
  try {
    delete process.env.GAVEL_INDEX_API_URL;
    await assert.rejects(
      new IndexApiClient({ fetch: failing }).fetchHistory("ens", VOTER),
      (error) => error.message.includes(DEFAULT_INDEX_API_URL)
        && /set GAVEL_INDEX_API_URL/.test(error.message)
        // Still reads as infrastructure to a structured-error consumer without
        // copying arbitrary transport text into the diagnostic.
        && !/fetch failed/.test(error.message),
    );

    // Userinfo is rejected before any request, and the credential is never echoed.
    assert.throws(
      () => new IndexApiClient({ fetch: failing, baseUrl: "https://user:secret@index.example/base" }),
      (error) => /must not contain URL userinfo/.test(error.message) && !/secret/.test(error.message),
    );
    assert.throws(
      () => new IndexApiClient({ fetch: failing, baseUrl: "not-a-url-GAVEL_SECRET_SENTINEL" }),
      (error) => /must be an HTTP\(S\) URL/.test(error.message) && !/GAVEL_SECRET_SENTINEL/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.GAVEL_INDEX_API_URL;
    else process.env.GAVEL_INDEX_API_URL = previous;
  }
});

test("index transport failures use a stable retryable code and allow-listed cause", async () => {
  const sentinel = "SENTINEL_N1_REVIEW_556677";
  const cases = [
    { label: "connection refused", error: Object.assign(new Error(sentinel), { code: "ECONNREFUSED" }), cause: "ECONNREFUSED" },
    { label: "DNS missing", error: Object.assign(new Error(sentinel), { cause: { code: "ENOTFOUND" } }), cause: "ENOTFOUND" },
    { label: "DNS temporary", error: Object.assign(new Error(sentinel), { cause: { code: "EAI_AGAIN" } }), cause: "EAI_AGAIN" },
    { label: "timeout", error: Object.assign(new Error(sentinel), { name: "TimeoutError" }), cause: "ETIMEDOUT" },
    { label: "request abort", error: Object.assign(new Error(sentinel), { name: "AbortError" }), cause: "ETIMEDOUT" },
    { label: "unknown fetch failure", error: new Error(sentinel), cause: null },
  ];

  for (const entry of cases) {
    const client = new IndexApiClient({
      baseUrl: `https://index.example/private/${sentinel}?token=${sentinel}`,
      fetch: async () => { throw entry.error; },
    });
    assert.doesNotMatch(client.publicBaseUrl, new RegExp(sentinel), `${entry.label} provenance`);
    const error = await client.fetchHistory("ens", VOTER).catch((caught) => caught);
    assert.equal(error.code, "GAVEL_INDEX_UNREACHABLE", entry.label);
    assert.equal(error.transportCause, entry.cause, entry.label);
    assert.doesNotMatch(error.message, new RegExp(sentinel), entry.label);
    const failure = classifyOperationalFailure("history", error);
    assert.equal(failure.category, "RETRYABLE_INFRASTRUCTURE", entry.label);
    assert.equal(failure.retryable, true, entry.label);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(sentinel), entry.label);
  }
});

test("index HTTP status classification keeps existing 4xx and 5xx policy", async () => {
  for (const [status, category, retryable] of [
    [400, "SOFTWARE_DEFECT", false],
    [503, "RETRYABLE_INFRASTRUCTURE", true],
  ]) {
    const client = new IndexApiClient({
      baseUrl: "https://index.example",
      fetch: async () => ({ ok: false, status, headers: { get: () => null } }),
    });
    const error = await client.fetchHistory("ens", VOTER).catch((caught) => caught);
    assert.equal(error.code, undefined);
    const failure = classifyOperationalFailure("history", error);
    assert.equal(failure.category, category, status);
    assert.equal(failure.retryable, retryable, status);
  }
});

test("Nouns reads the index by default and --endpoint is the subgraph opt-out", async (t) => {
  const { server, url } = await startStubIndex();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-nouns-source-"));
  t.after(() => { server.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const env = { ...process.env, GAVEL_INDEX_API_URL: url, GAVEL_DATA_DIR: path.join(temporary, "state") };

  // A Nouns history is hundreds of paginated subgraph queries per user; the
  // index answers it once, so it is the default source.
  const { stdout } = await execFileAsync(process.execPath, [cli, "history", VOTER, "--dao", "nouns", "--stdout"], {
    cwd: temporary, encoding: "utf8", env,
  });
  const document = JSON.parse(stdout);
  assert.equal(document.source.kind, "gavel-governance-index");
  assert.equal(document.source.endpoint, url);

  // `--endpoint` sends the same command back to a subgraph. Pointing it at the
  // stub proves the opt-out changes transport, without reaching the network.
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "history", VOTER, "--dao", "nouns", "--endpoint", `${url}/subgraph`, "--stdout"], {
      cwd: temporary, encoding: "utf8", env,
    }),
    (error) => !/gavel-governance-index/.test(error.stdout || ""),
    "--endpoint must not fall through to the index",
  );
});

test("CLI history does not persist a partial artifact after a rate-limited index", async (t) => {
  const { server, url } = await startRateLimitedIndex();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-index-429-"));
  t.after(() => { server.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const env = { ...process.env, GAVEL_INDEX_API_URL: url };
  delete env.GAVEL_DATA_DIR;
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "history", VOTER, "--dao", "nouns"], {
      cwd: temporary, encoding: "utf8", env,
    }),
    (error) => {
      const text = `${error.stderr || ""}\n${error.message || ""}`;
      return /history source is temporarily rate-limited/i.test(text)
        && /no vote can be prepared until history sync completes/i.test(text)
        && !/GAVEL_INDEX_API_URL/.test(text);
    },
  );
  const defaultHistory = path.join(temporary, "data", "private", "nouns", `${VOTER.toLowerCase()}.json`);
  assert.equal(fs.existsSync(defaultHistory), false);
  assert.equal(fs.existsSync(path.join(temporary, "data", "private")), false);
});

test("the TUI default index endpoint matches the client's", () => {
  const constants = fs.readFileSync(path.join(root, "packages", "tui", "src", "constants.ts"), "utf8");
  const declared = constants.match(/INDEX_API_URL:\s*'([^']*)'/);
  assert.ok(declared, "the TUI must declare a default index endpoint");
  assert.equal(declared[1], DEFAULT_INDEX_API_URL, "TUI and CLI must not drift apart");
});

test("the ENS adapter reports a missing loader without naming an endpoint variable", async () => {
  const { EnsDaoAdapter } = require("../packages/ens-adapter");
  await assert.rejects(
    new EnsDaoAdapter({ provider: {} }).fetchProposal("1"),
    (error) => /requires an indexed proposal loader/.test(error.message) && !/GAVEL_INDEX_API_URL/.test(error.message),
  );
});

test("the documented default endpoint is the one the client ships", () => {
  const readme = fs.readFileSync(path.join(root, "packages", "governance-index", "README.md"), "utf8");
  assert.ok(readme.includes(DEFAULT_INDEX_API_URL), "the index README must document the shipped default");
  const env = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  assert.match(env, /GAVEL_INDEX_API_URL/);
  // No runtime documentation may show a credential-bearing index URL.
  for (const file of [
    "README.md",
    ".env.example",
    "docs/runtimes/generic-cli.md",
    "packages/governance-index/README.md",
    "integrations/hermes/references/runtime.md",
    "nouns-dao/references/bankr-runtime.md",
  ]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /https?:\/\/[^\s/@]+:[^\s/@]+@/, `${file} must not show credentials in a URL`);
  }
});
