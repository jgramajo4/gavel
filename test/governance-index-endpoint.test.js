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

const { DEFAULT_INDEX_API_URL } = require("../packages/governance-index");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "packages", "cli", "bin", "gavel.js");
const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";
const TX = `0x${"a".repeat(64)}`;

function indexedProposal() {
  return {
    id: "1", contentHash: crypto.createHash("sha256").update("ens-1").digest("hex"),
    title: "Indexed", description: "Body", proposer: VOTER, state: "EXECUTED", outcome: "PASSED",
    createdBlock: "100", createdAt: "2023-11-14T22:13:20.000Z", startBlock: "110", endBlock: "200",
    quorumVotes: "10", forVotes: "9", againstVotes: "1", abstainVotes: "0", actions: [], dao: "ens", chainId: 1,
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
        : indexedProposal();
    const payload = JSON.stringify(body);
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
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
        // Still reads as infrastructure to a structured-error consumer.
        && /fetch failed/.test(error.message),
    );

    // An operator who chose an endpoint is not told to set the variable again,
    // and a credential-bearing endpoint is never echoed back.
    const override = new IndexApiClient({ fetch: failing, baseUrl: "https://user:secret@index.example/base" });
    await assert.rejects(override.fetchHistory("ens", VOTER), (error) =>
      !/set GAVEL_INDEX_API_URL/.test(error.message) && !/secret/.test(error.message));
  } finally {
    if (previous === undefined) delete process.env.GAVEL_INDEX_API_URL;
    else process.env.GAVEL_INDEX_API_URL = previous;
  }
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
