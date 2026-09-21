const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");
const { createQuoteSigner } = require("../src/gate/quote-signer");
const { PostgresGateStore } = require("../src/gate/store");

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
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CODE_HASH = hash("6");
const GAVEL_RECIPIENT = addr("7");
const SIGNER_KEY = `0x${"7".repeat(64)}`;

function canonicalBlocks(from, through, { defaultHash = hash("d"), timestamp = new Date() } = {}) {
  return Array.from({ length: through - from + 1 }, (_, offset) => ({
    blockNumber: String(from + offset),
    blockHash: defaultHash,
    parentHash: offset === 0 ? defaultHash : defaultHash,
    blockTimestamp: timestamp,
  }));
}

function issuance(suffix, submissionHash = hash(suffix)) {
  return {
    signer: createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }),
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: PAYER,
      expectedProfileVersion: "1", walletKind: "eoa", basePayoutCodeHash: null, stage: "VOTING", deploymentCodeHash: CODE_HASH },
    snapshot: { id: `snapshot-${suffix}`, dao: "nouns", proposalId: String(Number.parseInt(suffix, 16) || 1),
      contentHash: hash(suffix), nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1",
      sourceBlock: "100", sourceBlockHash: hash("a"), refreshedAt: new Date(), canonicalFacts: {}, decodedFacts: {}, canonicalActions: [] },
    submission: { id: `submission-${suffix}`, submissionHash, profileId: "profile-1", payer: PAYER, signedSender: PAYER, material: { vote: "for" } },
    quote: { id: `quote-${suffix}`, quoteId: hash(suffix), payer: PAYER, voter: WALLET, attentionAmount: "1000000",
      feeAmount: "250000", token: TOKEN, baseChainId: "8453", splitter: SPLITTER, deploymentId: "deployment-1",
      quoteVersion: 1 },
    reservation: { id: `reservation-${suffix}`, profileId: "profile-1", amount: "1000000" },
  };
}

function effectiveRolePool(pool, role) {
  async function connect() {
    const client = await pool.connect();
    try { await client.query(`SET ROLE ${role}`); }
    catch (error) { client.release(true); throw error; }
    return { query: client.query.bind(client), release: () => client.release(true) };
  }
  return {
    connect,
    async query(sql, values) {
      const client = await connect();
      try { return await client.query(sql, values); } finally { client.release(); }
    },
  };
}

async function forceQuoteExpiry(pool, quoteId) {
  await pool.query("ALTER TABLE gate.quotes DISABLE TRIGGER quotes_immutable_issuance");
  await pool.query("ALTER TABLE gate.quotes DISABLE TRIGGER quotes_validate_bindings");
  await pool.query("ALTER TABLE gate.capacity_reservations DISABLE TRIGGER capacity_reservations_immutable_relationship");
  await pool.query("ALTER TABLE gate.capacity_reservations DISABLE TRIGGER capacity_reservations_validate_bindings");
  try {
    const forcedExpiry = new Date(Date.now() - 1_000);
    await pool.query("UPDATE gate.quotes SET expires_at=$2 WHERE quote_id=$1", [quoteId, forcedExpiry]);
    await pool.query("UPDATE gate.capacity_reservations SET expires_at=$2 FROM gate.quotes q WHERE q.quote_id=$1 AND gate.capacity_reservations.quote_id=q.id",
      [quoteId, forcedExpiry]);
  } finally {
    await pool.query("ALTER TABLE gate.quotes ENABLE TRIGGER quotes_immutable_issuance");
    await pool.query("ALTER TABLE gate.quotes ENABLE TRIGGER quotes_validate_bindings");
    await pool.query("ALTER TABLE gate.capacity_reservations ENABLE TRIGGER capacity_reservations_immutable_relationship");
    await pool.query("ALTER TABLE gate.capacity_reservations ENABLE TRIGGER capacity_reservations_validate_bindings");
  }
}

async function withStore(run) {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  const migration = await fs.readFile(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  try {
    await pool.query("SELECT pg_advisory_lock(hashtext('gavel-gate-destructive-integration'))");
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE");
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='gavel_gate') THEN CREATE ROLE gavel_gate NOLOGIN; END IF;
    END $$`);
    await pool.query(migration);
    const owner = new PostgresGateStore({ pool });
    await owner.mutateProfile({
      profile: { id: "profile-1", wallet: WALLET, walletKind: "eoa", availability: "accepting_now" },
      policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
        attentionAmount: "1000000", pendingReservationCapacity: 12, settledCapacity: 25, tags: [] },
    });
    await owner.configureDeployment({
      id: "deployment-1", chainId: "8453", splitter: SPLITTER, signer: SIGNER, token: TOKEN,
      gavelRecipient: GAVEL_RECIPIENT, deploymentBlock: "0", contractCodeHash: CODE_HASH,
      config: { environment: "production", overlap: 2 }, rpcAccess: "ciphertext", issuanceActive: true,
    });
    const store = new PostgresGateStore({ pool: effectiveRolePool(pool, "gavel_gate") });
    await run({ pool, store });
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE").catch(() => {});
    await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE").catch(() => {});
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query("SELECT pg_advisory_unlock(hashtext('gavel-gate-destructive-integration'))").catch(() => {});
    await pool.end();
  }
}

test("Postgres concurrent scanner workers release an expired reservation once", {
  skip: canRun ? false : skipReason,
}, async () => {
  await withStore(async ({ pool, store }) => {
    const issued = await store.issue(issuance("1", hash("2")));
    await forceQuoteExpiry(pool, issued.quote.quoteId);
    assert.equal(await store.markExpired(), 1);
    const at = new Date();
    const range = {
      deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "0",
      canonicalBlockHash: hash("d"), canonicalBlockTimestamp: at,
      canonicalBlocks: canonicalBlocks(0, 0, { timestamp: at }), observations: [],
    };
    const raced = await Promise.allSettled([store.recordScannerRange(range), store.recordScannerRange(range)]);
    const released = raced.filter((result) => result.status === "fulfilled").map((result) => result.value.released);
    assert.equal(released.reduce((sum, value) => sum + value, 0), 1);
    assert.equal((await store.recordScannerRange(range)).released, 0);
    assert.equal(await store.countLiabilities("profile-1"), 0n);
    const stats = await store.getReservationCapacityStats({ chainId: "8453", splitter: SPLITTER });
    assert.equal(stats.active, 0);
    assert.equal(stats.expiryPending, 0);
    assert.equal(stats.releasedRows, 1);
    assert.equal(stats.consumedRows, 0);
    await assert.rejects(store.releaseReservation(issued.quote.quoteId, { deploymentId: "missing" }), /scanner deployment mismatch/);
  });
});

test("Postgres settlement wins a release race and never frees consumed capacity", {
  skip: canRun ? false : skipReason,
}, async () => {
  await withStore(async ({ pool, store }) => {
    const issued = await store.issue(issuance("3", hash("4")));
    const includedAt = new Date(Date.now() - 60_000);
    const coveredAt = new Date();
    const settlement = {
      txHash: hash("5"), logIndex: 0, receiptBlock: "0", receiptBlockHash: hash("6"),
      receiptBlockTimestamp: includedAt, settledAt: coveredAt,
      event: { quoteId: issued.quote.quoteId, payer: PAYER, voter: WALLET, attentionAmount: "1000000",
        gavelFeeAmount: "250000", gavelRecipient: GAVEL_RECIPIENT, token: TOKEN, submissionHash: hash("4") },
      evidence: { oneConfirmation: true, confirmations: 1, canonical: true, scannerVerified: true,
        chainId: "8453", splitter: SPLITTER },
    };
    await forceQuoteExpiry(pool, issued.quote.quoteId);
    await store.markExpired();
    const observed = await store.recordScannerRange({
      deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "1",
      canonicalBlockHash: hash("7"), canonicalBlockTimestamp: coveredAt,
      canonicalBlocks: [
        { blockNumber: "0", blockHash: hash("6"), parentHash: hash("6"), blockTimestamp: includedAt },
        { blockNumber: "1", blockHash: hash("7"), parentHash: hash("6"), blockTimestamp: coveredAt },
      ],
      observations: [{ kind: "exact_log", quoteId: issued.quote.quoteId, txHash: settlement.txHash, logIndex: 0,
        blockNumber: "0", blockHash: hash("6"), blockTimestamp: includedAt, exactMatch: true,
        details: { settlement } }],
    });
    assert.equal(observed.released, 0);
    const settleCommand = {
      quoteId: issued.quote.quoteId, settlement,
      inbox: { id: "inbox-race", issuanceLifecycle: "VOTING", currentLifecycle: "UNKNOWN", lifecycleChanged: false,
        currentLifecycleUnavailable: true, privateUnavailabilityReason: "private" },
      notification: null, monitor: { id: "monitor-race", nextCheckBlock: "2" },
    };
    const raced = await Promise.allSettled([
      store.recordScannerRange({
        deploymentId: "deployment-1", generation: "2", fromBlock: "0", throughBlock: "1",
        canonicalBlockHash: hash("8"), canonicalBlockTimestamp: coveredAt,
        canonicalBlocks: [
          { blockNumber: "0", blockHash: hash("8"), parentHash: hash("8"), blockTimestamp: includedAt },
          { blockNumber: "1", blockHash: hash("9"), parentHash: hash("8"), blockTimestamp: coveredAt },
        ],
        observations: [],
      }),
      store.settle(settleCommand),
    ]);
    const fulfilled = raced.filter((result) => result.status === "fulfilled").map((result) => result.value);
    assert.equal(fulfilled.length >= 1, true);
    if (!fulfilled.some((value) => value && value.settled === true)) {
      const retry = await store.settle(settleCommand);
      assert.equal(retry === false || retry.settled === true, true);
    }
    assert.equal((await store.getReservationCapacityStats({ chainId: "8453", splitter: SPLITTER })).consumedRows, 1);
    assert.equal(await store.countLiabilities("profile-1"), 0n);
    const cursor = await store.getScannerState({ chainId: "8453", splitter: SPLITTER });
    const rewrite = await store.recordScannerRange({
      deploymentId: "deployment-1", generation: (BigInt(cursor.generation) + 1n).toString(), fromBlock: "0", throughBlock: "1",
      canonicalBlockHash: hash("a"), canonicalBlockTimestamp: coveredAt,
      canonicalBlocks: [
        { blockNumber: "0", blockHash: hash("b"), parentHash: hash("b"), blockTimestamp: includedAt },
        { blockNumber: "1", blockHash: hash("a"), parentHash: hash("b"), blockTimestamp: coveredAt },
      ], observations: [],
    });
    assert.equal(rewrite.released, 0);
    assert.equal((await store.getReservationCapacityStats({ chainId: "8453", splitter: SPLITTER })).consumedRows, 1);
  });
});

test("Postgres scanner rollback leaves expiry-pending capacity unchanged", {
  skip: canRun ? false : skipReason,
}, async () => {
  await withStore(async ({ pool, store }) => {
    const issued = await store.issue(issuance("8", hash("9")));
    await forceQuoteExpiry(pool, issued.quote.quoteId);
    await store.markExpired();
    const at = new Date();
    await assert.rejects(store.recordScannerRange({
      deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "2",
      canonicalBlockHash: hash("d"), canonicalBlockTimestamp: at,
      canonicalBlocks: canonicalBlocks(0, 1, { timestamp: at }), observations: [],
    }), /canonicalBlocks must cover every block/);
    assert.equal((await store.getReservationCapacityStats({ chainId: "8453", splitter: SPLITTER })).expiryPending, 1);
    assert.equal(await store.countLiabilities("profile-1"), 1n);
  });
});
