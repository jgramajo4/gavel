const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, keccak256, toUtf8Bytes } = require("ethers");

const { MemoryAuthRepository, createAuthService } = require("../src/gate/auth");
const { createGateHttpServer } = require("../src/gate/http");

const BASE_VERIFIER = `0x${"b".repeat(40)}`;
const DAO_VERIFIER = `0x${"d".repeat(40)}`;
const NOW = 2_000_000_000;
const PRODUCTION_AUDIENCE = "gate.example";
const STAGING_AUDIENCE = "gate-staging.example";
const VOTER = `0x${"1".repeat(40)}`;

function deterministicBytes(byte) {
  let next = byte;
  return (length) => {
    const value = Buffer.alloc(length, next);
    next = (next + 1) & 0xff;
    return value;
  };
}

function makeService({ repository, audience, baseChainId, clock = () => NOW, randomByte = 0x11, ...overrides }) {
  return createAuthService({
    repository,
    audience,
    base: { chainId: baseChainId, verifier: BASE_VERIFIER },
    dao: { chainId: 1, verifier: DAO_VERIFIER, dao: "nouns" },
    clock,
    randomBytes: deterministicBytes(randomByte),
    ...overrides,
  });
}

function proof(challenge, signature) {
  return {
    proofType: "WalletSession",
    typedData: { primaryType: "WalletSession", domain: challenge.domain, message: challenge.message },
    signature,
  };
}

async function mintSession(service, { signer, role }) {
  const challenge = await service.issueChallenge({
    proofType: "WalletSession", wallet: signer.address, role,
  });
  const signature = await signer.signTypedData(challenge.domain, challenge.types, challenge.message);
  return service.verifyProof(proof(challenge, signature));
}

function sessionUnavailable(error) {
  assert.equal(error.message, "session unavailable");
  assert.doesNotMatch(error.message, /0x|Bearer|tokenHash|audience|chainId/i);
  return true;
}

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function stubHttp(authService) {
  return createGateHttpServer({
    authService,
    profileService: {
      async updateProfile({ session }) { return { wallet: session.wallet, role: session.role }; },
      async listPublicProfiles() { return []; },
      async getPublicProfile() { return null; },
    },
    submissionService: {
      async createSubmission({ session }) {
        return { state: "payment_required", publicId: "a".repeat(22), payer: session.wallet };
      },
      async getPublicStatus() { return null; },
      async resumeSubmission() { return null; },
    },
    inboxService: {
      async listInbox({ session }) { return { items: [{ wallet: session.wallet }] }; },
      async getInbox() { return null; },
      async archiveInbox() { return {}; },
    },
  });
}

function environments() {
  const repository = new MemoryAuthRepository();
  const production = makeService({ repository, audience: PRODUCTION_AUDIENCE, baseChainId: 8453, randomByte: 0x21 });
  const staging = makeService({ repository, audience: STAGING_AUDIENCE, baseChainId: 84532, randomByte: 0x31 });
  return { repository, production, staging };
}

test("a staging base_sender token is rejected by production even when the role matches", async () => {
  const { production, staging } = environments();
  const signer = Wallet.createRandom();
  const minted = await mintSession(staging, { signer, role: "base_sender" });
  assert.equal(minted.session.audience, STAGING_AUDIENCE);
  assert.equal(minted.session.chainId, "84532");
  await assert.rejects(production.authenticateSession(minted.token, { role: "base_sender" }), sessionUnavailable);
});

test("a production base_sender token is rejected by staging even when the role matches", async () => {
  const { production, staging } = environments();
  const signer = Wallet.createRandom();
  const minted = await mintSession(production, { signer, role: "base_sender" });
  await assert.rejects(staging.authenticateSession(minted.token, { role: "base_sender" }), sessionUnavailable);
});

test("matching audience and chain are accepted for each wallet-session role", async () => {
  const { production } = environments();
  const signer = Wallet.createRandom();
  for (const role of ["base_sender", "dao_profile", "dao_inbox"]) {
    const minted = await mintSession(production, { signer, role });
    const session = await production.authenticateSession(minted.token, { role });
    assert.deepEqual(session, minted.session);
    assert.equal(session.audience, PRODUCTION_AUDIENCE);
    assert.equal(session.chainId, role === "base_sender" ? "8453" : "1");
  }
});

test("wrong audience is rejected even when role and chain match", async () => {
  const repository = new MemoryAuthRepository();
  const production = makeService({ repository, audience: PRODUCTION_AUDIENCE, baseChainId: 8453, randomByte: 0x41 });
  const impostor = makeService({ repository, audience: STAGING_AUDIENCE, baseChainId: 8453, randomByte: 0x42 });
  const signer = Wallet.createRandom();
  for (const role of ["base_sender", "dao_profile", "dao_inbox"]) {
    const minted = await mintSession(impostor, { signer, role });
    assert.equal(minted.session.chainId, role === "base_sender" ? "8453" : "1");
    await assert.rejects(production.authenticateSession(minted.token, { role }), sessionUnavailable);
  }
});

test("base_sender session with the wrong chain is rejected even when audience matches", async () => {
  const repository = new MemoryAuthRepository();
  const production = makeService({ repository, audience: PRODUCTION_AUDIENCE, baseChainId: 8453, randomByte: 0x51 });
  const sepoliaTwin = makeService({ repository, audience: PRODUCTION_AUDIENCE, baseChainId: 84532, randomByte: 0x52 });
  const signer = Wallet.createRandom();
  const minted = await mintSession(sepoliaTwin, { signer, role: "base_sender" });
  assert.equal(minted.session.audience, PRODUCTION_AUDIENCE);
  assert.equal(minted.session.chainId, "84532");
  await assert.rejects(production.authenticateSession(minted.token, { role: "base_sender" }), sessionUnavailable);
});

test("correct base_sender audience and chain are accepted without an explicit audience argument", async () => {
  const { production } = environments();
  const signer = Wallet.createRandom();
  const minted = await mintSession(production, { signer, role: "base_sender" });
  assert.deepEqual(await production.authenticateSession(minted.token, { role: "base_sender" }), minted.session);
});

test("wrong role is still rejected when audience and chain match", async () => {
  const { production } = environments();
  const signer = Wallet.createRandom();
  const minted = await mintSession(production, { signer, role: "base_sender" });
  await assert.rejects(production.authenticateSession(minted.token, { role: "dao_profile" }), sessionUnavailable);
  await assert.rejects(production.authenticateSession(minted.token, { role: "dao_inbox" }), sessionUnavailable);
});

test("the same wallet does not bypass audience or chain mismatch", async () => {
  const { production, staging } = environments();
  const signer = Wallet.createRandom();
  const stagingMint = await mintSession(staging, { signer, role: "base_sender" });
  const productionMint = await mintSession(production, { signer, role: "base_sender" });
  assert.equal(stagingMint.session.wallet, productionMint.session.wallet);
  await assert.rejects(production.authenticateSession(stagingMint.token, {
    role: "base_sender", wallet: signer.address,
  }), sessionUnavailable);
  await assert.rejects(staging.authenticateSession(productionMint.token, {
    role: "base_sender", wallet: signer.address,
  }), sessionUnavailable);
  assert.deepEqual(await production.authenticateSession(productionMint.token, {
    role: "base_sender", wallet: signer.address,
  }), productionMint.session);
});

test("malformed, expired, and revoked tokens still fail closed without leaking session contents", async () => {
  const repository = new MemoryAuthRepository();
  let now = NOW;
  const service = makeService({ repository, audience: PRODUCTION_AUDIENCE, baseChainId: 8453, clock: () => now });
  const signer = Wallet.createRandom();
  const minted = await mintSession(service, { signer, role: "base_sender" });

  for (const token of ["", "short", minted.token + "x", "a".repeat(43), `${minted.token.slice(0, 20)}/${minted.token.slice(21)}`]) {
    await assert.rejects(service.authenticateSession(token, { role: "base_sender" }), sessionUnavailable);
  }

  now = NOW + 900;
  await assert.rejects(service.authenticateSession(minted.token, { role: "base_sender" }), sessionUnavailable);

  now = NOW;
  const revokedToken = Buffer.alloc(32, 0xab).toString("base64url");
  await repository.transaction(async (transaction) => {
    await transaction.insertSession({
      tokenHash: keccak256(toUtf8Bytes(revokedToken)),
      wallet: signer.address.toLowerCase(),
      role: "base_sender",
      chainId: "8453",
      audience: PRODUCTION_AUDIENCE,
      issuedAt: String(NOW),
      expiry: String(NOW + 900),
      revokedAt: String(NOW),
    });
  });
  await assert.rejects(service.authenticateSession(revokedToken, { role: "base_sender" }), sessionUnavailable);
});

test("dao_profile and dao_inbox bind audience and the Nouns chain, not the Base payout chain", async () => {
  const { production, staging } = environments();
  const signer = Wallet.createRandom();
  for (const role of ["dao_profile", "dao_inbox"]) {
    const minted = await mintSession(staging, { signer, role });
    assert.equal(minted.session.chainId, "1");
    await assert.rejects(production.authenticateSession(minted.token, { role }), sessionUnavailable);
    const local = await mintSession(production, { signer, role });
    assert.deepEqual(await production.authenticateSession(local.token, { role }), local.session);
  }
});

test("HTTP quote and inbox routes reject cross-environment bearer tokens and ignore CORS and cookies", async () => {
  const { production, staging } = environments();
  const signer = Wallet.createRandom();
  const stagingSender = await mintSession(staging, { signer, role: "base_sender" });
  const productionSender = await mintSession(production, { signer, role: "base_sender" });
  const stagingInbox = await mintSession(staging, { signer, role: "dao_inbox" });
  const productionInbox = await mintSession(production, { signer, role: "dao_inbox" });
  const productionProfile = await mintSession(production, { signer, role: "dao_profile" });

  await withServer(stubHttp(production), async (baseUrl) => {
    const quotePath = `/v1/gates/${VOTER}/submissions`;
    const rejected = await fetch(`${baseUrl}${quotePath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stagingSender.token}`,
        "content-type": "application/json",
        origin: "https://evil.example",
        cookie: `session=${productionSender.token}`,
      },
      body: JSON.stringify({ pitch: "hi" }),
    });
    const rejectedBody = await rejected.json();
    assert.equal(rejected.status, 401);
    assert.deepEqual(rejectedBody, { error: { code: "UNAUTHORIZED", message: "authentication required" } });
    assert.equal(JSON.stringify(rejectedBody).includes(stagingSender.token), false);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);

    const cookied = await fetch(`${baseUrl}${quotePath}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `session=${productionSender.token}` },
      body: JSON.stringify({ pitch: "hi" }),
    });
    assert.equal(cookied.status, 401);

    const accepted = await fetch(`${baseUrl}${quotePath}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${productionSender.token}`,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ pitch: "hi" }),
    });
    const acceptedBody = await accepted.json();
    assert.equal(accepted.status, 201);
    assert.equal(acceptedBody.payer, signer.address.toLowerCase());
    assert.equal(accepted.headers.get("access-control-allow-origin"), null);

    const wrongRole = await fetch(`${baseUrl}${quotePath}`, {
      method: "POST",
      headers: { authorization: `Bearer ${productionProfile.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pitch: "hi" }),
    });
    assert.equal(wrongRole.status, 401);

    const inboxRejected = await fetch(`${baseUrl}/v1/gate/me/inbox`, {
      headers: { authorization: `Bearer ${stagingInbox.token}` },
    });
    assert.equal(inboxRejected.status, 401);

    const inboxAccepted = await fetch(`${baseUrl}/v1/gate/me/inbox`, {
      headers: { authorization: `Bearer ${productionInbox.token}` },
    });
    assert.equal(inboxAccepted.status, 200);
  });
});

const fs = require("node:fs");
const { Pool } = require("pg");
const { PostgresGateStore } = require("../src/gate/store");

const databaseUrl = process.env.GAVEL_GATE_TEST_DATABASE_URL;
const disposableConfirmed = process.env.GAVEL_GATE_TEST_DATABASE_DISPOSABLE === "yes";
let safeDatabaseName = false;
try { safeDatabaseName = /(?:_test|_disposable)$/.test(new URL(databaseUrl).pathname.slice(1)); } catch {}
const canRunPostgres = Boolean(databaseUrl && disposableConfirmed && safeDatabaseName);
const postgresSkip = !databaseUrl
  ? "GAVEL_GATE_TEST_DATABASE_URL is not set; disposable PostgreSQL integration was not run"
  : "destructive integration requires GAVEL_GATE_TEST_DATABASE_DISPOSABLE=yes and a database name ending _test or _disposable";

test("PostgreSQL-backed staging sessions are rejected by a production auth service on a shared repository", {
  skip: canRunPostgres ? false : postgresSkip,
}, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const signer = Wallet.createRandom();
  try {
    await pool.query("SELECT pg_advisory_lock(hashtext('gavel-gate-destructive-integration'))");
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE");
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query(migration);
    const repository = new PostgresGateStore({ pool });
    const production = makeService({ repository, audience: PRODUCTION_AUDIENCE, baseChainId: 8453, randomByte: 0x61 });
    const staging = makeService({ repository, audience: STAGING_AUDIENCE, baseChainId: 84532, randomByte: 0x62 });
    const minted = await mintSession(staging, { signer, role: "base_sender" });
    assert.equal(minted.session.audience, STAGING_AUDIENCE);
    assert.equal(minted.session.chainId, "84532");
    await assert.rejects(production.authenticateSession(minted.token, { role: "base_sender" }), sessionUnavailable);
    const local = await mintSession(production, { signer, role: "base_sender" });
    assert.deepEqual(await production.authenticateSession(local.token, { role: "base_sender" }), local.session);
    await withServer(stubHttp(production), async (baseUrl) => {
      const rejected = await fetch(`${baseUrl}/v1/gates/${VOTER}/submissions`, {
        method: "POST",
        headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
        body: JSON.stringify({ pitch: "hi" }),
      });
      assert.equal(rejected.status, 401);
      const accepted = await fetch(`${baseUrl}/v1/gates/${VOTER}/submissions`, {
        method: "POST",
        headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
        body: JSON.stringify({ pitch: "hi" }),
      });
      assert.equal(accepted.status, 201);
    });
  } finally {
    await pool.query("DROP SCHEMA IF EXISTS gate CASCADE").catch(() => {});
    await pool.query("DROP SCHEMA IF EXISTS gate_public CASCADE").catch(() => {});
    await pool.query("DELETE FROM public.schema_migrations WHERE version='gate/001_gate-v3'").catch(() => {});
    await pool.query("SELECT pg_advisory_unlock(hashtext('gavel-gate-destructive-integration'))").catch(() => {});
    await pool.end();
  }
});
