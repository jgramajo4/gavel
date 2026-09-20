# Gate environment isolation

Staging and production must not share a Gate database.

`gate.profiles` has no environment or deployment column, and `wallet` is
UNIQUE. Directory reads filter on DAO and availability only. Splitter
deployment rows *are* environment-labeled, but profile/directory state is
not. One database therefore lets staging and production:

- publish each other's enrollments in the public directory;
- overwrite the same wallet's attention price and accepted stages;
- leak availability / accepting state across environments.

Do **not** fix this by adding `environment` to `gate.profiles`. One database
per environment is a load-bearing assumption of the schema.

Do **not** delete foreign rows from `gate.splitter_deployments`. Those records
are immutable and may be referenced by settlement history.

## Expected identity

| | Production | Staging |
| --- | --- | --- |
| Environment name | exactly `production` | exactly `test` |
| Settlement chain | Base `8453` | Base Sepolia `84532` |
| Token | canonical Base native USDC | the labeled test token |
| Splitter | this process's `GAVEL_GATE_SPLITTER` | this process's `GAVEL_GATE_SPLITTER` |
| Database | a production-only Postgres database | a **different** staging-only Postgres database |
| API | `https://api-mainnet.0773h.com` | the staging Gate origin |

Database names are operator-chosen. Example pair:

```text
GAVEL_GATE_DATABASE_URL=postgres://gavel_gate:***@postgres:5432/gavel_gate_production
```

```text
GAVEL_GATE_DATABASE_URL=postgres://gavel_gate:***@postgres:5432/gavel_gate_staging
```

The names do not matter. Distinct cluster/database/volume identity does.
Never point two environments at the same `GAVEL_GATE_DATABASE_URL`.

## Isolation enforcement

`GAVEL_GATE_ENFORCE_ENVIRONMENT_ISOLATION` is exactly `disabled` or `enforced`.
Unset or empty means `disabled`, so deploying this code against a still-shared
database does not brick production.

When `enforced`, startup reads `gate.splitter_deployments` and refuses to boot
if the database holds:

- another environment;
- another settlement chain;
- an unlabeled deployment;
- no row for this process's splitter (once any deployments exist);
- an `issuance_active` row for a different splitter.

Same-environment splitter rotation is allowed. The guard only `SELECT`s. It
never mutates deployment or profile rows.

## Deployment order

Do this in order. Do not skip ahead to enforcement.

1. **Create/split databases.** Provision a production-only database and a
   staging-only database. Fresh cluster or `CREATE DATABASE` on the same
   cluster is fine; sharing one database is not.
2. **Migrate/copy legitimate state.** Run `packages/server/migrations/001_gate.sql`
   on each new database. Copy only the environment's own splitter deployments,
   cursors, quotes, profiles, and related rows. Do not copy the other
   environment's deployment identity. Do not delete source `splitter_deployments`
   rows as a substitute for the split.
3. **Verify production data.** Run the diagnostics below against the
   production-only database before switching traffic.
4. **Switch services.** Point production `GAVEL_GATE_DATABASE_URL` at the
   production-only database and staging at the staging-only database. Restart
   with `GAVEL_GATE_ENFORCE_ENVIRONMENT_ISOLATION=disabled`.
5. **Then enable fail-closed enforcement.** After both services are healthy on
   the split databases, set `GAVEL_GATE_ENFORCE_ENVIRONMENT_ISOLATION=enforced`
   and restart. A mixed database will now refuse to start.

## Verify before deployment

Read-only. Run against the database a process is about to use.

```sql
SELECT config->>'environment' AS environment,
       chain_id::text AS chain_id,
       splitter,
       issuance_active
FROM gate.splitter_deployments
ORDER BY 1, 2, 3;
```

Production must return only `production` / `8453` rows, including this
process's splitter. Staging must return only `test` / `84532` rows.

```sql
SELECT count(*) FILTER (WHERE config->>'environment' IS DISTINCT FROM 'production')
  AS foreign_to_production,
       count(*) FILTER (WHERE chain_id <> 8453)
  AS non_base_mainnet
FROM gate.splitter_deployments;
```

Both counts must be `0` on the production database before enabling
`enforced`.

After the switch, confirm the API origin, `GAVEL_GATE_ENVIRONMENT`,
`GAVEL_GATE_BASE_CHAIN_ID`, and `GAVEL_GATE_SPLITTER` on the process match
the rows above.

## Profile cleanup after the split

See `GAVEL_GATE_DIRECTORY_CLEANUP.md`. Cleanup is voter-owned. There is no
operator delete path.
