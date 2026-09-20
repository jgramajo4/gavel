"use strict";

/**
 * One Gate database per environment.
 *
 * `gate.profiles` has no environment, deployment, or settlement-chain column,
 * and `listProfiles` filters on DAO and availability alone — so a database
 * shared between staging and production publishes each environment's Gates in
 * the other's public directory. `gate.profiles.wallet` is UNIQUE on top of
 * that, so the two environments share one mutable row per wallet rather than
 * merely seeing each other's.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { assertEnvironmentIsolation } = require("../bin/gavel-server");

function poolOf(rows) {
  return { async query() { return { rows }; } };
}

const PRODUCTION = { environment: "production", chainId: "8453" };
const TEST = { environment: "test", chainId: "84532" };

test("a database holding only this environment's deployments starts", async () => {
  assert.deepEqual(
    await assertEnvironmentIsolation(poolOf([{ environment: "production", chainId: "8453" }]), PRODUCTION),
    { environment: "production", chainId: "8453", deployments: 1 },
  );
  assert.deepEqual(
    await assertEnvironmentIsolation(poolOf([{ environment: "test", chainId: "84532" }]), TEST),
    { environment: "test", chainId: "84532", deployments: 1 },
  );
});

test("splitter rotation is not mistaken for a shared database", async () => {
  // The rotation runbook requires the draining splitter to stay configured and
  // scanned. Several same-environment deployments are therefore normal.
  const rotating = poolOf([{ environment: "production", chainId: "8453" }]);
  await assertEnvironmentIsolation(rotating, PRODUCTION);
});

test("an empty deployment table is left to the existing missing-deployment check", async () => {
  assert.deepEqual(await assertEnvironmentIsolation(poolOf([]), PRODUCTION),
    { environment: "production", chainId: "8453", deployments: 0 });
});

test("production refuses to start on a database that also holds a test deployment", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      { environment: "production", chainId: "8453" },
      { environment: "test", chainId: "84532" },
    ]), PRODUCTION),
    (error) => {
      assert.match(error.message, /shared with another environment/);
      assert.match(error.message, /this process is production\/8453/);
      assert.match(error.message, /test\/84532/);
      // The refusal has to say what to do, or it just looks like an outage.
      assert.match(error.message, /Give each environment its own database/);
      return true;
    },
  );
});

test("staging refuses the same database from the other side", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([
      { environment: "production", chainId: "8453" },
      { environment: "test", chainId: "84532" },
    ]), TEST),
    /this process is test\/84532.*production\/8453/s,
  );
});

test("a deployment on an unexpected chain for this environment is refused", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([{ environment: "production", chainId: "84532" }]), PRODUCTION),
    /production\/84532/,
  );
});

test("an unlabeled deployment is named rather than silently tolerated", async () => {
  await assert.rejects(
    assertEnvironmentIsolation(poolOf([{ environment: null, chainId: "8453" }]), PRODUCTION),
    /unlabeled\/8453/,
  );
});

test("the guard requires an explicit environment and chain", async () => {
  await assert.rejects(assertEnvironmentIsolation(poolOf([]), {}), /environment and chain are required/);
  await assert.rejects(assertEnvironmentIsolation(poolOf([]), { environment: "production" }), /environment and chain are required/);
  await assert.rejects(assertEnvironmentIsolation(null, PRODUCTION), /database pool is required/);
});

test("the guard only reads; it cannot change ownership or auth semantics", async () => {
  const statements = [];
  const pool = { async query(sql) { statements.push(sql); return { rows: [] }; } };
  await assertEnvironmentIsolation(pool, PRODUCTION);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^SELECT DISTINCT/);
  assert.doesNotMatch(statements[0].toUpperCase(), /INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE/);
});
