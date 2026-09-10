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
