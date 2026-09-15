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
const GATE_ROLES = ["gavel_gate"];
const PROVISIONED_ROLES = [...APPLICATION_ROLES, ...GATE_ROLES];
const ROLE_PASSWORD_VARIABLES = {
  gavel_indexer: "GAVEL_INDEXER_DB_PASSWORD",
  gavel_api: "GAVEL_API_DB_PASSWORD",
  gavel_gate: "GAVEL_GATE_DB_PASSWORD",
};
// TRUNCATE, REFERENCES and TRIGGER are write-adjacent: none of them belong to a
// read-only reporting role, and REFERENCES/TRIGGER are privilege-escalation
// paths onto tables the role cannot otherwise modify.
const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const PROBE_PRIVILEGES = ["SELECT", ...WRITE_PRIVILEGES];
const EXPECTATIONS = ["read-only", "read-write"];
const INSUFFICIENT_PRIVILEGE = "42501";
const UNQUOTED_IDENTIFIER = /^[a-z_][a-z0-9_$]{0,62}$/;

const freezePrivileges = (privileges) => Object.freeze([...privileges]);
const GATE_TABLE_PRIVILEGES = Object.freeze({
  auth_nonces: freezePrivileges(["SELECT"]),
  auth_sessions: freezePrivileges(["SELECT"]),
  capacity_reservations: freezePrivileges(["SELECT", "INSERT", "UPDATE"]),
  dao_policies: freezePrivileges(["SELECT"]),
  delivery_settings: freezePrivileges(["SELECT"]),
  inbox_items: freezePrivileges(["SELECT", "INSERT", "UPDATE"]),
  notification_attempts: freezePrivileges(["SELECT", "INSERT"]),
  profile_version_authorizations: freezePrivileges([]),
  profiles: freezePrivileges(["SELECT"]),
  proposal_snapshots: freezePrivileges(["SELECT", "INSERT"]),
  quotes: freezePrivileges(["SELECT", "INSERT", "UPDATE"]),
  rate_limit_events: freezePrivileges(["SELECT"]),
  sender_blocks: freezePrivileges(["SELECT"]),
  settlement_cursors: freezePrivileges(["SELECT", "INSERT", "UPDATE"]),
  // Scanner evidence is append-only and may be written only through the
  // SECURITY DEFINER range recorder. Direct table access would bypass its
  // atomic continuity, replay, and canonical-generation checks.
  settlement_scan_blocks: freezePrivileges([]),
  settlement_scan_observations: freezePrivileges([]),
  settlement_scan_ranges: freezePrivileges([]),
  settlement_reorg_monitors: freezePrivileges(["SELECT", "INSERT", "UPDATE"]),
  splitter_deployments: freezePrivileges(["SELECT", "INSERT", "UPDATE"]),
  submissions: freezePrivileges(["SELECT", "INSERT", "UPDATE"]),
});
const GATE_REQUIRED_FUNCTIONS = Object.freeze([
  "gate.insert_auth_nonce(gate.auth_proof_type,gate.auth_purpose,gate.auth_role,text,text,bigint,text,text,text,bigint,bigint)",
  "gate.consume_auth_nonce(text,bigint)",
  "gate.insert_auth_session(text,text,gate.auth_role,bigint,text,bigint,bigint)",
  "gate.mutate_profile(text,text,text,gate.availability,jsonb,boolean,timestamp with time zone,boolean,text,boolean,jsonb)",
  "gate.transition_notification(text,gate.notification_state,text,text)",
  "gate.record_scanner_range(text,bigint,bigint,text,timestamp with time zone,jsonb)",
  "gate.release_expired_reservation(text,text)",
]);

function assertRoleName(role) {
  if (typeof role !== "string" || !UNQUOTED_IDENTIFIER.test(role)) {
    throw new TypeError("role must be a lower-case unquoted PostgreSQL identifier");
  }
  return role;
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function presentRoles(pool, roles = PROVISIONED_ROLES) {
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
  wanted.forEach(assertRoleName);
  const existing = await presentRoles(pool, wanted);
  const missing = wanted.filter((role) => !existing.includes(role));

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

  // Passwords are deliberately required for existing roles too. Reused
  // volumes must rotate credentials and attributes rather than trusting a role
  // merely because its name already exists.
  const unset = wanted.filter((role) => !ROLE_PASSWORD_VARIABLES[role] || !env[ROLE_PASSWORD_VARIABLES[role]]);
  if (unset.length) {
    return {
      state: "skipped",
      created: [],
      missing,
      reason: `no password supplied for ${unset.join(", ")}; set ${unset.map((role) => ROLE_PASSWORD_VARIABLES[role]).join(" and ")} on the migration environment and re-run migrate`,
    };
  }

  const ownership = (await pool.query(`
    WITH wanted(role) AS (SELECT unnest($1::text[]))
    SELECT w.role, 'database' AS object_type, d.datname AS owned
      FROM wanted w JOIN pg_roles r ON r.rolname=w.role JOIN pg_database d ON d.datdba=r.oid
    UNION ALL
    SELECT w.role, 'schema', n.nspname
      FROM wanted w JOIN pg_roles r ON r.rolname=w.role JOIN pg_namespace n ON n.nspowner=r.oid
      WHERE n.nspname !~ '^pg_(temp|toast_temp)_'
    UNION ALL
    SELECT w.role, CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END,
           format('%I.%I', n.nspname, c.relname)
      FROM wanted w JOIN pg_roles r ON r.rolname=w.role JOIN pg_class c ON c.relowner=r.oid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_(temp|toast_temp)_'
  `, [existing])).rows;
  if (ownership.length) {
    const details = ownership.map((row) => `${row.role} owns ${row.object_type} ${row.owned}`).join(", ");
    throw new Error(`refusing to reconcile application role ownership: ${details}; transfer or drop the owned objects first`);
  }

  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  try {
    await client.query("BEGIN");
    // Prevent PostgreSQL from including bind parameter values in an error log.
    // The role password otherwise remains a protocol parameter from Node all
    // the way into this server-side function; no secret-bearing SQL text is
    // returned to or executed by the client.
    await client.query("SET LOCAL log_parameter_max_length_on_error = 0");
    await client.query(`
      CREATE OR REPLACE FUNCTION pg_temp.gavel_reconcile_role(p_role_name text, p_role_password text)
      RETURNS integer LANGUAGE plpgsql AS $fn$
      DECLARE parent_name text; revoked integer := 0;
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=p_role_name) THEN
          EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L', p_role_name, p_role_password);
        ELSE
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION PASSWORD %L', p_role_name, p_role_password);
        END IF;
        FOR parent_name IN
          SELECT parent.rolname FROM pg_auth_members member
          JOIN pg_roles child ON child.oid=member.member
          JOIN pg_roles parent ON parent.oid=member.roleid
          WHERE child.rolname=p_role_name
        LOOP
          EXECUTE format('REVOKE %I FROM %I', parent_name, p_role_name);
          revoked := revoked + 1;
        END LOOP;
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), p_role_name);
        RETURN revoked;
      END $fn$
    `);
    for (const role of wanted) {
      await client.query("SELECT pg_temp.gavel_reconcile_role($1,$2) AS revoked_memberships", [
        role, env[ROLE_PASSWORD_VARIABLES[role]],
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    let message = redactErrorMessage(error);
    for (const role of wanted) message = message.split(String(env[ROLE_PASSWORD_VARIABLES[role]])).join("[redacted]");
    throw new Error(`failed to reconcile roles: ${message}`);
  } finally {
    if (client !== pool && typeof client.release === "function") client.release();
  }
  return {
    state: existing.length ? "reconciled" : "created",
    created: missing,
    reconciled: existing,
    missing: [],
  };
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
    SELECT rolcanlogin AS login, rolsuper AS superuser, rolcreaterole AS createrole,
           rolcreatedb AS createdb, rolinherit AS inherit,
           rolbypassrls AS bypassrls, rolreplication AS replication
    FROM pg_roles WHERE rolname = $1
  `, [role])).rows[0] || null;
}

async function roleRisks(pool, role) {
  const memberships = (await pool.query(`
    SELECT parent.rolname AS role
    FROM pg_auth_members member
    JOIN pg_roles child ON child.oid=member.member
    JOIN pg_roles parent ON parent.oid=member.roleid
    WHERE child.rolname=$1 ORDER BY parent.rolname
  `, [role])).rows.map((row) => row.role);
  const ownership = (await pool.query(`
    SELECT 'database' AS object_type, d.datname AS owned
      FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname=$1
    UNION ALL
    SELECT 'schema', n.nspname
      FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
      WHERE r.rolname=$1 AND n.nspname !~ '^pg_(temp|toast_temp)_'
    UNION ALL
    SELECT CASE c.relkind WHEN 'S' THEN 'sequence' ELSE 'table' END,
           format('%I.%I', n.nspname,c.relname)
      FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE r.rolname=$1 AND n.nspname !~ '^pg_(temp|toast_temp)_'
  `, [role])).rows;
  return { memberships, ownership };
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
  const risks = await roleRisks(pool, role);

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
  if (attributes.login !== true) violations.push("role cannot LOGIN");
  for (const attribute of ["superuser", "createrole", "createdb", "bypassrls", "replication"]) {
    if (attributes[attribute] === true) violations.push(`role has dangerous attribute ${attribute}`);
  }
  if (risks.memberships.length) violations.push(`role is a member of: ${risks.memberships.join(", ")}`);
  if (risks.ownership.length) {
    violations.push(`role owns objects: ${risks.ownership.map((row) => `${row.object_type} ${row.owned}`).join(", ")}`);
  }
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
    memberships: risks.memberships,
    ownership: risks.ownership,
    violations,
    ...(probe.available ? {} : { degraded: probe.reason }),
  };
}

async function schemaTables(pool, schema) {
  return (await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [schema],
  )).rows.map((row) => row.tablename);
}

async function schemaSequences(pool, schema) {
  return (await pool.query(
    "SELECT sequencename FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename", [schema],
  )).rows.map((row) => row.sequencename);
}

async function gateCatalogViolations(pool, gateTables) {
  const rows = (await pool.query(`
    SELECT t.table_name, p.privilege,
      has_table_privilege('gavel_gate', format('gate.%I', t.table_name), p.privilege) AS granted
    FROM unnest($1::text[]) AS t(table_name)
    CROSS JOIN unnest($2::text[]) AS p(privilege)
  `, [gateTables, PROBE_PRIVILEGES])).rows;
  const violations = [];
  for (const row of rows) {
    const expected = GATE_TABLE_PRIVILEGES[row.table_name]?.includes(row.privilege) === true;
    if (row.granted !== expected) {
      violations.push(expected
        ? `gavel_gate lacks ${row.privilege} on gate.${row.table_name}`
        : `gavel_gate holds unexpected ${row.privilege} on gate.${row.table_name}`);
    }
  }
  const functions = (await pool.query(`
    SELECT f.signature,
      has_function_privilege('gavel_gate', f.signature, 'EXECUTE') AS granted
    FROM unnest($1::text[]) AS f(signature)
  `, [GATE_REQUIRED_FUNCTIONS])).rows;
  for (const row of functions) {
    if (row.granted !== true) violations.push(`gavel_gate lacks EXECUTE on ${row.signature}`);
  }
  return violations;
}

async function probeRoleStatements(pool, role, statements) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`);
    } catch (error) {
      return { available: false, violations: [`SET ROLE ${role} was refused: ${redactErrorMessage(error)}`] };
    }
    const violations = [];
    for (const statement of statements) {
      const outcome = await attempt(client, statement.sql);
      if (outcome.allowed !== statement.allowed) {
        violations.push(statement.allowed
          ? `${role} cannot ${statement.label}`
          : `${role} can ${statement.label}`);
      }
    }
    return { available: true, violations };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

// Gate is intentionally outside the public governance index. Migration is not
// considered healthy until real statements prove Gate has exactly the private
// operations its migration grants, cannot access public governance data, and
// neither public runtime role can access private Gate objects.
async function verifyGatePermissions(pool) {
  const gateTables = await schemaTables(pool, "gate");
  if (!gateTables.length) throw new Error("no Gate tables found; apply the Gate migration first");
  const publicRows = await schemaTables(pool, "public");
  const gateSequences = await schemaSequences(pool, "gate");
  const publicSequences = await schemaSequences(pool, "public");
  const gateColumns = await firstColumnsForSchema(pool, "gate");
  const publicColumns = await firstColumnsForSchema(pool, "public");
  const statements = [];
  for (const table of gateTables) {
    const relation = `gate.${quoteIdent(table)}`;
    const column = quoteIdent(gateColumns.get(table));
    const privileges = GATE_TABLE_PRIVILEGES[table];
    statements.push(
      { role: "gavel_gate", allowed: privileges?.includes("SELECT") === true, label: `SELECT gate.${table}`, sql: `SELECT 1 FROM ${relation} LIMIT 1` },
      { role: "gavel_gate", allowed: privileges?.includes("INSERT") === true, label: `INSERT gate.${table}`, sql: `INSERT INTO ${relation} DEFAULT VALUES` },
      { role: "gavel_gate", allowed: privileges?.includes("UPDATE") === true, label: `UPDATE gate.${table}`, sql: `UPDATE ${relation} SET ${column}=${column} WHERE false` },
      { role: "gavel_gate", allowed: false, label: `DELETE gate.${table}`, sql: `DELETE FROM ${relation} WHERE false` },
    );
    for (const role of APPLICATION_ROLES) {
      statements.push(
        { role, allowed: false, label: `access gate.${table}`, sql: `SELECT 1 FROM ${relation} LIMIT 1` },
        { role, allowed: false, label: `mutate gate.${table}`, sql: `INSERT INTO ${relation} DEFAULT VALUES` },
        { role, allowed: false, label: `mutate gate.${table}`, sql: `UPDATE ${relation} SET ${column}=${column} WHERE false` },
        { role, allowed: false, label: `mutate gate.${table}`, sql: `DELETE FROM ${relation} WHERE false` },
      );
    }
  }
  for (const sequence of gateSequences) {
    const sql = `SELECT nextval('gate.${quoteIdent(sequence)}'::regclass)`;
    statements.push({ role: "gavel_gate", allowed: true, label: `advance gate.${sequence}`, sql });
    for (const role of APPLICATION_ROLES) {
      statements.push({ role, allowed: false, label: `access gate.${sequence}`, sql });
    }
  }
  for (const table of publicRows) {
    const relation = `public.${quoteIdent(table)}`;
    const column = quoteIdent(publicColumns.get(table));
    statements.push(
      { role: "gavel_gate", allowed: false, label: `access public.${table}`, sql: `SELECT 1 FROM ${relation} LIMIT 1` },
      { role: "gavel_gate", allowed: false, label: `mutate public.${table}`, sql: `INSERT INTO ${relation} DEFAULT VALUES` },
      { role: "gavel_gate", allowed: false, label: `mutate public.${table}`, sql: `UPDATE ${relation} SET ${column}=${column} WHERE false` },
      { role: "gavel_gate", allowed: false, label: `mutate public.${table}`, sql: `DELETE FROM ${relation} WHERE false` },
    );
  }
  for (const sequence of publicSequences) {
    statements.push({
      role: "gavel_gate", allowed: false, label: `advance public.${sequence}`,
      sql: `SELECT nextval('public.${quoteIdent(sequence)}'::regclass)`,
    });
  }
  const probeTable = `gavel_gate_permission_probe_${Date.now().toString(36)}`;
  statements.push({
    role: "gavel_gate", allowed: false, label: "CREATE in public",
    sql: `CREATE TABLE public.${quoteIdent(probeTable)} (probe integer)`,
  });
  statements.push({
    role: "gavel_gate", allowed: false, label: "CREATE in gate",
    sql: `CREATE TABLE gate.${quoteIdent(probeTable)} (probe integer)`,
  });
  for (const role of APPLICATION_ROLES) {
    statements.push({
      role, allowed: false, label: "CREATE in gate",
      sql: `CREATE TABLE gate.${quoteIdent(probeTable)} (probe integer)`,
    });
  }

  const violations = [];
  const missingMatrixTables = Object.keys(GATE_TABLE_PRIVILEGES).filter((table) => !gateTables.includes(table));
  const unknownTables = gateTables.filter((table) => !Object.hasOwn(GATE_TABLE_PRIVILEGES, table));
  if (missingMatrixTables.length || unknownTables.length) {
    violations.push(`Gate table privilege matrix mismatch (missing: ${missingMatrixTables.join(", ") || "none"}; unknown: ${unknownTables.join(", ") || "none"})`);
  }
  violations.push(...await gateCatalogViolations(pool, gateTables));
  const summary = {};
  for (const role of PROVISIONED_ROLES) {
    const before = violations.length;
    const attributes = await roleAttributes(pool, role);
    if (!attributes) {
      violations.push(`${role} does not exist`);
      summary[role] = { method: "unavailable", ok: false };
      continue;
    }
    const risks = await roleRisks(pool, role);
    if (attributes.login !== true) violations.push(`${role} cannot LOGIN`);
    for (const attribute of ["superuser", "createrole", "createdb", "bypassrls", "replication"]) {
      if (attributes[attribute] === true) violations.push(`${role} has dangerous attribute ${attribute}`);
    }
    if (risks.memberships.length) violations.push(`${role} is a member of ${risks.memberships.join(", ")}`);
    if (risks.ownership.length) violations.push(`${role} owns database objects`);
    const probe = await probeRoleStatements(pool, role, statements.filter((row) => row.role === role));
    violations.push(...probe.violations);
    summary[role] = { method: probe.available ? "effective" : "unavailable", ok: violations.length === before };
  }
  const effective = Object.values(summary).every((row) => row.method === "effective");
  return { ok: violations.length === 0, method: effective ? "effective" : "unavailable", summary, violations };
}

async function firstColumnsForSchema(pool, schema) {
  const rows = (await pool.query(`
    SELECT c.relname AS table_name, a.attname AS column_name
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p') AND a.attnum=1 AND NOT a.attisdropped
  `, [schema])).rows;
  return new Map(rows.map((row) => [row.table_name, row.column_name]));
}

// The migration-time audit tolerates a catalog-only answer -- migrate may run
// from a connection that cannot SET ROLE -- but always reports which method
// produced it, so an unproven pass is visible rather than implied.
async function auditRoles(pool) {
  const options = { allowCatalogFallback: true };
  const api = await verifyPermissions(pool, "gavel_api", { ...options, expect: "read-only" });
  const indexer = await verifyPermissions(pool, "gavel_indexer", { ...options, expect: "read-write" });
  const gate = await verifyGatePermissions(pool);
  const summarize = ({ ok, method, read, write, ddl }) => ({ ok, method, read, write, ddl });
  return {
    ok: api.ok && indexer.ok && gate.ok,
    summary: { gavel_api: summarize(api), gavel_indexer: summarize(indexer), ...gate.summary },
    violations: [
      ...api.violations.map((violation) => `gavel_api: ${violation}`),
      ...indexer.violations.map((violation) => `gavel_indexer: ${violation}`),
      ...gate.violations,
    ],
  };
}

module.exports = {
  APPLICATION_ROLES,
  GATE_ROLES,
  GATE_REQUIRED_FUNCTIONS,
  GATE_TABLE_PRIVILEGES,
  PROVISIONED_ROLES,
  ROLE_PASSWORD_VARIABLES,
  WRITE_PRIVILEGES,
  assertRoleName,
  auditRoles,
  ensureRoles,
  presentRoles,
  verifyGatePermissions,
  verifyPermissions,
};
