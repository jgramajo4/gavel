"use strict";

/**
 * One Gate database per environment.
 *
 * `gate.profiles` has no environment dimension and `wallet` is UNIQUE, so a
 * shared staging/production database publishes and overwrites enrollments
 * across environments. Isolation is a startup concern, not a profile-schema
 * change. Fail-closed enforcement is explicit so a still-shared production
 * database is not bricked by deploying this code.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { assertEnvironmentIsolation, serverConfigFromEnv } = require("../bin/gavel-server");

const PRODUCTION_SPLITTER = "0x1111111111111111111111111111111111111111";
const STAGING_SPLITTER = "0x2222222222222222222222222222222222222222";
const ROTATION_SPLITTER = "0x3333333333333333333333333333333333333333";

const PRODUCTION = Object.freeze({
  environment: "production",
  chainId: "8453",
  splitter: PRODUCTION_SPLITTER,
  enforcement: "enforced",
});
const TEST = Object.freeze({
  environment: "test",
  chainId: "84532",
  splitter: STAGING_SPLITTER,
  enforcement: "enforced",
});

function poolOf(rows, statements) {
  return {
    async query(sql) {
      if (statements) statements.push(sql);
      return { rows };
    },
  };
}

function row({ environment, chainId, splitter, issuanceActive = false }) {
  return { environment, chainId, splitter, issuanceActive };
}

test("enforced production starts on a production-only database", async () => {
  const result = await assertEnvironmentIsolation(poolOf([
    row({ environment: "production", chainId: "8453", splitter: PRODUCTION_SPLITTER, issuanceActive: true }),
  ]), PRODUCTION);
  assert.equal(result.environment, "production");
  assert.equal(result.chainId, "8453");
  assert.equal(result.enforcement, "enforced");
  assert.equal(result.deployments, 1);
});

test("enforced staging starts on a staging-only database", async () => {
  const result = await assertEnvironmentIsolation(poolOf([
    row({ environment: "test", chainId: "84532", splitter: STAGING_SPLITTER, issuanceActive: true }),
  ]), TEST);
  assert.equal(result.environment, "test");
  assert.equal(result.chainId, "84532");
  assert.equal(result.deployments, 1);
});

test("same-environment splitter rotation is not a shared database", async () => {
  await assertEnvironmentIsolation(poolOf([
    row({ environment: "production", chainId: "8453", splitter: PRODUCTION_SPLITTER, issuanceActive: false }),
    row({ environment: "production", chainId: "8453", splitter: ROTATION_SPLITTER, issuanceActive: true }),
  ]), { ...PRODUCTION, splitter: ROTATION_SPLITTER });
});

test("a clean fresh database is left to the existing missing-deployment check", async () => {
  assert.deepEqual(await assertEnvironmentIsolation(poolOf([]), PRODUCTION), {
    environment: "production",
    chainId: "8453",
    enforcement: "enforced",
    deployments: 0,
    foreign: 0,
  });
});

test("enforced production refuses a database that also holds a test deployment", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      row({ environment: "production", chainId: "8453", splitter: PRODUCTION_SPLITTER, issuanceActive: true }),
      row({ environment: "test", chainId: "84532", splitter: STAGING_SPLITTER, issuanceActive: true }),
    ]), PRODUCTION),
    (error) => {
      assert.match(error.message, /shared with another environment/);
      assert.match(error.message, /this process is production\/8453/);
      assert.match(error.message, /test\/84532/);
      assert.match(error.message, /Give each environment its own database/);
      return true;
    },
  );
});

test("enforced staging refuses the same mixed database from the other side", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      row({ environment: "production", chainId: "8453", splitter: PRODUCTION_SPLITTER, issuanceActive: true }),
      row({ environment: "test", chainId: "84532", splitter: STAGING_SPLITTER, issuanceActive: true }),
    ]), TEST),
    /this process is test\/84532.*production\/8453/s,
  );
});

test("enforced production refuses a deployment on the wrong chain", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      row({ environment: "production", chainId: "84532", splitter: PRODUCTION_SPLITTER, issuanceActive: true }),
    ]), PRODUCTION),
    /production\/84532/,
  );
});

test("enforced production refuses a foreign splitter for this environment", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      row({ environment: "production", chainId: "8453", splitter: STAGING_SPLITTER, issuanceActive: true }),
    ]), PRODUCTION),
    (error) => {
      assert.match(error.message, /splitter/);
      assert.doesNotMatch(error.message, /0x2222/i);
      return true;
    },
  );
});

test("enforced production refuses an active issuance row that is not the configured splitter", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      row({ environment: "production", chainId: "8453", splitter: PRODUCTION_SPLITTER, issuanceActive: false }),
      row({ environment: "production", chainId: "8453", splitter: ROTATION_SPLITTER, issuanceActive: true }),
    ]), PRODUCTION),
    /issuance/,
  );
});

test("an unlabeled deployment is named rather than silently tolerated when enforced", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      row({ environment: null, chainId: "8453", splitter: PRODUCTION_SPLITTER }),
    ]), PRODUCTION),
    /unlabeled\/8453/,
  );
});

test("disabled enforcement inventories mixed state and still starts", async () => {
  const result = await assertEnvironmentIsolation(poolOf([
    row({ environment: "production", chainId: "8453", splitter: PRODUCTION_SPLITTER, issuanceActive: true }),
    row({ environment: "test", chainId: "84532", splitter: STAGING_SPLITTER, issuanceActive: true }),
  ]), { ...PRODUCTION, enforcement: "disabled" });
  assert.equal(result.enforcement, "disabled");
  assert.equal(result.deployments, 2);
  assert.equal(result.foreign, 1);
});

test("the guard requires an explicit environment, chain, and enforcement mode", async () => {
  await assert.rejects(assertEnvironmentIsolation(poolOf([]), {}), /environment and chain are required/);
  await assert.rejects(assertEnvironmentIsolation(poolOf([]), { environment: "production" }), /environment and chain are required/);
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([]), { environment: "production", chainId: "8453", enforcement: "maybe" }),
    /enforcement/,
  );
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([]), { environment: "production", chainId: "8453", enforcement: "enforced" }),
    /configured splitter/,
  );
  await assert.rejects(assertEnvironmentIsolation(null, PRODUCTION), /database pool is required/);
});

test("composeProduction awaits isolation before composing Gate services", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../bin/gavel-server.js"), "utf8");
  const compose = source.slice(source.indexOf("async function composeProduction"), source.indexOf("async function closeServer"));
  assert.match(compose, /await assertEnvironmentIsolation\(store\.pool/);
  assert.ok(compose.indexOf("await assertEnvironmentIsolation") < compose.indexOf("createAuthService"));
  assert.ok(compose.indexOf("await assertEnvironmentIsolation") < compose.indexOf("createProfileService"));
});

test("the guard only reads; it cannot mutate deployment or profile rows", async () => {
  const statements = [];
  await assertEnvironmentIsolation(poolOf([], statements), PRODUCTION);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^SELECT[\s\S]*FROM gate\.splitter_deployments/i);
  assert.doesNotMatch(statements[0].toUpperCase(), /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bALTER\b|\bTRUNCATE\b/);
});

test("server config treats isolation enforcement as disabled until explicitly enforced", () => {
  const base = {
    GAVEL_GATE_ENVIRONMENT: "production",
    GAVEL_GATE_SPLITTER: PRODUCTION_SPLITTER,
    GAVEL_GATE_BASE_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    GAVEL_GATE_BASE_CHAIN_ID: "8453",
    GAVEL_GATE_QUOTE_SIGNER_ADDRESS: "0x4444444444444444444444444444444444444444",
    GAVEL_GATE_OWNER_RECIPIENT: "0x5555555555555555555555555555555555555555",
    GAVEL_GATE_DATABASE_URL: "postgres://gavel_gate@localhost/gavel_gate_production",
    GAVEL_GATE_BASE_RPC_URL: "https://example.invalid",
    GAVEL_GATE_ETHEREUM_RPC_URL: "https://example.invalid",
    GAVEL_GATE_QUOTE_SIGNER: "0x".padEnd(66, "1"),
    GAVEL_GATE_API_AUDIENCE: "gate.local",
    GAVEL_GATE_INDEX_URL: "https://index.example",
    GAVEL_GATE_BASE_VERIFIER: PRODUCTION_SPLITTER,
    GAVEL_GATE_DAO_VERIFIER: PRODUCTION_SPLITTER,
    GAVEL_GATE_NOTIFIER_MODE: "disabled",
  };
  assert.equal(serverConfigFromEnv(base).isolationEnforcement, "disabled");
  assert.equal(serverConfigFromEnv({
    ...base,
    GAVEL_GATE_ENFORCE_ENVIRONMENT_ISOLATION: "disabled",
  }).isolationEnforcement, "disabled");
  assert.equal(serverConfigFromEnv({
    ...base,
    GAVEL_GATE_ENFORCE_ENVIRONMENT_ISOLATION: "enforced",
  }).isolationEnforcement, "enforced");
  assert.throws(
    () => serverConfigFromEnv({ ...base, GAVEL_GATE_ENFORCE_ENVIRONMENT_ISOLATION: "yes" }),
    /GAVEL_GATE_ENFORCE_ENVIRONMENT_ISOLATION/,
  );
});
