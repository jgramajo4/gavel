// Integration tests against a real PostgreSQL server. These cover what a
// query() stub cannot: that the migration actually executes, that the canonical
// uniqueness constraints hold, that ingestion is idempotent, and that the API
// role genuinely cannot write.
//
// Set GAVEL_TEST_DATABASE_URL to a database the test may create and drop
// objects in. Without it the suite skips rather than silently passing.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { PostgresGovernanceStore } = require("../packages/governance-index/src/postgres-store");
const { ensureRoles } = require("../packages/governance-index/src/roles");

const CLI = path.join(__dirname, "..", "packages", "governance-index", "bin", "gavel-indexer.js");
const INDEXER_PASSWORD = "indexer-test-only";
const API_PASSWORD = "api-test-only";

// The CLI is the deployment interface, so the exit codes Terra gates on are
// exercised by running it, not by calling the store directly.
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
  // Roles are cluster-scoped, so they may hold grants in databases this test
  // cannot reach. Drop what is owned here and report whether they really went.
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

// Pins the role passwords so the wire-level assertions do not depend on
// whatever a previous run or a previous deployment left in the cluster.
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

// The probe role holds a schema grant, and PostgreSQL refuses to drop a role
// anything still depends on. Revoke what it owns first, or the role survives the
// run and the next one skips this test instead of running it.
async function dropProbeRole(store, role) {
  await store.pool.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN EXECUTE 'DROP OWNED BY ${role}'; END IF; END $$;`);
  await store.pool.query(`DROP ROLE IF EXISTS ${role}`);
}

function roleUrl(role, password) {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = password;
  return url.toString();
}

const ADMIN_URL = process.env.GAVEL_TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : "set GAVEL_TEST_DATABASE_URL to run PostgreSQL integration tests";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const OTHER = "0x0000000000000000000000000000000000000002";
const GOVERNOR = "0x323A76393544d5ecca80cd6ef2A560C6a395b7E3";
const TX = `0x${"11".repeat(32)}`;
const TX2 = `0x${"22".repeat(32)}`;

function voteRow(overrides = {}) {
  return {
    daoId: "ens", chainId: 1, contractAddress: GOVERNOR, proposalId: "1", voter: ADDRESS,
    support: "FOR", reason: null, voteWeight: "100", blockNumber: "10",
    timestamp: new Date(1_700_000_000_000).toISOString(), transactionHash: TX, logIndex: 0,
    sourceKind: "ens-governor-logs", sourceEndpoint: "https://rpc.example", observedHead: "20",
    ...overrides,
  };
}

function record(overrides = {}) {
  const { vote, ...rest } = overrides;
  return {
    raw: {
      daoId: "ens", sourceId: "governor-logs", chainId: 1, contractAddress: GOVERNOR,
      transactionHash: TX, logIndex: 0, blockNumber: "10", blockHash: null, recordType: "vote",
      proposalId: "1", payload: { topics: [], data: "0x" }, sourceKind: "ens-governor-logs",
      sourceEndpoint: "https://rpc.example", observedHead: "20", ...rest,
    },
    vote: vote === null ? undefined : voteRow(vote),
  };
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

test("migration applies against a real PostgreSQL server", { skip }, async () => {
  const store = await freshStore();
  try {
    const tables = (await store.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )).rows.map((row) => row.tablename);
    assert.deepEqual(tables, [
      "daos", "delegation_events", "governance_sources", "proposal_actions",
      "proposals", "raw_governance_records", "schema_migrations", "sync_checkpoints", "vote_events",
    ]);
    const applied = (await store.pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map((row) => row.version);
    assert.ok(applied.includes("001_initial"));
  } finally { await store.close(); }
});

test("canonical event identity rejects a duplicate transaction hash and log index", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.transaction(async (tx) => { await tx.insertVote(voteRow()); });
    await assert.rejects(
      store.transaction(async (tx) => {
        await tx.client.query(`
          INSERT INTO vote_events(dao_id,chain_id,contract_address,proposal_id,voter,support,vote_weight,
            block_number,block_time,transaction_hash,log_index,source_kind,source_endpoint,source_public_endpoint,observed_head)
          VALUES('ens',1,$1,'1',$2,'AGAINST','5',10,now(),$3,0,'k','https://e','https://e',20)
        `, [GOVERNOR, OTHER, TX]);
      }),
      /duplicate key value violates unique constraint/,
    );
  } finally { await store.close(); }
});

test("re-ingesting the same batch is idempotent and repairs a dropped vote", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.transaction(async (tx) => { assert.equal(await tx.ingest(record()), true); });
    await store.transaction(async (tx) => { assert.equal(await tx.ingest(record()), false); });
    const counts = async () => ({
      raw: Number((await store.pool.query("SELECT count(*) c FROM raw_governance_records")).rows[0].c),
      votes: Number((await store.pool.query("SELECT count(*) c FROM vote_events")).rows[0].c),
    });
    assert.deepEqual(await counts(), { raw: 1, votes: 1 });

    // Simulate a vote lost by an earlier partial write: the raw record survives
    // but the normalized row is gone. Re-running the sync must restore it.
    await store.pool.query("DELETE FROM vote_events");
    await store.transaction(async (tx) => { await tx.ingest(record()); });
    assert.deepEqual(await counts(), { raw: 1, votes: 1 });
  } finally { await store.close(); }
});

test("a failed batch leaves the checkpoint un-advanced", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.transaction(async (tx) => {
      await tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 100, finalizedHead: 100, lastError: null });
    });
    await assert.rejects(store.transaction(async (tx) => {
      await tx.ingest(record());
      await tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 200, finalizedHead: 200, lastError: null });
      throw new Error("batch blew up after writing");
    }), /batch blew up/);
    const checkpoint = await store.getCheckpoint("ens", "governor-logs");
    assert.equal(checkpoint.nextBlock, "100", "checkpoint must not advance past uncommitted data");
    assert.equal(Number((await store.pool.query("SELECT count(*) c FROM raw_governance_records")).rows[0].c), 0);
  } finally { await store.close(); }
});

test("checkpoints never regress and preserve the last full-scan stamp", { skip }, async () => {
  const store = await freshStore();
  try {
    const stamp = new Date(1_700_000_000_000).toISOString();
    await store.transaction(async (tx) => {
      await tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 500, finalizedHead: 500, lastFullScanAt: stamp, lastError: null });
    });
    await store.transaction(async (tx) => {
      await tx.setCheckpoint({ daoId: "ens", sourceId: "governor-logs", nextBlock: 100, finalizedHead: 100, lastError: "boom" });
    });
    const checkpoint = await store.getCheckpoint("ens", "governor-logs");
    assert.equal(checkpoint.nextBlock, "500");
    assert.equal(new Date(checkpoint.lastFullScanAt).toISOString(), stamp);
    assert.match(checkpoint.lastError, /boom/);
  } finally { await store.close(); }
});

test("reorg replay removes an event that disappeared from the canonical range", { skip }, async () => {
  const store = await freshStore();
  try {
    await store.transaction(async (tx) => {
      await tx.ingest(record());
      await tx.ingest(record({ transactionHash: TX2, logIndex: 1, vote: { transactionHash: TX2, logIndex: 1 } }));
    });
    assert.equal(Number((await store.pool.query("SELECT count(*) c FROM vote_events")).rows[0].c), 2);
    // The second event is no longer in the canonical range on replay.
    await store.transaction(async (tx) => {
      await tx.reconcileRange({ daoId: "ens", sourceId: "governor-logs", fromBlock: 1, toBlock: 50, records: [record()] });
    });
    const rows = (await store.pool.query("SELECT transaction_hash FROM vote_events")).rows;
    assert.deepEqual(rows.map((row) => row.transaction_hash), [TX]);
    assert.equal(Number((await store.pool.query("SELECT count(*) c FROM raw_governance_records")).rows[0].c), 1);
  } finally { await store.close(); }
});

test("credential-bearing endpoints are never persisted", { skip }, async () => {
  const store = await freshStore();
  try {
    const secret = "https://user:pass@rpc.example/v3/SUPERSECRET?apikey=hidden";
    await store.transaction(async (tx) => {
      await tx.upsertSource({ daoId: "ens", id: "governor-logs", kind: "ens-governor-logs", endpoint: secret, fromBlock: 5 });
      await tx.ingest(record({ sourceEndpoint: secret, vote: { sourceEndpoint: secret } }));
    });
    const dumped = JSON.stringify((await store.pool.query(`
      SELECT (SELECT json_agg(g) FROM governance_sources g) sources,
             (SELECT json_agg(r) FROM raw_governance_records r) raws,
             (SELECT json_agg(v) FROM vote_events v) votes
    `)).rows[0]);
    assert.doesNotMatch(dumped, /SUPERSECRET|hidden|user:pass/);
    assert.match(dumped, /https:\/\/rpc\.example/);
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

    // And the indexer role genuinely can write.
    const indexer = await store.verifyPermissions("gavel_indexer");
    assert.equal(indexer.ok, false, "gavel_indexer is expected to hold write privileges");

    // Prove it at the wire level, not just via catalog privileges.
    const readonly = new PostgresGovernanceStore({ connectionString: roleUrl("gavel_api", API_PASSWORD), maxConnections: 2 });
    try {
      await assert.rejects(
        readonly.pool.query("INSERT INTO daos(id,chain_id,from_block) VALUES('evil',1,1)"),
        /permission denied/,
      );
      await assert.rejects(readonly.pool.query("DELETE FROM vote_events"), /permission denied/);
      await assert.rejects(readonly.pool.query("CREATE TABLE injected(x int)"), /permission denied/);
      await assert.doesNotReject(readonly.pool.query("SELECT count(*) FROM daos"));
    } finally { await readonly.close(); }
  } finally { await store.close(); }
});

test("migrate reports skipped role grants instead of failing silently", { skip }, async (t) => {
  const store = new PostgresGovernanceStore({ connectionString: ADMIN_URL, maxConnections: 4 });
  try {
    await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const remaining = await dropApplicationRoles(store);
    if (remaining.length) {
      t.skip(`roles ${remaining.join(",")} are in use by another database in this cluster`);
      return;
    }
    // No role passwords in the environment, so there is nothing safe to create
    // the roles with. The schema still applies; the role state is reported.
    const result = await store.migrate({ env: {} });
    assert.equal(result.roles, "skipped");
    assert.equal(result.version, "001_initial");
    assert.deepEqual(result.missingRoles, ["gavel_indexer", "gavel_api"]);
    assert.match(result.reason, /GAVEL_INDEXER_DB_PASSWORD/);
    assert.match(result.warning, /verify-permissions/);
    assert.equal(runCli(["migrate"], { GAVEL_INDEXER_DB_PASSWORD: "", GAVEL_API_DB_PASSWORD: "" }).status, 2,
      "migrate must not exit 0 while the least-privilege roles are missing");
  } finally { await store.close(); }
});

// --- Deployment gates -------------------------------------------------------
//
// The two gates a deployment has to clear before the index serves anything:
// migrate has to report a role state that matches the database, and
// verify-permissions has to prove gavel_api cannot write.

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
    assert.equal(migrated.json.roles, "granted");
    assert.deepEqual(migrated.json.rolesCreated, ["gavel_indexer", "gavel_api"]);
    // "granted" has to mean verified, not merely attempted.
    assert.deepEqual(migrated.json.verified.gavel_api, { ok: true, method: "effective", read: true, write: false, ddl: false });
    assert.deepEqual(migrated.json.verified.gavel_indexer, { ok: true, method: "effective", read: true, write: true, ddl: false });
    assert.equal(migrated.json.warning, undefined);

    // Re-running migrate on the same database is a no-op that still verifies.
    const again = runCli(["migrate"], { GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD, GAVEL_API_DB_PASSWORD: API_PASSWORD });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.json.roles, "granted");
    assert.deepEqual(again.json.rolesCreated, []);
  } finally { await store.close(); }
});

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
    // The result must come from executed statements, not from a privilege table.
    assert.equal(verified.json.method, "effective");
    assert.deepEqual(verified.json.writable, []);
    assert.deepEqual(verified.json.violations, []);
    assert.equal(verified.json.attributes.superuser, false);

    // The same command against the writer role is expected to fail: the default
    // expectation is read-only, and gavel_indexer is not.
    const indexer = runCli(["verify-permissions", "--role", "gavel_indexer"]);
    assert.equal(indexer.status, 2);
    assert.equal(indexer.json.ok, false);
    // ...and passes when asked the question it can answer yes to.
    const writer = runCli(["verify-permissions", "--role", "gavel_indexer", "--expect", "read-write"]);
    assert.equal(writer.status, 0, writer.stderr);
    assert.equal(writer.json.write, true);
    assert.equal(writer.json.ddl, false);
  } finally { await store.close(); }
});

test("verify-permissions exits 2 when the role can write or run DDL", { skip }, async () => {
  const store = await freshStore();
  try {
    await withApplicationRoles(store);
    await store.migrate();

    await store.pool.query("GRANT INSERT ON vote_events TO gavel_api");
    const writable = runCli(["verify-permissions", "--role", "gavel_api"]);
    assert.equal(writable.status, 2, "an overprivileged role must fail the deployment gate");
    assert.equal(writable.json.ok, false);
    assert.equal(writable.json.write, true);
    assert.ok(writable.json.writable.includes("vote_events:INSERT"));
    assert.match(writable.json.violations.join(" "), /write privileges/);
    await store.pool.query("REVOKE INSERT ON vote_events FROM gavel_api");

    await store.pool.query("GRANT CREATE ON SCHEMA public TO gavel_api");
    const ddl = runCli(["verify-permissions", "--role", "gavel_api"]);
    assert.equal(ddl.status, 2, "a role that can create tables must fail the deployment gate");
    assert.equal(ddl.json.ddl, true);
    assert.match(ddl.json.violations.join(" "), /DDL privileges/);
    await store.pool.query("REVOKE CREATE ON SCHEMA public FROM gavel_api");

    // And the gate closes again once the extra grant is gone.
    assert.equal(runCli(["verify-permissions", "--role", "gavel_api"]).status, 0);
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
      await assert.doesNotReject(readonly.pool.query("SELECT count(*) FROM vote_events"));
      await assert.rejects(readonly.pool.query("INSERT INTO daos(id,chain_id,from_block) VALUES('evil',1,1)"), /permission denied/);
      await assert.rejects(readonly.pool.query("UPDATE daos SET name='evil'"), /permission denied/);
      await assert.rejects(readonly.pool.query("DELETE FROM vote_events"), /permission denied/);
      await assert.rejects(readonly.pool.query("TRUNCATE vote_events"), /permission denied|must be owner/);
      await assert.rejects(readonly.pool.query("CREATE TABLE injected(x int)"), /permission denied/);
      await assert.rejects(readonly.pool.query("ALTER TABLE daos ADD COLUMN injected int"), /must be owner|permission denied/);
      await assert.rejects(readonly.pool.query("DROP TABLE vote_events"), /must be owner|permission denied/);
    } finally { await readonly.close(); }
  } finally { await store.close(); }
});

test("a redeploy onto an existing database restores the roles without losing data", { skip }, async (t) => {
  const store = await freshStore();
  try {
    await withApplicationRoles(store);
    await store.migrate();
    await store.transaction(async (tx) => { await tx.insertVote(voteRow()); });
    const before = Number((await store.pool.query("SELECT count(*) c FROM vote_events")).rows[0].c);
    assert.equal(before, 1);

    // Stand in for a PostgreSQL volume created before the roles existed: the
    // entrypoint init script will not run again, so migrate has to converge.
    const remaining = await dropApplicationRoles(store);
    if (remaining.length) {
      t.skip(`roles ${remaining.join(",")} are in use by another database in this cluster`);
      return;
    }
    const redeployed = runCli(["migrate"], {
      GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD,
      GAVEL_API_DB_PASSWORD: API_PASSWORD,
    });
    assert.equal(redeployed.status, 0, redeployed.stderr);
    assert.equal(redeployed.json.roles, "granted");
    assert.deepEqual(redeployed.json.rolesCreated, ["gavel_indexer", "gavel_api"]);
    assert.equal(runCli(["verify-permissions", "--role", "gavel_api"]).status, 0);
    // The indexed data is still there: no wipe was required to fix the roles.
    assert.equal(Number((await store.pool.query("SELECT count(*) c FROM vote_events")).rows[0].c), before);
  } finally { await store.close(); }
});

test("ensure-roles is idempotent and reports why it could not act", { skip }, async () => {
  const store = await freshStore();
  try {
    await withApplicationRoles(store);
    const present = await store.ensureRoles({
      env: { GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD, GAVEL_API_DB_PASSWORD: API_PASSWORD },
    });
    assert.deepEqual(present, { state: "present", created: [], missing: [] });
  } finally { await store.close(); }
});

test("role state is reported honestly when the connection cannot create roles or prove privileges", { skip }, async (t) => {
  const store = new PostgresGovernanceStore({ connectionString: ADMIN_URL, maxConnections: 4 });
  const limited = "gavel_verify_probe";
  const password = "probe-test-only";
  let unprivileged = null;
  try {
    await store.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await withApplicationRoles(store);
    await store.migrate();
    try {
      await dropProbeRole(store, limited);
      const statement = (await store.pool.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS stmt",
        [limited, password],
      )).rows[0].stmt;
      await store.pool.query(statement);
      // It needs to see the schema to read the catalog at all; what it must not
      // have is CREATEROLE or membership in the roles it is asked about.
      await store.pool.query(`GRANT USAGE ON SCHEMA public TO ${limited}`);
    } catch (error) {
      t.skip(`cannot create an unprivileged probe role here: ${error.message}`);
      return;
    }
    unprivileged = new PostgresGovernanceStore({ connectionString: roleUrl(limited, password), maxConnections: 2 });

    // It cannot create roles, so it must say so rather than pretending.
    const ensured = await unprivileged.ensureRoles({
      roles: ["gavel_absent_role"],
      env: { GAVEL_INDEXER_DB_PASSWORD: INDEXER_PASSWORD, GAVEL_API_DB_PASSWORD: API_PASSWORD },
    });
    assert.equal(ensured.state, "skipped");
    assert.match(ensured.reason, /CREATEROLE/);

    // It cannot SET ROLE, so a catalog-only reading is not accepted as proof.
    const degraded = await unprivileged.verifyPermissions("gavel_api");
    assert.equal(degraded.method, "catalog");
    assert.equal(degraded.ok, false, "an unproven read-only claim must not pass the gate");
    assert.match(degraded.violations.join(" "), /effective verification unavailable/);

    // The operator can still get the catalog answer, explicitly and on the record.
    const acknowledged = await unprivileged.verifyPermissions("gavel_api", { allowCatalogFallback: true });
    assert.equal(acknowledged.ok, true);
    assert.equal(acknowledged.method, "catalog");
    assert.match(acknowledged.degraded, /set role/i);
  } finally {
    if (unprivileged) await unprivileged.close();
    await dropProbeRole(store, limited).catch(() => {});
    await store.close();
  }
});
