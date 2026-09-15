const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "../../..");
const {
  APPLICATION_ROLES,
  GATE_ROLES,
  GATE_TABLE_PRIVILEGES,
  PROVISIONED_ROLES,
  ensureRoles,
  verifyGatePermissions,
} = require("../../governance-index/src/roles");
const { PostgresGovernanceStore } = require("../../governance-index/src/postgres-store");

function section(compose, name, next) {
  const end = next ? `(?=\\n  ${next}:)` : "$";
  return compose.match(new RegExp(`\\n  ${name}:[\\s\\S]*?${end}`))[0];
}

function provisioningPool(existing = PROVISIONED_ROLES) {
  const calls = [];
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (/SELECT rolname FROM pg_roles/.test(text)) return { rows: existing.map((rolname) => ({ rolname })) };
      if (/rolsuper OR rolcreaterole/.test(text)) return { rows: [{ allowed: true }] };
      if (/object_type/.test(text) && /owned/.test(text)) return { rows: [] };
      if (/gavel_reconcile_role\(\$1,\$2\)/.test(text)) return { rows: [{ revoked_memberships: 0 }] };
      return { rows: [] };
    },
    release() {},
  };
  return { calls, async connect() { return client; }, query: client.query.bind(client) };
}

test("role inventory preserves application roles and authoritatively includes Gate", () => {
  assert.deepEqual(APPLICATION_ROLES, ["gavel_indexer", "gavel_api"]);
  assert.deepEqual(GATE_ROLES, ["gavel_gate"]);
  assert.deepEqual(PROVISIONED_ROLES, ["gavel_indexer", "gavel_api", "gavel_gate"]);
});

test("Gate privilege audit has one exact migration-matched table matrix", () => {
  assert.deepEqual(GATE_TABLE_PRIVILEGES, {
    auth_nonces: ["SELECT"],
    auth_sessions: ["SELECT"],
    capacity_reservations: ["SELECT", "INSERT", "UPDATE"],
    dao_policies: ["SELECT"],
    delivery_settings: ["SELECT"],
    inbox_items: ["SELECT", "INSERT", "UPDATE"],
    notification_attempts: ["SELECT", "INSERT"],
    profile_version_authorizations: [],
    profiles: ["SELECT"],
    proposal_snapshots: ["SELECT", "INSERT"],
    quotes: ["SELECT", "INSERT", "UPDATE"],
    rate_limit_events: ["SELECT"],
    sender_blocks: ["SELECT"],
    settlement_cursors: ["SELECT", "INSERT", "UPDATE"],
    settlement_scan_blocks: [],
    settlement_scan_observations: [],
    settlement_scan_ranges: [],
    settlement_reorg_monitors: ["SELECT", "INSERT", "UPDATE"],
    splitter_deployments: ["SELECT", "INSERT", "UPDATE"],
    submissions: ["SELECT", "INSERT", "UPDATE"],
  });
  assert.equal(Object.isFrozen(GATE_TABLE_PRIVILEGES), true);
  for (const privileges of Object.values(GATE_TABLE_PRIVILEGES)) assert.equal(Object.isFrozen(privileges), true);
  const migration = fs.readFileSync(path.join(ROOT, "packages/server/migrations/001_gate.sql"), "utf8");
  const migratedTables = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS gate\.([a-z_]+)/g)]
    .map((match) => match[1]).sort();
  assert.deepEqual(Object.keys(GATE_TABLE_PRIVILEGES).sort(), migratedTables,
    "the privilege audit must inventory every table created by the Gate migration");
});

test("ensureRoles reconciles existing role attributes, memberships, and passwords without embedding secrets in SQL", async () => {
  const pool = provisioningPool();
  const passwords = {
    GAVEL_INDEXER_DB_PASSWORD: "indexer-' rotation",
    GAVEL_API_DB_PASSWORD: "api-' rotation",
    GAVEL_GATE_DB_PASSWORD: "gate-' rotation",
  };
  const store = new PostgresGovernanceStore({ pool });
  const result = await store.ensureRoles({ env: passwords });

  assert.deepEqual(result, { state: "reconciled", created: [], reconciled: PROVISIONED_ROLES, missing: [] });
  const source = pool.calls.map(({ text }) => text).join("\n");
  assert.match(source, /LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION/);
  assert.match(source, /pg_auth_members/);
  assert.match(source, /REVOKE %I FROM %I/);
  assert.match(source, /PASSWORD %L/);
  assert.match(source, /log_parameter_max_length_on_error/);
  for (const password of Object.values(passwords)) assert.doesNotMatch(source, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const rotations = pool.calls.filter(({ text }) => /gavel_reconcile_role\(\$1,\$2\)/.test(text));
  assert.deepEqual(rotations.map(({ values }) => values[0]), PROVISIONED_ROLES);
  assert.deepEqual(rotations.map(({ values }) => values[1]), Object.values(passwords));
});

test("the reusable index role helper preserves its original two-role scope", async () => {
  const pool = provisioningPool(APPLICATION_ROLES);
  const result = await ensureRoles(pool, { env: {
    GAVEL_INDEXER_DB_PASSWORD: "indexer", GAVEL_API_DB_PASSWORD: "api",
  } });
  assert.deepEqual(result.reconciled, APPLICATION_ROLES);
  const rotations = pool.calls.filter(({ text }) => /gavel_reconcile_role\(\$1,\$2\)/.test(text));
  assert.deepEqual(rotations.map(({ values }) => values[0]), APPLICATION_ROLES);
});

test("ensureRoles refuses to bless application roles that own database objects", async () => {
  const pool = provisioningPool();
  const original = pool.query;
  pool.query = async (text, values) => {
    if (/object_type/.test(text) && /owned/.test(text)) return { rows: [{ role: "gavel_gate", object_type: "table", owned: "gate.profiles" }] };
    return original(text, values);
  };
  const store = new PostgresGovernanceStore({ pool });
  await assert.rejects(
    store.ensureRoles({ env: {
      GAVEL_INDEXER_DB_PASSWORD: "i", GAVEL_API_DB_PASSWORD: "a", GAVEL_GATE_DB_PASSWORD: "g",
    } }),
    /gavel_gate owns table gate\.profiles/,
  );
});

function permissionPool({ leakApi = false, dangerousGate = false, catalogLeak = false, missingFunction = false } = {}) {
  return {
    async query(text, values = []) {
      if (/FROM pg_tables/.test(text)) {
        if (text.includes("schemaname=$1")) return { rows: values[0] === "gate"
          ? Object.keys(GATE_TABLE_PRIVILEGES).map((tablename) => ({ tablename }))
          : [{ tablename: "proposals" }] };
        return { rows: [] };
      }
      if (/FROM pg_sequences/.test(text)) return { rows: [{ sequencename: values[0] === "gate" ? "sender_blocks_id_seq" : "vote_events_id_seq" }] };
      if (/FROM pg_attribute/.test(text)) return { rows: values[0] === "gate"
        ? Object.keys(GATE_TABLE_PRIVILEGES).map((table_name) => ({ table_name, column_name: "id" }))
        : [{ table_name: "proposals", column_name: "dao_id" }] };
      if (/has_table_privilege\('gavel_gate'/.test(text)) {
        return { rows: values[0].flatMap((table_name) => values[1].map((privilege) => ({
          table_name,
          privilege,
          granted: GATE_TABLE_PRIVILEGES[table_name].includes(privilege)
            || (catalogLeak && table_name === "notification_attempts" && privilege === "UPDATE"),
        }))) };
      }
      if (/has_function_privilege\('gavel_gate'/.test(text)) {
        return { rows: values[0].map((signature) => ({
          signature, granted: !(missingFunction && signature.includes("mutate_profile")),
        })) };
      }
      if (/FROM pg_roles WHERE rolname = \$1/.test(text)) {
        return { rows: [{ login: true, superuser: false, createrole: false, createdb: false, inherit: false, bypassrls: false, replication: false }] };
      }
      if (/pg_auth_members|object_type/.test(text)) return { rows: [] };
      return { rows: [] };
    },
    async connect() {
      let role;
      return {
        async query(text) {
          const match = text.match(/SET LOCAL ROLE "([^"]+)"/);
          if (match) { role = match[1]; return { rows: [] }; }
          const gateAccess = /gate\."/.test(text);
          const operation = /^(?:SELECT 1 FROM|INSERT INTO|UPDATE|DELETE FROM)\s+gate\."([^"]+)"/i.exec(text);
          const privilege = operation && (/^SELECT/i.test(text) ? "SELECT" : /^(INSERT|UPDATE|DELETE)/i.exec(text)[1].toUpperCase());
          const outsideMatrix = operation && !GATE_TABLE_PRIVILEGES[operation[1]]?.includes(privilege);
          const publicAccess = /public\./i.test(text);
          const gateCreate = /CREATE TABLE\s+gate\./i.test(text);
          const denied = (role !== "gavel_gate" && gateAccess && !(leakApi && role === "gavel_api"))
            || (role === "gavel_gate" && !dangerousGate && (outsideMatrix || publicAccess || gateCreate));
          if (denied) throw Object.assign(new Error("permission denied"), { code: "42501" });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

test("Gate audit exercises required private operations and proves cross-schema isolation", async () => {
  const result = await verifyGatePermissions(permissionPool());
  assert.equal(result.ok, true);
  assert.equal(result.method, "effective");
  assert.deepEqual(result.violations, []);

  const overGranted = await verifyGatePermissions(permissionPool({ dangerousGate: true }));
  assert.equal(overGranted.ok, false);
  assert.match(overGranted.violations.join("\n"), /gavel_gate can (?:DELETE gate\.profiles|mutate public\.proposals)/);

  const leaked = await verifyGatePermissions(permissionPool({ leakApi: true }));
  assert.equal(leaked.ok, false);
  assert.match(leaked.violations.join("\n"), /gavel_api can access gate\.profiles/);

  const catalogMismatch = await verifyGatePermissions(permissionPool({ catalogLeak: true }));
  assert.equal(catalogMismatch.ok, false);
  assert.match(catalogMismatch.violations.join("\n"), /unexpected UPDATE on gate\.notification_attempts/);

  const missingFunctionGrant = await verifyGatePermissions(permissionPool({ missingFunction: true }));
  assert.equal(missingFunctionGrant.ok, false);
  assert.match(missingFunctionGrant.violations.join("\n"), /lacks EXECUTE on gate\.mutate_profile/);
});

test("migration grants only safe projections to the public API role", () => {
  const sql = fs.readFileSync(path.join(ROOT, "packages/server/migrations/001_gate.sql"), "utf8");
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS gate_public/i);
  for (const view of ["profiles", "dao_policies", "submission_receipts"]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE VIEW gate_public\\.${view}`));
  }
  assert.match(sql, /GRANT SELECT ON gate_public\.profiles,gate_public\.dao_policies,gate_public\.submission_receipts TO gavel_api/i);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:gate\.inbox_items|gate\.profile_version_authorizations)[^;]*TO gavel_api/i);
  assert.doesNotMatch(sql, /GRANT[^;]*gate\.profile_version_authorizations[^;]*TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.transition_notification\(text,gate\.notification_state,text,text\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.release_expired_reservation\(text,text\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.mutate_profile\(text,text,text,gate\.availability,jsonb,boolean,timestamptz,boolean,text,boolean,jsonb\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.record_scanner_range\(text,bigint,bigint,text,timestamptz,jsonb\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.insert_auth_nonce\(gate\.auth_proof_type,gate\.auth_purpose,gate\.auth_role,text,text,bigint,text,text,text,bigint,bigint\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.consume_auth_nonce\(text,bigint\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.insert_auth_session\(text,text,gate\.auth_role,bigint,text,bigint,bigint\) TO gavel_gate/i);
  assert.doesNotMatch(sql, /GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*gate\.(?:auth_nonces|auth_sessions)[^;]*TO gavel_gate/i);
  assert.doesNotMatch(sql, /GRANT[^;]*UPDATE[^;]*gate\.notification_attempts/i);
});

test("fresh-volume init scripts remain separate and never pass secrets in psql argv", () => {
  const governanceInit = fs.readFileSync(path.join(ROOT, "packages/governance-index/docker/init-db.sh"), "utf8");
  const gateInit = fs.readFileSync(path.join(ROOT, "packages/server/docker/init-db.sh"), "utf8");
  assert.match(governanceInit, /CREATE ROLE gavel_api LOGIN/);
  assert.match(governanceInit, /CREATE ROLE gavel_indexer LOGIN/);
  assert.doesNotMatch(governanceInit, /GAVEL_GATE_DB_PASSWORD|gavel_gate/);
  assert.match(gateInit, /CREATE ROLE gavel_gate LOGIN/);
  assert.doesNotMatch(gateInit, /GAVEL_(?:API|INDEXER)_DB_PASSWORD|gavel_api|gavel_indexer/);
  for (const script of [governanceInit, gateInit]) {
    assert.match(script, /\\getenv/);
    assert.match(script, /\\set QUIET on/);
    assert.match(script, /SET log_statement = 'none'/);
    assert.match(script, /SET log_min_error_statement = 'panic'/);
    assert.doesNotMatch(script, /--set=.*PASSWORD|psql[^\n]*\$GAVEL_.*PASSWORD/);
  }
});

test("compose wires numbered initializers and limits Gate credentials to bootstrap and migration", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY packages \.\/packages/, "the migrate image must include the sibling server migration");
  const postgres = section(compose, "postgres", "migrate");
  const migrate = section(compose, "migrate", "api");
  const api = section(compose, "api", "indexer");
  const indexer = section(compose, "indexer", null);
  assert.match(postgres, /governance-index\/docker\/init-db\.sh:\/docker-entrypoint-initdb\.d\/10-gavel-index-roles\.sh:ro/);
  assert.match(postgres, /server\/docker\/init-db\.sh:\/docker-entrypoint-initdb\.d\/20-gavel-gate-role\.sh:ro/);
  for (const variable of ["GAVEL_INDEXER_DB_PASSWORD", "GAVEL_API_DB_PASSWORD", "GAVEL_GATE_DB_PASSWORD"]) {
    assert.match(postgres, new RegExp(`${variable}:`));
    assert.match(migrate, new RegExp(`${variable}:`));
  }
  assert.doesNotMatch(api, /GAVEL_GATE_DB_PASSWORD/);
  assert.doesNotMatch(indexer, /GAVEL_GATE_DB_PASSWORD/);
});

test("migration reports Gate only after its effective permission audit succeeds", () => {
  const source = fs.readFileSync(path.join(ROOT, "packages/governance-index/src/postgres-store.js"), "utf8");
  const apply = source.indexOf("await this.pool.query(await fs.readFile(gateMigration");
  const audit = source.indexOf("await auditRoles(this.pool)", apply);
  const report = source.indexOf('versions.push("gate/001_gate-v3")', apply);
  assert.ok(apply > 0 && audit > apply && report > audit, "Gate must be applied, audited, then reported");
});
