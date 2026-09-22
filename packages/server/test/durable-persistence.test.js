"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Pool } = require("pg");

const { PostgresGateStore } = require("../src/gate/store");
const { MemoryGateStore } = require("../src/gate/store-memory");

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;
const POLICY = Object.freeze({
  dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
  attentionAmount: "1000000", tags: [],
});

function nonce(overrides = {}) {
  return {
    proofType: "WalletSession", purpose: "wallet_session", role: "dao_profile", wallet: A,
    audience: "https://gate.example", chainId: "1", verifier: B, nonceHash: H("1"), payloadHash: H("2"),
    issuedAt: "100", expiry: "400", consumedAt: null, ...overrides,
  };
}

function session(overrides = {}) {
  return {
    tokenHash: H("3"), wallet: A, role: "dao_profile", chainId: "1", audience: "https://gate.example",
    issuedAt: "110", expiry: "1010", revokedAt: null, ...overrides,
  };
}

async function assertRepositoryContract(store) {
  const challenge = nonce();
  await store.insertNonce(challenge);
  assert.deepEqual(await store.getNonceByHash(challenge.nonceHash), challenge);

  const persistedSession = session({ issuedAt: "120" });
  await store.transaction(async (transaction) => {
    assert.deepEqual(await transaction.getNonceByHash(challenge.nonceHash), challenge);
    assert.deepEqual(await transaction.consumeAuthNonceAndInsertSession({
      expectedNonce: challenge,
      tokenHash: persistedSession.tokenHash,
      consumedAt: persistedSession.issuedAt,
      sessionExpiry: persistedSession.expiry,
    }), persistedSession);
  });
  assert.equal((await store.getNonceByHash(challenge.nonceHash)).consumedAt, "120");
  assert.deepEqual(await store.getSessionByTokenHash(persistedSession.tokenHash), persistedSession);

  const operation = nonce({ proofType: "GateEnrollment", purpose: "enrollment", role: null,
    audience: null, nonceHash: H("4"), payloadHash: H("5") });
  await store.insertNonce(operation);
  await assert.rejects(store.withProfileTransaction(A, async (transaction) => {
    await transaction.mutateProfile({ profile: { id: "profile-a", wallet: A, availability: "accepting_now" }, policy: POLICY });
    await transaction.consumeNonce(operation.nonceHash, "130");
    throw new Error("abort profile update");
  }), /abort profile update/);
  assert.equal(await store.getProfileByWallet(A), null);
  assert.equal((await store.getNonceByHash(operation.nonceHash)).consumedAt, null);

  const committed = await store.withProfileTransaction(A, async (transaction) => {
    assert.equal(await transaction.getProfileByWallet(A), null);
    const profile = await transaction.mutateProfile({
      profile: { id: "profile-a", wallet: A, walletKind: "eoa", availability: "accepting_now" }, policy: POLICY,
    });
    await transaction.consumeNonce(operation.nonceHash, "140");
    return profile;
  });
  assert.equal(committed.wallet, A);
  assert.equal((await store.getNonceByHash(operation.nonceHash)).consumedAt, "140");
  assert.equal((await store.getProfileByWallet(A)).id, "profile-a");
  assert.deepEqual((await store.listProfiles({ dao: "nouns", availability: "accepting_now", limit: 50, offset: 0 })).map(({ id }) => id), ["profile-a"]);
  await assert.rejects(store.listProfiles({ limit: 51 }), /limit/);
  await assert.rejects(store.mutateProfile({ profile: { id: "profile-a", wallet: A,
    display: { ens: { destination: "private" } } } }), /display\.ens/);
  await assert.rejects(store.mutateProfile({ profile: { id: "profile-a", wallet: B } }), /wallet.*immutable/);
}

test("MemoryGateStore provides atomic auth and profile repository parity", async () => {
  await assertRepositoryContract(new MemoryGateStore({ clock: () => new Date("2026-01-01T00:00:00Z") }));
});

test("Memory profile listing applies the same bounded stable page", async () => {
  let now = 0;
  const store = new MemoryGateStore({ clock: () => new Date(now++) });
  for (let index = 0; index < 3; index += 1) {
    const wallet = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    await store.mutateProfile({ profile: { id: `profile-${index}`, wallet, availability: "accepting_now" }, policy: POLICY });
  }
  assert.deepEqual((await store.listProfiles({ limit: 2, offset: 1 })).map(({ id }) => id), ["profile-1", "profile-0"]);
  await assert.rejects(store.listProfiles({ limit: 51 }), /limit/);
});

test("Postgres auth/profile methods use one rollback-capable client and profile lock", async () => {
  const calls = [];
  const rows = new Map();
  const client = {
    async query(sql, values = []) {
      sql = String(sql); calls.push({ sql, values });
      if (/SELECT gate\.insert_auth_nonce/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM gate\.(?:auth_nonces|lock_profile_auth_nonce)/.test(sql)) return { rows: [nonce()], rowCount: 1 };
      if (/FROM gate\.consume_auth_nonce_and_insert_session/.test(sql)) return { rows: [session({ issuedAt: "120" })], rowCount: 1 };
      if (/FROM gate\.auth_sessions/.test(sql)) return { rows: [session()], rowCount: 1 };
      if (/FROM gate\.profiles WHERE wallet/.test(sql)) return { rows: rows.has(A) ? [rows.get(A)] : [], rowCount: rows.has(A) ? 1 : 0 };
      if (/FROM gate\.mutate_profile/.test(sql)) {
        const row = { id: values[0], wallet: values[1], walletKind: values[2] || "eoa", availability: values[3],
          profileVersion: "1", display: {}, enrolledAt: new Date(0), updatedAt: new Date(0), basePayoutVerifiedAt: null,
          basePayoutCodeHash: null };
        rows.set(values[1], row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  const store = new PostgresGateStore({ pool: { connect: async () => client, query: client.query.bind(client) } });
  await store.insertNonce(nonce());
  await store.transaction(async (transaction) => {
    await transaction.getNonceByHash(H("1"));
    await transaction.consumeAuthNonceAndInsertSession({
      expectedNonce: nonce(), tokenHash: H("3"), consumedAt: "120", sessionExpiry: "1010",
    });
  });
  await store.getSessionByTokenHash(H("3"));
  await store.withProfileTransaction(A, async (transaction) => {
    await transaction.getNonceByHash(H("1"));
    return transaction.mutateProfile({
      profile: { id: "profile-a", wallet: A, walletKind: "eoa", availability: "paused" }, policy: POLICY,
    });
  });
  await store.withProfileTransaction(A, async (transaction) => transaction.getProfileByWallet(A));

  assert.ok(calls.some(({ sql }) => /SELECT gate\.insert_auth_nonce/.test(sql)));
  const nonceReads = calls.filter(({ sql }) => /FROM gate\.(?:auth_nonces|lock_profile_auth_nonce)/.test(sql));
  assert.equal(nonceReads.length, 2);
  assert.doesNotMatch(nonceReads[0].sql, /FOR UPDATE/);
  assert.match(nonceReads[1].sql, /FROM gate\.lock_profile_auth_nonce/);
  assert.doesNotMatch(nonceReads[1].sql, /FOR UPDATE/);
  assert.equal(calls.some(({ sql }) => /FROM gate\.profiles WHERE wallet=.*FOR UPDATE/.test(sql)), false);
  assert.equal(calls.filter(({ sql }) => /FROM gate\.consume_auth_nonce_and_insert_session/.test(sql)).length, 1);
  assert.equal(calls.some(({ sql }) => /SELECT gate\.consume_auth_nonce\(/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /SELECT gate\.insert_auth_session\(/.test(sql)), false);
  assert.ok(calls.some(({ sql }) => /FROM gate\.auth_sessions/.test(sql)));
  const profileBegin = calls.findIndex(({ sql }) => sql === "BEGIN", calls.findIndex(({ sql }) => /consume_auth_nonce_and_insert_session/.test(sql)));
  const profileLock = calls.findIndex(({ sql }) => /pg_advisory_xact_lock/.test(sql));
  const profileMutation = calls.findIndex(({ sql }) => /gate\.mutate_profile/.test(sql));
  assert.ok(profileBegin >= 0 && profileBegin < profileLock && profileLock < profileMutation);
  assert.deepEqual(calls[profileLock].values, [`gate:profile:${A}`]);
  assert.deepEqual(calls.filter(({ sql }) => /pg_advisory_xact_lock/.test(sql)).at(-1).values, ["gate:profile:profile-a"]);
  assert.equal(calls.filter(({ sql }) => sql === "COMMIT").length, 3);
});

test("migration persists only hashed sessions and exposes auth writes through narrow functions", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate\.auth_sessions[\s\S]*token_hash text NOT NULL/i);
  assert.doesNotMatch(sql.match(/CREATE TABLE IF NOT EXISTS gate\.auth_sessions[\s\S]*?\);/i)?.[0] || "", /\btoken\s+text/i);
  for (const fn of ["insert_auth_nonce", "consume_auth_nonce", "consume_auth_nonce_and_insert_session", "lock_profile_auth_nonce"]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION gate\\.${fn}\\b`, "i"));
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION gate\\.${fn}[\\s\\S]*? FROM PUBLIC`, "i"));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION gate\\.${fn}[\\s\\S]*? TO gavel_gate`, "i"));
  }
  assert.match(sql, /REVOKE ALL ON FUNCTION gate\.insert_auth_session[\s\S]*? FROM gavel_gate/i);
  assert.match(sql, /GRANT SELECT ON gate\.auth_nonces,gate\.auth_sessions/i);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:INSERT|UPDATE)[^;]*gate\.(?:auth_nonces|auth_sessions)/i);
  assert.doesNotMatch(sql, /gate_public\.(?:auth_nonces|auth_sessions)/i);
  assert.match(sql, /postgres-parity'[\s\S]*installed_tables NOT IN \(19,21\)/i);
  assert.match(sql, /durable-auth-profile'[\s\S]*installed_tables NOT IN \(20,21\)/i);
  assert.match(sql, /COALESCE\(\(SELECT migration_checksum[\s\S]*?\),''\)\s+NOT IN/i,
    "a null or unknown marked checksum must fail closed");
});

const databaseUrl = process.env.GAVEL_GATE_TEST_DATABASE_URL;
const disposable = process.env.GAVEL_GATE_TEST_DATABASE_DISPOSABLE === "yes";
let safeName = false;
try { safeName = /(?:_test|_disposable)$/.test(new URL(databaseUrl).pathname.slice(1)); } catch {}
const canRunPostgres = Boolean(databaseUrl && disposable && safeName);
const postgresSkip = !databaseUrl
  ? "GAVEL_GATE_TEST_DATABASE_URL is not set; durable PostgreSQL integration was not run"
  : "durable PostgreSQL integration requires a disposable _test or _disposable database";

test("auth sessions and profile proof consumption survive repository restart", {
  skip: canRunPostgres ? false : postgresSkip,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const unique = Date.now().toString(16).padStart(64, "0").slice(-64);
  const challenge = nonce({ nonceHash: `0x${unique}`, payloadHash: H("8") });
  const persistedSession = session({ tokenHash: `0x${unique.replace(/.$/, "f")}` });
  try {
    await pool.query(migration);
    const first = new PostgresGateStore({ pool });
    await first.insertNonce(challenge);
    await first.transaction(async (transaction) => {
      await transaction.consumeNonce(challenge.nonceHash, "120");
      await transaction.insertSession(persistedSession);
    });
    const restarted = new PostgresGateStore({ pool });
    assert.equal((await restarted.getNonceByHash(challenge.nonceHash)).consumedAt, "120");
    assert.deepEqual(await restarted.getSessionByTokenHash(persistedSession.tokenHash), persistedSession);
  } finally {
    await pool.query("DELETE FROM gate.auth_sessions WHERE token_hash=$1", [persistedSession.tokenHash]).catch(() => {});
    await pool.query("DELETE FROM gate.auth_nonces WHERE nonce_hash=$1", [challenge.nonceHash]).catch(() => {});
    await pool.end();
  }
});
