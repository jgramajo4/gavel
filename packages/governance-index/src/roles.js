// Application role provisioning and effective-permission verification.
//
// Two properties have to hold before the index serves anything:
//
//   * the application roles exist and carry the grants they are supposed to
//   * `gavel_api` genuinely cannot write, proven by attempting writes while
//     acting as that role rather than by reading GRANT statements back out of
//     the catalog
//
// Both live here so `migrate` and `verify-permissions` cannot disagree about
// what "least privilege is configured" means.
const { redactErrorMessage } = require("./redaction");

const APPLICATION_ROLES = ["gavel_indexer", "gavel_api"];
const ROLE_PASSWORD_VARIABLES = {
  gavel_indexer: "GAVEL_INDEXER_DB_PASSWORD",
  gavel_api: "GAVEL_API_DB_PASSWORD",
};
// TRUNCATE, REFERENCES and TRIGGER are write-adjacent: none of them belong to a
// read-only reporting role, and REFERENCES/TRIGGER are privilege-escalation
// paths onto tables the role cannot otherwise modify.
const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const PROBE_PRIVILEGES = ["SELECT", ...WRITE_PRIVILEGES];
const EXPECTATIONS = ["read-only", "read-write"];
const INSUFFICIENT_PRIVILEGE = "42501";
const UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_$]{0,62}$/;

function assertRoleName(role) {
  if (typeof role !== "string" || !UNQUOTED_IDENTIFIER.test(role)) {
    throw new TypeError("role must be a lower-case unquoted PostgreSQL identifier");
  }
  return role;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function presentRoles(pool, roles = APPLICATION_ROLES) {
  const rows = (await pool.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [roles])).rows;
  return rows.map((row) => row.rolname);
}

// Creates the application roles when they are missing. This is what makes a
// redeploy onto an existing PostgreSQL volume converge: docker-entrypoint
// init scripts only ever run against an empty data directory, so on every
// later deploy the roles have to be reconciled by the migration step instead.
async function ensureRoles(pool, options = {}) {
  const env = options.env || process.env;
  const wanted = options.roles || APPLICATION_ROLES;
  const existing = await presentRoles(pool, wanted);
  const missing = wanted.filter((role) => !existing.includes(role));
  if (!missing.length) return { state: "present", created: [], missing: [] };

  const privileged = (await pool.query(
    "SELECT (rolsuper OR rolcreaterole) AS allowed FROM pg_roles WHERE rolname = current_user",
  )).rows[0]?.allowed === true;
  if (!privileged) {
    return {
      state: "skipped",
      created: [],
      missing,
      reason: `the migration connection lacks CREATEROLE, so ${missing.join(", ")} cannot be created here; create them with a privileged connection and re-run migrate`,
    };
  }

  const unset = missing.filter((role) => !env[ROLE_PASSWORD_VARIABLES[role]]);
  if (unset.length) {
    return {
      state: "skipped",
      created: [],
      missing,
      reason: `no password supplied for ${unset.join(", ")}; set ${unset.map((role) => ROLE_PASSWORD_VARIABLES[role]).join(" and ")} on the migration environment and re-run migrate`,
    };
  }

  const created = [];
  for (const role of missing) {
    const password = env[ROLE_PASSWORD_VARIABLES[role]];
    try {
      // Quoted server-side by format(), so the password is never concatenated
      // into SQL by this process and never reaches a log line from here.
      const statements = (await pool.query(
        `SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS create_role,
                format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text) AS grant_connect`,
        [role, password],
      )).rows[0];
      await pool.query(statements.create_role);
      await pool.query(statements.grant_connect);
      created.push(role);
    } catch (error) {
      throw new Error(`failed to create role ${role}: ${redactErrorMessage(error)}`);
    }
  }
  return { state: "created", created, missing: [] };
}

async function publicTables(pool) {
  return (await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  )).rows.map((row) => row.tablename);
}

async function firstColumns(pool) {
  const rows = (await pool.query(`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum = 1 AND NOT a.attisdropped
  `)).rows;
  return new Map(rows.map((row) => [row.table_name, row.column_name]));
}

async function roleAttributes(pool, role) {
  return (await pool.query(`
    SELECT rolsuper AS superuser, rolcreaterole AS createrole, rolcreatedb AS createdb,
           rolbypassrls AS bypassrls, rolreplication AS replication
    FROM pg_roles WHERE rolname = $1
  `, [role])).rows[0] || null;
}

// The catalog view. It is not sufficient on its own -- that is what the probe
// below is for -- but it catches column-level grants and the privileges that
// cannot be exercised safely against a live database (TRUNCATE takes an ACCESS
// EXCLUSIVE lock; ALTER/DROP depend on table ownership).
async function catalogPrivileges(pool, role, tables) {
  const rows = (await pool.query(`
    SELECT t.tablename, p.privilege,
           has_table_privilege($1, format('public.%I', t.tablename), p.privilege) AS granted
    FROM unnest($2::text[]) AS t(tablename)
    CROSS JOIN unnest($3::text[]) AS p(privilege)
  `, [role, tables, PROBE_PRIVILEGES])).rows;
  const writable = [];
  const unreadable = [];
  for (const row of rows) {
    if (row.privilege === "SELECT") {
      if (!row.granted) unreadable.push(row.tablename);
    } else if (row.granted) {
      writable.push(`${row.tablename}:${row.privilege}`);
    }
  }
  const canCreate = (await pool.query(
    "SELECT has_schema_privilege($1,'public','CREATE') AS granted", [role],
  )).rows[0].granted === true;
  // Ownership is what actually authorises ALTER and DROP, so it is checked as
  // membership in the owning role rather than as a grant.
  const owns = (await pool.query(`
    SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_has_role($1, c.relowner, 'USAGE')
    ORDER BY c.relname
  `, [role])).rows.map((row) => row.table_name);
  return { writable: writable.sort(), unreadable: unreadable.sort(), canCreate, owns };
}

async function attempt(client, sql) {
  await client.query("SAVEPOINT gavel_permission_probe");
  try {
    await client.query(sql);
    return { allowed: true, code: null };
  } catch (error) {
    // Only "insufficient privilege" proves the statement was refused. Anything
    // else -- a NOT NULL violation, a foreign key, a check constraint -- means
    // the permission check passed and the role does hold the privilege.
    return { allowed: error.code !== INSUFFICIENT_PRIVILEGE, code: error.code || null };
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT gavel_permission_probe");
    await client.query("RELEASE SAVEPOINT gavel_permission_probe");
  }
}

// Executes real statements as the target role inside a transaction that is
// always rolled back. Nothing observed here is inferred from a GRANT.
//
// The only trace a probe can leave is a consumed sequence value, and only for a
// role that was already allowed to insert. No row, column, or table survives.
async function probeEffectivePermissions(pool, role, tables, columns) {
  const client = await pool.connect();
  const probeTable = `gavel_permission_probe_${Date.now().toString(36)}`;
  try {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`);
    } catch (error) {
      return { available: false, reason: redactErrorMessage(error) };
    }
    const allowed = [];
    const unreadable = [];
    for (const table of tables) {
      const ident = `public.${quoteIdent(table)}`;
      const select = await attempt(client, `SELECT 1 FROM ${ident} LIMIT 1`);
      if (!select.allowed) unreadable.push(table);

      const column = columns.get(table);
      const writes = [["INSERT", `INSERT INTO ${ident} DEFAULT VALUES`], ["DELETE", `DELETE FROM ${ident} WHERE false`]];
      if (column) writes.push(["UPDATE", `UPDATE ${ident} SET ${quoteIdent(column)}=${quoteIdent(column)} WHERE false`]);
      for (const [privilege, sql] of writes) {
        const outcome = await attempt(client, sql);
        if (outcome.allowed) allowed.push(`${table}:${privilege}`);
      }
    }
    const created = await attempt(client, `CREATE TABLE public.${quoteIdent(probeTable)} (probe integer)`);
    if (created.allowed) allowed.push("schema public:CREATE");
    return {
      available: true,
      read: unreadable.length === 0,
      write: allowed.some((entry) => !entry.endsWith(":CREATE")),
      ddl: created.allowed === true,
      unreadable: unreadable.sort(),
      allowed: allowed.sort(),
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

// Answers one question: is `role` constrained the way the deployment claims?
// `expect: "read-only"` is the gavel_api gate; `expect: "read-write"` confirms
// gavel_indexer kept the grants it needs.
async function verifyPermissions(pool, role = "gavel_api", options = {}) {
  assertRoleName(role);
  const expect = options.expect || "read-only";
  if (!EXPECTATIONS.includes(expect)) throw new TypeError(`expect must be one of ${EXPECTATIONS.join(", ")}`);
  const allowCatalogFallback = options.allowCatalogFallback === true;

  const tables = await publicTables(pool);
  if (!tables.length) throw new Error("no public tables found; run migrate first");
  const attributes = await roleAttributes(pool, role);
  if (!attributes) throw new Error(`role ${role} does not exist`);

  const columns = await firstColumns(pool);
  const catalog = await catalogPrivileges(pool, role, tables);
  const probe = await probeEffectivePermissions(pool, role, tables, columns);

  const read = probe.available ? probe.read && catalog.unreadable.length === 0 : catalog.unreadable.length === 0;
  const write = (probe.available && probe.write) || catalog.writable.length > 0;
  const ddl = (probe.available && probe.ddl) || catalog.canCreate || catalog.owns.length > 0
    || attributes.superuser === true || attributes.createrole === true;
  const writable = [...new Set([...catalog.writable, ...(probe.allowed || [])])].sort();
  const unreadable = [...new Set([...catalog.unreadable, ...(probe.unreadable || [])])].sort();

  const violations = [];
  // A catalog-only answer is an unproven answer. The gate says so instead of
  // reporting a pass it did not actually demonstrate.
  if (!probe.available && !allowCatalogFallback) {
    violations.push(`effective verification unavailable (SET ROLE ${role} was refused): ${probe.reason}`);
  }
  if (!read) violations.push(`role cannot SELECT: ${unreadable.join(", ")}`);
  if (expect === "read-only") {
    if (write) violations.push(`role holds write privileges: ${writable.filter((entry) => !entry.endsWith(":CREATE")).join(", ")}`);
    if (ddl) violations.push("role holds DDL privileges (CREATE on schema public, table ownership, or a role attribute)");
    if (attributes.superuser) violations.push("role is a superuser");
  } else if (!write) {
    violations.push("role holds no write privileges but is expected to write");
  }

  return {
    ok: violations.length === 0,
    role,
    expect,
    // "effective" means every result below was produced by running the
    // statement as the role. "catalog" means SET ROLE was unavailable to the
    // verifying connection and only privilege lookups were possible.
    method: probe.available ? "effective" : "catalog",
    tables: tables.length,
    read,
    write,
    ddl,
    writable,
    unreadable,
    attributes,
    violations,
    ...(probe.available ? {} : { degraded: probe.reason }),
  };
}

// The migration-time audit tolerates a catalog-only answer -- migrate may run
// from a connection that cannot SET ROLE -- but always reports which method
// produced it, so an unproven pass is visible rather than implied.
async function auditRoles(pool) {
  const options = { allowCatalogFallback: true };
  const api = await verifyPermissions(pool, "gavel_api", { ...options, expect: "read-only" });
  const indexer = await verifyPermissions(pool, "gavel_indexer", { ...options, expect: "read-write" });
  const summarize = ({ ok, method, read, write, ddl }) => ({ ok, method, read, write, ddl });
  return {
    ok: api.ok && indexer.ok,
    summary: { gavel_api: summarize(api), gavel_indexer: summarize(indexer) },
    violations: [
      ...api.violations.map((violation) => `gavel_api: ${violation}`),
      ...indexer.violations.map((violation) => `gavel_indexer: ${violation}`),
    ],
  };
}

module.exports = {
  APPLICATION_ROLES,
  ROLE_PASSWORD_VARIABLES,
  WRITE_PRIVILEGES,
  assertRoleName,
  auditRoles,
  ensureRoles,
  presentRoles,
  verifyPermissions,
};
