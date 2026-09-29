"use strict";

const { Pool } = require("pg");

// These tests mutate schemas and roles. An opt-in URL is not proof of which
// PostgreSQL cluster answered; prove the database and cluster on every checkout.
function disposableTarget(url, prefix) {
  try {
    const parsed = new URL(url);
    return ["postgres:", "postgresql:"].includes(parsed.protocol) && ["postgres", "127.0.0.1"].includes(parsed.hostname) &&
      new RegExp(`^${prefix}_[a-z0-9_]+_disposable$`).test(parsed.pathname.slice(1)) &&
      !parsed.search && !parsed.hash;
  } catch { return false; }
}

function attestedPool(url, options = {}, prefix = "gavel_test") {
  const nonce = process.env.GAVEL_TEST_DATABASE_NONCE;
  const clusterId = process.env.GAVEL_TEST_CLUSTER_ID;
  if (process.env.GAVEL_TEST_DISPOSABLE_OPT_IN !== "I_UNDERSTAND_DISPOSABLE_DB" ||
      !disposableTarget(url, prefix) || !/^[a-f0-9]{32}$/.test(nonce || "") ||
      !/^[0-9]+$/.test(clusterId || "")) {
    throw new Error("refusing destructive PostgreSQL tests: disposable target proof missing");
  }
  const raw = new Pool({ ...options, connectionString: url });
  return {
    async connect() {
      const client = await raw.connect();
      try {
        const db = await client.query("SELECT shobj_description(oid, 'pg_database') AS proof FROM pg_database WHERE datname=current_database()");
        const cluster = await client.query("SELECT system_identifier::text AS id, pg_read_file('gavel-disposable-cluster.attestation') AS nonce FROM pg_control_system()");
        if (db.rows[0]?.proof !== `gavel-disposable:${nonce}` || cluster.rows[0]?.id !== clusterId || cluster.rows[0]?.nonce !== nonce) {
          throw new Error("refusing destructive PostgreSQL tests: cluster attestation mismatch");
        }
        return client;
      } catch (error) { client.release(true); throw error; }
    },
    async query(...args) {
      const client = await this.connect();
      try { return await client.query(...args); } finally { client.release(); }
    },
    async end() { await raw.end(); },
    get totalCount() { return raw.totalCount; },
    get waitingCount() { return raw.waitingCount; },
  };
}

module.exports = { attestedPool, disposableTarget };
