#!/bin/sh
set -eu

: "${GAVEL_GATE_DB_PASSWORD:?GAVEL_GATE_DB_PASSWORD is required}"

# This numbered fresh-volume initializer owns only the Gate role. The governance
# initializer owns index/api roles, avoiding duplicate or conflicting creation.
# The password is read by psql from its environment and never appears in argv.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\set QUIET on
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
\getenv gate_password GAVEL_GATE_DB_PASSWORD
SELECT format('CREATE ROLE gavel_gate LOGIN PASSWORD %L', :'gate_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gavel_gate') \gexec
ALTER ROLE gavel_gate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION;
SELECT format('REVOKE %I FROM gavel_gate', parent.rolname)
FROM pg_auth_members membership
JOIN pg_roles member ON member.oid = membership.member
JOIN pg_roles parent ON parent.oid = membership.roleid
WHERE member.rolname = 'gavel_gate' \gexec
GRANT CONNECT ON DATABASE gavel TO gavel_gate;
SQL
