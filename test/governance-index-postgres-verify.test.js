const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PostgresGovernanceStore } = require("../packages/governance-index/src/postgres-store");
const { ensureRoles } = require("../packages/governance-index/src/roles");

const CLI = path.join(__dirname, "..", "packages", "governance-index", "bin", "gavel-indexer.js");
const INDEXER_PASSWORD = "indexer-test-only";
const API_PASSWORD = "api-test-only";
const ADMIN_URL = process.env.GAVEL_TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : "set GAVEL_TEST_DATABASE_URL to run PostgreSQL integration tests";
const ADDRESS = "0x0000000000000000000000000000000000000001";
const GOVERNOR = "0x323A76393544d5ecca80cd6ef2A560C6a395b7E3";
const TX = `0x${"11".repeat(32)}`;

function runCli(args, extra = {}) {
  const env = { ...process.env, DATABASE_URL: ADMIN_URL, ...extra };
  for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) delete env[key];
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  let json = null;
  try { json = JSON.parse(lines.at(-1)); } catch {}
  return { status: result.status, json, stderr: result.stderr };
}

async function withApplicationRoles(store) {
  await ensureRoles(store.pool, {
    env: { GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD, GAVEL_API_DB_PASSWORD: API_PASSWORD },
  });
  for (const [role, password] of [["gavel_indexer", INDEXER_PASSWORD], ["gavel_api", API_PASSWORD]]) {
    const statement = (await store.pool.query(
      "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS stmt", [role, password],
    )).rows[0].stmt;
    await store.pool.query(statement);
  }
}

function roleUrl(role, password) {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function freshStore() {
  const store = new PostgresGovernanceStore({ connectionString: ADMIN_URL, maxConnections: 4 });
  await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await store.migrate();
  await store.transaction(async (tx) => {
    await tx.upsertDao({ id: "ens", name: "ENS", chainId: 1, contractAddress: GOVERNOR, currentGovernor: GOVERNOR, fromBlock: 5 });
    await tx.upsertSource({ daoId: "ens", id: "governor-logs", kind: "ens-governor-logs", endpoint: "https://rpc.example/key", publicEndpoint: "https://rpc.example", fromBlock: 5 });
  });
  return store;
}

test("verify-permissions proves gavel_api is read-only by acting as the role", { skip }, async () => {
  const store = await freshStore();
  try {
    await withApplicationRoles(store);
    await store.migrate();
    const verified = runCli(["verify-permissions", "--role", "gavel_api"]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(
      { ok: verified.json.ok, role: verified.json.role, read: verified.json.read, write: verified.json.write, ddl: verified.json.ddl },
      { ok: true, role: "gavel_api", read: true, write: false, ddl: false },
    );
    assert.equal(verified.json.method, "effective");
    assert.deepEqual(verified.json.writable, []);
    assert.deepEqual(verified.json.violations, []);
    const indexer = runCli(["verify-permissions", "--role", "gavel_indexer"]);
    assert.equal(indexer.status, 2);
    assert.equal(indexer.json.ok, false);
    const writer = runCli(["verify-permissions", "--role", "gavel_indexer", "--expect", "read-write"]);
    assert.equal(writer.status, 0, writer.stderr);
    assert.equal(writer.json.write, true);
    assert.equal(writer.json.ddl, false);
  } finally { await store.close(); }
});

test("gavel_api can read and cannot write over a real connection", { skip }, async () => {
  const store = await freshStore();
  try {
    await withApplicationRoles(store);
    await store.migrate();
    const readonly = new PostgresGovernanceStore({ connectionString: roleUrl("gavel_api", API_PASSWORD), maxConnections: 2 });
    try {
      await assert.doesNotReject(readonly.pool.query("SELECT count(*) FROM daos"));
      await assert.rejects(readonly.pool.query("INSERT INTO daos(id,chain_id,from_block) VALUES('evil',1,1)"), /permission denied/);
      await assert.rejects(readonly.pool.query("DELETE FROM vote_events"), /permission denied/);
      await assert.rejects(readonly.pool.query("CREATE TABLE injected(x int)"), /permission denied/);
    } finally { await readonly.close(); }
  } finally { await store.close(); }
});
