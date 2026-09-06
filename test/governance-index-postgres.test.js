// Integration tests against a real PostgreSQL server. These cover what a
// query() stub cannot: that the migration actually executes, that the canonical
// uniqueness constraints hold, that ingestion is idempotent, and that the API
// role genuinely cannot write.
//
// Set GAVEL_TEST_DATABASE_URL to a database the test may create and drop
// objects in. Without it the suite skips rather than silently passing.
const test = require("node:test");
const assert = require("node:assert/strict");

const { PostgresGovernanceStore } = require("../packages/governance-index/src/postgres-store");

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
    for (const role of ["gavel_indexer", "gavel_api"]) {
      await store.pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD 'test-only'; END IF; END $$;`);
    }
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
    const url = new URL(ADMIN_URL);
    url.username = "gavel_api";
    url.password = "test-only";
    const readonly = new PostgresGovernanceStore({ connectionString: url.toString(), maxConnections: 2 });
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
    // Roles are cluster-scoped, so they may hold grants in databases this test
    // cannot reach. Drop what we own here first, and skip rather than fail if
    // an unrelated database still depends on them.
    for (const role of ["gavel_api", "gavel_indexer"]) {
      try {
        await store.pool.query(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='${role}') THEN EXECUTE 'DROP OWNED BY ${role}'; END IF; END $$;`);
        await store.pool.query(`DROP ROLE IF EXISTS ${role}`);
      } catch { /* checked below */ }
    }
    const remaining = (await store.pool.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('gavel_indexer','gavel_api')",
    )).rows.map((row) => row.rolname);
    if (remaining.length) {
      t.skip(`roles ${remaining.join(",")} are in use by another database in this cluster`);
      return;
    }
    const result = await store.migrate();
    assert.equal(result.roles, "skipped");
    assert.deepEqual(result.missingRoles, ["gavel_indexer", "gavel_api"]);
    assert.match(result.warning, /verify-permissions/);
  } finally { await store.close(); }
});
