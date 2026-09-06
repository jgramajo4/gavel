#!/bin/sh
set -eu

: "${GAVEL_INDEXER_DB_PASSWORD:?GAVEL_INDEXER_DB_PASSWORD is required}"
: "${GAVEL_API_DB_PASSWORD:?GAVEL_API_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=indexer_password="$GAVEL_INDEXER_DB_PASSWORD" \
  --set=api_password="$GAVEL_API_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE gavel_indexer LOGIN PASSWORD %L', :'indexer_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gavel_indexer') \gexec
SELECT format('CREATE ROLE gavel_api LOGIN PASSWORD %L', :'api_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gavel_api') \gexec
GRANT CONNECT ON DATABASE gavel TO gavel_indexer, gavel_api;
SQL
