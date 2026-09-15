const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");
const { PostgresGateStore, createPublicGateReader } = require("../src/gate/store");

const databaseUrl = process.env.GAVEL_GATE_TEST_DATABASE_URL;
const disposableConfirmed = process.env.GAVEL_GATE_TEST_DATABASE_DISPOSABLE === "yes";
let safeDatabaseName = false;
try { safeDatabaseName = /(?:_test|_disposable)$/.test(new URL(databaseUrl).pathname.slice(1)); } catch {}
const canRun = Boolean(databaseUrl && disposableConfirmed && safeDatabaseName);
const skipReason = !databaseUrl
  ? "GAVEL_GATE_TEST_DATABASE_URL is not set; disposable PostgreSQL integration was not run"
  : "destructive integration requires GAVEL_GATE_TEST_DATABASE_DISPOSABLE=yes and a database name ending _test or _disposable";

const addr = (digit) => `0x${digit.repeat(40)}`;
const hash = (digit) => `0x${digit.repeat(64)}`;
const WALLET = addr("1");
const PAYER = addr("2");
const SPLITTER = addr("3");
const SIGNER = addr("4");
const TOKEN = addr("5");
const CODE_HASH = hash("6");
const GAVEL_RECIPIENT = addr("7");

function canonicalBlocks(from, through, { changedBlock, changedHash, defaultHash = hash("d"), timestamp = new Date() } = {}) {
  return Array.from({ length: through - from + 1 }, (_, offset) => {
    const blockNumber = from + offset;
    return { blockNumber: String(blockNumber), blockHash: blockNumber === changedBlock ? changedHash : defaultHash, blockTimestamp: timestamp };
  });
}

function issuance(suffix, submissionHash = hash(suffix)) {
  const future = new Date(Date.now() + 60_000);
  return {
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: PAYER,
      expectedProfileVersion: "1", walletKind: "eoa", basePayoutCodeHash: null, stage: "VOTING", deploymentCodeHash: CODE_HASH },
    snapshot: { id: `snapshot-${suffix}`, dao: "nouns", proposalId: String(Number.parseInt(suffix, 16) || 1),
      contentHash: hash(suffix), nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1",
      sourceBlock: "100", sourceBlockHash: hash("a"), refreshedAt: new Date(), canonicalFacts: {}, decodedFacts: {}, canonicalActions: [] },
    submission: { id: `submission-${suffix}`, submissionHash, profileId: "profile-1", payer: PAYER, signedSender: PAYER, material: { vote: "for" } },
    quote: { id: `quote-${suffix}`, quoteId: hash(suffix), payer: PAYER, voter: WALLET, attentionAmount: "1000000",
      feeAmount: "250000", token: TOKEN, baseChainId: "8453", splitter: SPLITTER, deploymentId: "deployment-1",
      quoteVersion: 1, expiresAt: future },
    reservation: { id: `reservation-${suffix}`, profileId: "profile-1", amount: "1000000", expiresAt: future },
  };
}

async function denied(pool, role, sql) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query(`SET LOCAL ROLE ${role}`);
    try { await client.query(sql); return false; } catch (error) { return error.code === "42501" || error.code === "23514"; }
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
}

test("Gate migration upgrades legacy display and zero-stage Nouns rows fail-closed and idempotently", {
  skip: canRun ? false : skipReason,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const migration = await fs.readFile(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  try {
    await pool.query("SELECT pg_advisory_lock(hashtext('gavel-gate-destructive-integration'))");
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE");
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query(migration);

    await pool.query("ALTER TABLE gate.profiles DROP CONSTRAINT profiles_public_display_shape");
    await pool.query("ALTER TABLE gate.dao_policies DROP CONSTRAINT dao_policies_nouns_policy_check");
    await pool.query(`ALTER TABLE gate.dao_policies ADD CONSTRAINT dao_policies_nouns_policy_check
      CHECK (dao <> 'nouns' OR (chain_id=1 AND accept_pre_vote=false))`);
    await pool.query(`INSERT INTO gate.profiles(id,wallet,wallet_kind,display_cache)
      VALUES('legacy-profile',$1,'eoa',$2::jsonb)`, [WALLET, JSON.stringify({
      ens: "legacy.eth", message: null, destination: "private", nested: { email: "secret@example.test" },
    })]);
    await pool.query(`INSERT INTO gate.dao_policies
      (profile_id,dao,chain_id,enabled,accept_pre_vote,accept_voting,attention_amount)
      VALUES('legacy-profile','nouns',1,true,false,false,1000000)`);
    await pool.query(`UPDATE public.schema_migrations
      SET migration_checksum='sha256:gate-001-v3-durable-auth-profile-hardening',
          catalog_manifest=public.gavel_gate_catalog_manifest()
      WHERE version='gate/001_gate-v3'`);

    await pool.query(migration);
    assert.deepEqual((await pool.query("SELECT display_cache FROM gate.profiles WHERE id='legacy-profile'")).rows[0].display_cache,
      { ens: "legacy.eth", message: null });
    assert.deepEqual((await pool.query("SELECT ens,message FROM gate_public.profiles WHERE id='legacy-profile'")).rows[0],
      { ens: "legacy.eth", message: null });
    assert.deepEqual((await pool.query(`SELECT enabled,accept_voting FROM gate.dao_policies
      WHERE profile_id='legacy-profile' AND dao='nouns'`)).rows[0], { enabled: false, accept_voting: false });
    const nounsConstraints = await pool.query(`SELECT c.conname,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='gate' AND t.relname='dao_policies' AND c.contype='c'
        AND pg_get_constraintdef(c.oid) LIKE '%nouns%'`);
    assert.equal(nounsConstraints.rows.length, 1);
    assert.equal(nounsConstraints.rows[0].conname, "dao_policies_nouns_policy_check");
    await assert.rejects(pool.query(`UPDATE gate.dao_policies SET enabled=true
      WHERE profile_id='legacy-profile' AND dao='nouns'`), (error) => error.code === "23514");

    const manifestBeforeRerun = (await pool.query(`SELECT catalog_manifest FROM public.schema_migrations
      WHERE version='gate/001_gate-v3'`)).rows[0].catalog_manifest;
    await pool.query(migration);
    assert.deepEqual((await pool.query(`SELECT migration_checksum,catalog_manifest FROM public.schema_migrations
      WHERE version='gate/001_gate-v3'`)).rows[0], {
      migration_checksum: "sha256:gate-001-v3-legacy-upgrade-hardening",
      catalog_manifest: manifestBeforeRerun,
    });
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE").catch(() => {});
    await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE").catch(() => {});
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query("SELECT pg_advisory_unlock(hashtext('gavel-gate-destructive-integration'))").catch(() => {});
    await pool.end();
  }
});

test("Gate SQL and Postgres store enforce invariants, races, settlement, cursor release, and privacy", {
  skip: canRun ? false : skipReason,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const store = new PostgresGateStore({
    pool,
    baseCodeReader: async () => "0x6000",
    quoteSigner: async () => "0xsigned",
  });
  const migration = await fs.readFile(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  try {
    await pool.query("SELECT pg_advisory_lock(hashtext('gavel-gate-destructive-integration'))");
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE");
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query("DROP TABLE IF EXISTS public.gate_role_probe");
    await pool.query("CREATE TABLE public.gate_role_probe(id integer)");
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='gavel_gate') THEN CREATE ROLE gavel_gate NOLOGIN; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='gavel_api') THEN CREATE ROLE gavel_api NOLOGIN; END IF;
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='gavel_indexer') THEN CREATE ROLE gavel_indexer NOLOGIN; END IF;
    END $$`);
    await pool.query(migration);
    await pool.query(`INSERT INTO gate.proposal_snapshots
      (id,dao,proposal_id,content_hash,native_state,normalized_eligibility,mapping_version,source_block,source_block_hash,
       refreshed_at,canonical_facts,decoded_facts,canonical_actions)
      VALUES('legacy-mapping','nouns',999,$1,'ACTIVE','VOTING','nouns-lifecycle/1',1,$2,clock_timestamp(),'{}','{}','[]')`,
    [hash("8"), hash("9")]);
    await pool.query("ALTER TABLE gate.proposal_snapshots DROP CONSTRAINT proposal_snapshots_mapping_version_check");
    await pool.query(`ALTER TABLE gate.proposal_snapshots ALTER COLUMN mapping_version TYPE integer
      USING CASE WHEN mapping_version='nouns-lifecycle/1' THEN 1 ELSE NULL END`);
    await pool.query("ALTER TABLE gate.proposal_snapshots ADD CONSTRAINT proposal_snapshots_mapping_version_check CHECK(mapping_version=1)");
    await pool.query(`UPDATE public.schema_migrations SET migration_checksum='sha256:gate-001-v3-durable-auth-profile',
      catalog_manifest=public.gavel_gate_catalog_manifest() WHERE version='gate/001_gate-v3'`);
    await pool.query(migration);
    assert.deepEqual((await pool.query(`SELECT data_type FROM information_schema.columns
      WHERE table_schema='gate' AND table_name='proposal_snapshots' AND column_name='mapping_version'`)).rows[0], { data_type: "text" });
    assert.match((await pool.query(`SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='gate' AND t.relname='proposal_snapshots' AND c.conname='proposal_snapshots_mapping_version_check'`)).rows[0].definition,
    /mapping_version = 'nouns-lifecycle\/1'/);
    assert.equal((await pool.query("SELECT mapping_version FROM gate.proposal_snapshots WHERE id='legacy-mapping'")).rows[0].mapping_version,
      "nouns-lifecycle/1");
    await pool.query("ALTER TABLE gate.proposal_snapshots DISABLE TRIGGER proposal_snapshots_immutable");
    try { await pool.query("DELETE FROM gate.proposal_snapshots WHERE id='legacy-mapping'"); }
    finally { await pool.query("ALTER TABLE gate.proposal_snapshots ENABLE TRIGGER proposal_snapshots_immutable"); }
    await pool.query(migration);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.schema_migrations WHERE version='gate/001_gate-v3'")).rows[0].n, 1);

    const created = await store.mutateProfile({ profile: { id: "profile-1", wallet: WALLET, walletKind: "eoa", availability: "accepting_now" },
      policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
        pendingReservationCapacity: 12, settledCapacity: 25, tags: [] } });
    assert.equal(String(created.profileVersion), "1");
    const policyOnly = await store.mutateProfile({ profile: { id: "profile-1", wallet: WALLET, walletKind: "eoa" },
      policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
        pendingReservationCapacity: 12, settledCapacity: 25, tags: ["governance"] } });
    assert.equal(String(policyOnly.profileVersion), "2");
    await pool.query("UPDATE gate.profiles SET profile_version=99 WHERE id='profile-1'").then(
      () => assert.fail("profile version was directly writable"), (error) => assert.equal(error.code, "23514"));
    await store.mutateProfile({ profile: { id: "profile-1", wallet: WALLET, walletKind: "eoa", availability: "paused" },
      policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
        pendingReservationCapacity: 12, settledCapacity: 25, tags: [] } });
    assert.equal(String((await store.getProfile("profile-1")).profileVersion), "3");
    await store.mutateProfile({ profile: { id: "profile-1", wallet: WALLET, walletKind: "eoa", availability: "accepting_now" } });

    await store.configureDeployment({ id: "deployment-1", chainId: "8453", splitter: SPLITTER, signer: SIGNER, token: TOKEN,
      gavelRecipient: GAVEL_RECIPIENT, deploymentBlock: "5", nextBlock: "99", contractCodeHash: CODE_HASH,
      config: { overlap: 2 }, rpcAccess: "ciphertext", issuanceActive: true });
    assert.deepEqual((await pool.query("SELECT scanner_cursor::text,next_range_from::text FROM gate.splitter_deployments d JOIN gate.settlement_cursors c ON c.deployment_id=d.id WHERE d.id='deployment-1'")).rows[0],
      { scanner_cursor: "5", next_range_from: "5" });
    const commandA = issuance("1", hash("b")); commandA.context.expectedProfileVersion = "4";
    const commandB = issuance("2", hash("b")); commandB.context.expectedProfileVersion = "4";
    const raced = await Promise.all([store.issue(commandA), store.issue(commandB)]);
    assert.equal(raced.filter((value) => value.resumed).length, 1);
    assert.equal(new Set(raced.map((value) => value.publicId)).size, 1);
    assert.deepEqual(await store.counts(), { snapshots: 1, submissions: 1, quotes: 1, reservations: 1, inboxItems: 0, notifications: 0, monitors: 0 });

    const first = raced.find((value) => !value.resumed);
    const settledQuoteId = first.quote.quoteId;
    const settlement = { txHash: hash("c"), logIndex: 0, receiptBlock: "7", receiptBlockHash: hash("d"),
      receiptBlockTimestamp: new Date(Date.now() - 1000), settledAt: new Date(),
      event: { quoteId: settledQuoteId, payer: PAYER, voter: WALLET, attentionAmount: "1000000", gavelFeeAmount: "250000",
        gavelRecipient: GAVEL_RECIPIENT, token: TOKEN, submissionHash: hash("b") },
      evidence: { oneConfirmation: true, canonical: true, scannerVerified: true, chainId: "8453", splitter: SPLITTER } };
    const settleCommand = { quoteId: settledQuoteId, settlement,
      inbox: { id: "inbox-1", issuanceLifecycle: "VOTING", currentLifecycle: "UNKNOWN", lifecycleChanged: false,
        currentLifecycleUnavailable: true, privateUnavailabilityReason: "private" },
      notification: { id: "notification-1", channel: "email", destinationRef: "ciphertext", status: "pending" },
      monitor: { id: "monitor-1", nextCheckBlock: "8" } };
    const settledScanRange = { deploymentId: "deployment-1", generation: "1", fromBlock: "5", throughBlock: "7",
      canonicalBlockHash: hash("d"), canonicalBlockTimestamp: settlement.receiptBlockTimestamp,
      canonicalBlocks: canonicalBlocks(5, 7, { timestamp: settlement.receiptBlockTimestamp }),
      observations: [{ kind: "exact_log", quoteId: settledQuoteId, txHash: hash("c"), logIndex: 0, blockNumber: "7",
        blockHash: hash("d"), blockTimestamp: settlement.receiptBlockTimestamp, exactMatch: true }] };
    await store.recordScannerRange(settledScanRange);
    assert.deepEqual(await store.recordScannerRange(settledScanRange), { released: 0 });
    await assert.rejects(store.recordScannerRange({ ...settledScanRange, canonicalBlockHash: hash("e"),
      canonicalBlocks: canonicalBlocks(5, 7, { changedBlock: 7, changedHash: hash("e"), timestamp: settlement.receiptBlockTimestamp }) }),
    /conflicting scanner generation replay/);
    assert.equal((await store.settle(settleCommand)).settled, true);
    assert.equal(await store.settle(settleCommand), false);
    await assert.rejects(store.settle({ ...settleCommand, settlement: { ...settlement, txHash: hash("e") } }), /conflicting/);
    await pool.query("UPDATE gate.quotes SET settled_tx_hash=$2 WHERE quote_id=$1", [settledQuoteId, hash("e")]).then(
      () => assert.fail("settlement evidence changed"), (error) => assert.equal(error.code, "23514"));
    const receipt = await createPublicGateReader(pool).getSubmission(first.publicId);
    assert.deepEqual(Object.keys(receipt).sort(), ["acceptedAt", "publicId", "state"].sort());
    assert.equal(receipt.state, "accepted");

    const rewrittenAt = new Date();
    await store.recordScannerRange({ deploymentId: "deployment-1", generation: "2", fromBlock: "6", throughBlock: "8",
      canonicalBlockHash: hash("d"), canonicalBlockTimestamp: rewrittenAt,
      canonicalBlocks: canonicalBlocks(6, 8, { changedBlock: 7, changedHash: hash("e"), timestamp: rewrittenAt }), observations: [] });
    const reorged = (await pool.query("SELECT settlement_reorged_at FROM gate.quotes WHERE quote_id=$1", [settledQuoteId])).rows[0];
    assert.ok(reorged.settlement_reorged_at, "accepted overlap rewrite must be privately marked");
    assert.ok((await pool.query("SELECT reconciliation_metadata->'trailingOverlapReorg' AS anomaly FROM gate.settlement_reorg_monitors WHERE quote_id='quote-1'")).rows[0].anomaly,
      "accepted overlap rewrite must leave durable operator anomaly evidence");
    assert.equal((await createPublicGateReader(pool).getSubmission(first.publicId)).state, "accepted");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM gate.settlement_scan_observations WHERE quote_id=$1", [settledQuoteId])).rows[0].n, 1,
      "orphaned generations remain immutable audit history");

    const expiring = issuance("f"); expiring.context.expectedProfileVersion = "4";
    const issuedExpiring = await store.issue(expiring);
    assert.equal(issuedExpiring.quote.expiresAt.valueOf() - Date.now() > 598_000, true);
    await store.markSettlementPending(issuedExpiring.publicId);
    const pendingObservedAt = new Date();
    const pendingSettlement = { ...settlement, txHash: hash("a"), receiptBlock: "9", receiptBlockHash: hash("d"),
      receiptBlockTimestamp: pendingObservedAt, settledAt: pendingObservedAt,
      event: { ...settlement.event, quoteId: hash("f"), submissionHash: hash("f") } };
    await store.recordScannerRange({ deploymentId: "deployment-1", generation: "3", fromBlock: "7", throughBlock: "9",
      canonicalBlockHash: hash("d"), canonicalBlockTimestamp: pendingObservedAt,
      canonicalBlocks: canonicalBlocks(7, 9, { timestamp: pendingObservedAt }),
      observations: [{ kind: "exact_log", quoteId: hash("f"), txHash: hash("a"), logIndex: 0, blockNumber: "9",
        blockHash: hash("d"), blockTimestamp: pendingObservedAt, exactMatch: true }] });
    const pendingRewriteAt = new Date();
    await store.recordScannerRange({ deploymentId: "deployment-1", generation: "4", fromBlock: "8", throughBlock: "10",
      canonicalBlockHash: hash("d"), canonicalBlockTimestamp: pendingRewriteAt,
      canonicalBlocks: canonicalBlocks(8, 10, { changedBlock: 9, changedHash: hash("e"), timestamp: pendingRewriteAt }), observations: [] });
    assert.equal((await createPublicGateReader(pool).getSubmission(issuedExpiring.publicId)).state, "payment_required");
    await assert.rejects(store.settle({ quoteId: hash("f"), settlement: pendingSettlement,
      inbox: { id: "inbox-stale", issuanceLifecycle: "VOTING", currentLifecycle: "UNKNOWN", lifecycleChanged: false,
        currentLifecycleUnavailable: true, privateUnavailabilityReason: "private" },
      notification: { id: "notification-stale", channel: "email", destinationRef: "ciphertext", status: "pending" },
      monitor: { id: "monitor-stale", nextCheckBlock: "10" } }), /settlement evidence was not persisted by scanner/);
    // The production TTL is exactly ten minutes and cannot be caller-shortened. Move this
    // disposable fixture past expiry without weakening the production immutability triggers.
    await pool.query("ALTER TABLE gate.quotes DISABLE TRIGGER quotes_immutable_issuance");
    await pool.query("ALTER TABLE gate.capacity_reservations DISABLE TRIGGER capacity_reservations_immutable_relationship");
    try {
      await pool.query(`UPDATE gate.quotes SET expires_at=clock_timestamp()-interval '1 second' WHERE quote_id=$1`, [hash("f")]);
      await pool.query(`UPDATE gate.capacity_reservations SET expires_at=clock_timestamp()-interval '1 second' WHERE quote_id=$1`, ["quote-f"]);
    } finally {
      await pool.query("ALTER TABLE gate.quotes ENABLE TRIGGER quotes_immutable_issuance");
      await pool.query("ALTER TABLE gate.capacity_reservations ENABLE TRIGGER capacity_reservations_immutable_relationship");
    }
    await store.markExpired();
    await assert.rejects(pool.query("SELECT gate.record_scanner_range($1,$2,$3,$4,$5,$6::jsonb)",
      ["deployment-1", "8", "9", hash("f"), new Date(), JSON.stringify({ kind: "observations", observations: [{ kind: "exact_log" }], metadata: {} })]));
    assert.equal((await pool.query("SELECT next_range_from::text AS next FROM gate.settlement_cursors WHERE deployment_id='deployment-1'")).rows[0].next, "11");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM gate.settlement_scan_ranges WHERE deployment_id='deployment-1'")).rows[0].n, 4);
    const releaseScanAt = new Date();
    await assert.rejects(store.recordScannerRange({ deploymentId: "deployment-1", generation: "5", fromBlock: "10", throughBlock: "12",
      canonicalBlockHash: hash("f"), canonicalBlockTimestamp: releaseScanAt,
      canonicalBlocks: canonicalBlocks(10, 12, { defaultHash: hash("f"), timestamp: releaseScanAt }), observations: [] }), /discontinuous/);
    const scan = await store.recordScannerRange({ deploymentId: "deployment-1", generation: "5", fromBlock: "9", throughBlock: "12",
      canonicalBlockHash: hash("f"), canonicalBlockTimestamp: releaseScanAt,
      canonicalBlocks: canonicalBlocks(9, 12, { defaultHash: hash("f"), timestamp: releaseScanAt }), observations: [] });
    assert.equal(scan.released, 1);
    const releaseEvidence = { deploymentId: "deployment-1" };
    assert.equal(await store.releaseReservation(hash("f"), releaseEvidence), false);
    assert.equal(await store.countLiabilities("profile-1"), 0n);

    assert.equal(await denied(pool, "gavel_gate", "DELETE FROM gate.quotes WHERE false"), true);
    assert.equal(await denied(pool, "gavel_gate", "INSERT INTO public.gate_role_probe VALUES(1)"), true);
    assert.equal(await denied(pool, "gavel_api", "SELECT 1 FROM gate.profiles"), true);
    assert.equal(await denied(pool, "gavel_indexer", "SELECT 1 FROM gate.profiles"), true);
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE").catch(() => {});
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query("DROP TABLE IF EXISTS public.gate_role_probe").catch(() => {});
    await pool.query("SELECT pg_advisory_unlock(hashtext('gavel-gate-destructive-integration'))").catch(() => {});
    await pool.end();
  }
});

test("marked Gate migration rejects unique and foreign-key catalog drift instead of repairing it", {
  skip: canRun ? false : skipReason,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const migration = await fs.readFile(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  try {
    await pool.query("SELECT pg_advisory_lock(hashtext('gavel-gate-destructive-integration'))");
    for (const { table, type, definition } of [
      { table: "settlement_scan_observations", type: "u", definition: "%UNIQUE (deployment_id, scan_generation, tx_hash, log_index)%" },
      { table: "settlement_scan_blocks", type: "f", definition: "%FOREIGN KEY (range_id, deployment_id, scan_generation)%" },
    ]) {
      await pool.query("DROP SCHEMA IF EXISTS gate CASCADE");
      await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE");
      await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
      await pool.query(migration);
      const constraint = (await pool.query(`SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='gate' AND t.relname=$1
        AND c.contype=$2 AND pg_get_constraintdef(c.oid) LIKE $3`, [table, type, definition])).rows[0];
      assert.ok(constraint, `critical ${type} constraint must exist before drift`);
      await pool.query(`ALTER TABLE gate.${table} DROP CONSTRAINT ${constraint.conname}`);
      await assert.rejects(pool.query(migration), /marker does not match installed Gate schema/);
    }
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE").catch(() => {});
    await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE").catch(() => {});
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query("SELECT pg_advisory_unlock(hashtext('gavel-gate-destructive-integration'))").catch(() => {});
    await pool.end();
  }
});
