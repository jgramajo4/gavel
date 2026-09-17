const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createQuoteSigner } = require("../src/gate/quote-signer");
const { PostgresGateStore, createPublicGateReader } = require("../src/gate/store");

function makeIssuance(suffix = "1", overrides = {}) {
  const future = new Date(Date.now() + 60_000);
  const value = {
    snapshot: {
      id: `snapshot-${suffix}`, dao: "0xDAO", proposalId: "7", contentHash: `hash-${suffix}`,
      nativeState: "ACTIVE", eligibility: "ELIGIBLE", mappingVersion: "nouns-lifecycle/1",
      sourceBlock: "100", sourceBlockHash: "0xblock", refreshedAt: new Date(),
      canonicalFacts: { title: "Vote" }, decodedFacts: {},
    },
    submission: {
      id: `submission-${suffix}`, submissionHash: `submission-hash-${suffix}`, profileId: "profile-1",
      payer: "0xPAYER", signedSender: "0xpayer", material: { vote: "for" },
    },
    quote: {
      id: `quote-${suffix}`, quoteId: `public-quote-${suffix}`, payer: "0xPAYER", voter: "0xVOTER",
      attentionAmount: "10", feeAmount: "1", token: "0xTOKEN", baseChainId: "8453",
      splitter: "0xSPLITTER", deploymentId: "deployment-1", expiresAt: future, signature: "private-signature",
    },
    reservation: { id: `reservation-${suffix}`, profileId: "profile-1", amount: "10", expiresAt: future },
  };
  for (const [section, patch] of Object.entries(overrides)) Object.assign(value[section], patch);
  return value;
}

test("Gate migration declares every private persistence table and immutable relationship triggers", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  for (const table of [
    "profiles", "dao_policies", "auth_nonces", "proposal_snapshots", "submissions", "quotes",
    "inbox_items", "notification_attempts", "capacity_reservations", "sender_blocks", "rate_limit_events",
    "delivery_settings", "splitter_deployments", "settlement_cursors", "settlement_reorg_monitors",
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS gate\\.${table}\\b`, "i"));
  assert.match(sql, /numeric\(78,0\)/i);
  assert.match(sql, /clock_timestamp\(\)/i);
  assert.match(sql, /payer\s*=\s*signed_sender/i);
  assert.match(sql, /protect_immutable_issuance/i);
  assert.doesNotMatch(sql, /GRANT[^;]*ON\s+gate\.[^;]*TO\s+(?:gavel_api|gavel_indexer)/i);
});

test("Gate migration fail-closed upgrades legacy public display and Nouns policies", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const displaySanitizer = sql.indexOf("UPDATE gate.profiles\nSET display_cache");
  const displayConstraint = sql.indexOf("ADD CONSTRAINT profiles_public_display_shape");
  assert.ok(displaySanitizer >= 0 && displaySanitizer < displayConstraint,
    "legacy display data must be sanitized before the public-shape constraint is validated");
  assert.match(sql.slice(displaySanitizer, displayConstraint), /jsonb_typeof\(display_cache->'ens'\).*IN \('string','null'\)/s);
  assert.match(sql.slice(displaySanitizer, displayConstraint), /jsonb_typeof\(display_cache->'message'\).*IN \('string','null'\)/s);
  assert.doesNotMatch(sql.slice(displaySanitizer, displayConstraint), /destination|email|webhook/i);

  const nounsDrop = sql.indexOf("DROP CONSTRAINT IF EXISTS dao_policies_nouns_policy_check");
  const nounsDisable = sql.indexOf("UPDATE gate.dao_policies\nSET enabled=false");
  const nounsConstraint = sql.indexOf("ADD CONSTRAINT dao_policies_nouns_policy_check");
  assert.ok(nounsDrop >= 0 && nounsDrop < nounsDisable && nounsDisable < nounsConstraint,
    "the named Nouns policy constraint must be replaced only after legacy zero-stage policies are disabled");
  assert.match(sql.slice(nounsDisable, nounsConstraint), /accept_voting\s*=\s*false/i);
  assert.match(sql.slice(nounsConstraint), /dao <> 'nouns'[\s\S]*enabled = false[\s\S]*accept_voting = true/i);
});

test("public Gate reader exposes only explicit safe profile, policy, and receipt projections", async () => {
  const queries = [];
  const reader = createPublicGateReader({ query: async (sql, values) => {
    queries.push({ sql, values });
    return { rows: [{ publicId: values[0], state: "payment_required", updatedAt: new Date(0), acceptedAt: null }] };
  }});
  assert.deepEqual(Object.keys(reader), ["getProfile", "getPolicy", "getSubmission"]);
  assert.deepEqual(await reader.getSubmission("opaque-id"), { publicId: "opaque-id", state: "payment_required", updatedAt: new Date(0) });
  assert.match(queries[0].sql, /FROM gate_public\.submission_receipts/i);
  assert.doesNotMatch(queries[0].sql, /gate\.inbox|delivery|signature|notification|auth_nonce|reorg|payer|voter|material/i);
  assert.equal("query" in reader, false);
});

test("Postgres store uses a parameterized profile advisory lock and rolls back failed issuance", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      if (/INSERT INTO gate\.proposal_snapshots/.test(sql)) throw new Error("injected insert failure");
      if (/FROM gate\.profiles WHERE id=.*FOR UPDATE/.test(sql)) return { rows: [{ wallet: `0x${"a".repeat(40)}`, wallet_kind: "eoa",
        availability: "accepting_now", profile_version: "1", base_payout_code_hash: null }], rowCount: 1 };
      if (/FROM gate\.dao_policies/.test(sql)) return { rows: [{ enabled: true, chain_id: "1", attention_amount: "1000000",
        accept_pre_vote: false, accept_voting: true, pending_reservation_capacity: 12, settled_capacity: 25 }], rowCount: 1 };
      if (/FROM gate\.splitter_deployments/.test(sql)) return { rows: [{ issuance_active: true, chain_id: "8453",
        splitter: `0x${"a".repeat(40)}`, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        contract_code_hash: `0x${"1".repeat(64)}`, config: { environment: "production" } }], rowCount: 1 };
      if (/interval '600 seconds'/.test(sql)) return { rows: [{ now: new Date(0), expiresAt: new Date(600_000) }], rowCount: 1 };
      if (/AS pending_count/.test(sql)) return { rows: [{ pending_count: "0", settled_count: "0", pair_proposal: 0, active_pair: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const store = new PostgresGateStore({
    pool: { connect: async () => client },
    baseCodeReader: async () => "0x6000",
  });
  await assert.rejects(store.issue({
    signer: createQuoteSigner({ signer: `0x${"7".repeat(64)}`, chainId: 8453, splitter: `0x${"a".repeat(40)}` }),
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: `0x${"b".repeat(40)}`,
      expectedProfileVersion: "1", walletKind: "eoa", basePayoutCodeHash: null,
      stage: "VOTING", deploymentCodeHash: `0x${"1".repeat(64)}` },
    snapshot: { id: "snapshot-pg", dao: "nouns", proposalId: "1", contentHash: `0x${"2".repeat(64)}`, nativeState: "ACTIVE",
      eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: `0x${"3".repeat(64)}`, refreshedAt: new Date(),
      canonicalFacts: {}, decodedFacts: {}, canonicalActions: [] },
    submission: { id: "submission-pg", submissionHash: `0x${"4".repeat(64)}`, profileId: "profile-1",
      payer: `0x${"b".repeat(40)}`, signedSender: `0x${"b".repeat(40)}`, material: {} },
    quote: { id: "quote-pg", quoteId: `0x${"5".repeat(64)}`, payer: `0x${"b".repeat(40)}`, voter: `0x${"a".repeat(40)}`,
      attentionAmount: "1000000", feeAmount: "250000", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", baseChainId: "8453",
      splitter: `0x${"a".repeat(40)}`, deploymentId: "deployment-1", quoteVersion: 1 },
    reservation: { id: "reservation-pg", profileId: "profile-1", amount: "1000000" },
  }), /injected insert failure/);
  assert.equal(calls[0].sql, "BEGIN");
  const lock = calls.find((call) => /pg_advisory_xact_lock/.test(call.sql));
  assert.deepEqual(lock.values, ["gate:profile:profile-1"]);
  assert.equal(calls.at(-2).sql, "ROLLBACK");
  assert.equal(calls.at(-1).sql, "RELEASE");
  assert.equal(calls.every((call) => !call.values || !call.sql.includes("profile-1")), true);
});

test("compose and canonical init wire a separate Gate credential without embedding it", () => {
  const compose = fs.readFileSync(path.join(__dirname, "../../../docker-compose.yml"), "utf8");
  const compatibilityInit = fs.readFileSync(path.join(__dirname, "../../governance-index/docker/init-db.sh"), "utf8");
  const serverInit = fs.readFileSync(path.join(__dirname, "../docker/init-db.sh"), "utf8");
  for (const text of [compose, serverInit]) assert.match(text, /GAVEL_GATE_DB_PASSWORD/);
  assert.match(compose, /packages\/server\/docker\/init-db\.sh/);
  assert.match(compatibilityInit, /CREATE ROLE gavel_indexer LOGIN/);
  assert.match(compatibilityInit, /CREATE ROLE gavel_api LOGIN/);
  assert.match(serverInit, /CREATE ROLE gavel_gate LOGIN PASSWORD %L/);
  assert.match(serverInit, /GRANT CONNECT ON DATABASE gavel TO gavel_gate/);
  assert.doesNotMatch(serverInit, /PASSWORD\s+['"][^:$]/);
  assert.match(compose, /command:\s*\["migrate"\]/);
  assert.doesNotMatch(compose, /^\s{2}gate:/m);
});
