// Companion to governance-index-postgres.test.js. Covers migrate version
// reporting and the least-privilege role gates. Skips without GAVEL_TEST_DATABASE_URL.
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

function runCli(args, extra = {}) {
  const env = { ...process.env, DATABASE_URL: ADMIN_URL, ...extra };
  for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) delete env[key];
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  const lines = String(result.stdout || "").trim().split("\n").filter(Boolean);
  let json = null;
  try { json = JSON.parse(lines.at(-1)); } catch { /* reported through stdout below */ }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

async function dropApplicationRoles(store) {
  for (const role of ["gavel_api", "gavel_indexer"]) {
    try {
      await store.pool.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN EXECUTE 'DROP OWNED BY ${role}'; END IF; END $$;`);
      await store.pool.query(`DROP ROLE IF EXISTS ${role}`);
    } catch { /* checked by the caller */ }
  }
  return (await store.pool.query(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('gavel_indexer','gavel_api')",
  )).rows.map((row) => row.rolname);
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

test("migrate reports skipped role grants instead of failing silently", { skip }, async (t) => {
  const store = new PostgresGovernanceStore({ connectionString: ADMIN_URL, maxConnections: 4 });
  try {
    await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const remaining = await dropApplicationRoles(store);
    if (remaining.length) {
      t.skip(`roles ${remaining.join(",")} are in use by another database in this cluster`);
      return;
    }
    const result = await store.migrate({ env: {} });
    assert.equal(result.roles, "skipped");
    // version is the last schema file applied on the skipped-role path.
    // 002_roles is not applied when the roles do not exist; 003 still is.
    assert.equal(result.version, "003_proposal_lifecycle");
    assert.deepEqual(result.versions, ["001_initial", "003_proposal_lifecycle"]);
    assert.deepEqual(result.missingRoles, ["gavel_indexer", "gavel_api"]);
    assert.match(result.reason, /GAVEL_INDEXER_DB_PASSWORD/);
    assert.match(result.warning, /verify-permissions/);
    assert.equal(runCli(["migrate"], { GAVEL_INDEXER_DB_PASSWORD: "", GAVEL_API_DB_PASSWORD: "" }).status, 2,
      "migrate must not exit 0 while the least-privilege roles are missing");
  } finally { await store.close(); }
});

test("a fresh database provisions the application roles and reports the verified state", { skip }, async (t) => {
  const store = new PostgresGovernanceStore({ connectionString: ADMIN_URL, maxConnections: 4 });
  try {
    await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const remaining = await dropApplicationRoles(store);
    if (remaining.length) {
      t.skip(`roles ${remaining.join(",")} are in use by another database in this cluster`);
      return;
    }
    const migrated = runCli(["migrate"], {
      GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD,
      GAVEL_API_DB_PASSWORD: API_PASSWORD,
    });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(migrated.json.ok, true);
    assert.equal(migrated.json.version, "002_roles");
    assert.ok(migrated.json.versions.includes("001_initial"));
    assert.ok(migrated.json.versions.includes("003_proposal_lifecycle"));
    assert.ok(migrated.json.versions.includes("002_roles"));
    assert.equal(migrated.json.roles, "granted");
    assert.deepEqual(migrated.json.rolesCreated, ["gavel_indexer", "gavel_api"]);
    assert.deepEqual(migrated.json.verified.gavel_api, { ok: true, method: "effective", read: true, write: false, ddl: false });
    assert.deepEqual(migrated.json.verified.gavel_indexer, { ok: true, method: "effective", read: true, write: true, ddl: false });
    assert.equal(migrated.json.warning, undefined);
    const again = runCli(["migrate"], { GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD, GAVEL_API_DB_PASSWORD: API_PASSWORD });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json.roles, "granted");
    assert.deepEqual(again.json.rolesCreated, []);
  } finally { await store.close(); }
});

test("the API role cannot write governance data", { skip }, async () => {
  const store = new PostgresGovernanceStore({ connectionString: ADMIN_URL, maxConnections: 4 });
  try {
    await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await withApplicationRoles(store);
    const migrated = await store.migrate();
    assert.equal(migrated.roles, "granted", "role grants must be applied when the roles exist");
    const verified = await store.verifyPermissions("gavel_api");
    assert.deepEqual(verified.writable, [], "gavel_api must hold no write privilege on any table");
    assert.equal(verified.ok, true);
    assert.ok(verified.tables >= 9);
    const indexer = await store.verifyPermissions("gavel_indexer");
    assert.equal(indexer.ok, false, "gavel_indexer is expected to hold write privileges");
    const readonly = new PostgresGovernanceStore({ connectionString: roleUrl("gavel_api", API_PASSWORD), maxConnections: 2 });
    try {
      await assert.rejects(readonly.pool.query("INSERT INTO daos(id,chain_id,from_block) VALUES('evil',1,1)"), /permission denied/);
      await assert.rejects(readonly.pool.query("DELETE FROM vote_events"), /permission denied/);
      await assert.rejects(readonly.pool.query("CREATE TABLE injected(x int)"), /permission denied/);
      await assert.doesNotReject(readonly.pool.query("SELECT count(*) FROM daos"));
    } finally { await readonly.close(); }
  } finally { await store.close(); }
});
