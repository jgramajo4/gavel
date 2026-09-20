# Why a test Gate can appear in the production directory

## The finding

Gate profiles are **not scoped by deployment or environment**, so a database
shared between staging and production publishes each environment's Gates in the
other's public directory.

Three facts, each verifiable in this repository:

1. `gate.profiles` (`packages/server/migrations/001_gate.sql`) has columns
   `id, wallet, wallet_kind, availability, profile_version, enrolled_at,
   updated_at, base_payout_verified_at, base_payout_code_hash, display_cache`.
   None of them names an environment, a deployment, or a settlement chain.
   `gate.dao_policies.chain_id` is the **DAO governance chain** — constrained to
   `1` for Nouns — not the Base settlement chain.

2. The directory read (`PostgresGateStore#listProfiles`) filters on DAO and
   availability alone:

   ```sql
   FROM gate.profiles p LEFT JOIN gate.dao_policies d ON d.profile_id=p.id
   WHERE ($1::text IS NULL OR d.dao=$1) AND ($2::gate.availability IS NULL OR p.availability=$2)
   ```

   There is no join to `gate.splitter_deployments` anywhere in the profile or
   directory path. `createProfileService({ baseChainId })` carries the chain but
   never filters on it.

3. `gate.splitter_deployments` will hold a production (`8453`) row and a test
   (`84532`) row side by side without complaint. `configureDeployment` keys on
   the deployment's own immutable identity; nothing rejects a foreign one.

`gate.profiles.wallet` is additionally `UNIQUE`. So two environments sharing a
database do not merely *see* each other's Gates — they share **one mutable row
per wallet**, and the later enrollment silently overwrites the earlier one,
including its attention price and accepted stages.

### Enrollment carries no environment evidence

For an **EOA**, enrollment never touches Base at all. The `GateEnrollment`
typed data is signed on `daoChainId: "1"`, and `basePayoutProofRequired` in
`profile-service.js` is true only for a **contract** wallet on a first
enrollment or a return to `accepting_now`. `GAVEL_GATE_API_AUDIENCE` — the one
per-deployment discriminator that is actually verified — is bound to the auth
*nonce and session*, both ephemeral, and is discarded before the profile row is
written.

An EOA profile row is therefore byte-identical whether it was created against
staging or production.

## Reproduction

Against the real migration and the real store SQL, with one database holding
both deployments:

```
deployments sharing this database:
  { id: 'deployment-prod',    chain: '8453',  env: 'production' }
  { id: 'deployment-staging', chain: '84532', env: 'test' }

columns that scope a profile to a deployment/environment: NONE

production directory (baseChainId 8453) returns:
   0xeeee…eeee [accepting]          <- enrolled against staging
   0xc180…5425 [accepting]          <- the real Safe
```

## Which case is this deployment in?

Run these against the **production** Gate database. All four are read-only.

```sql
-- 1. DECISIVE. More than one distinct environment means the database is shared.
SELECT config->>'environment' AS environment, chain_id::text, splitter, id, issuance_active
FROM gate.splitter_deployments ORDER BY 1,2;

-- 2. Distinct API audiences that have used this database. More than one means
--    more than one API deployment wrote here. Sessions expire, so an empty or
--    single-valued result is weak evidence, not proof of isolation.
SELECT audience, count(*) AS sessions FROM gate.auth_sessions GROUP BY 1 ORDER BY 1;

-- 3. Durable transaction evidence: which environment actually issued quotes.
SELECT d.config->>'environment' AS environment, q.base_chain_id::text, count(*) AS quotes
FROM gate.quotes q JOIN gate.splitter_deployments d ON d.id = q.deployment_id
GROUP BY 1,2 ORDER BY 1,2;

-- 4. Every enrolled profile, with what little provenance exists.
SELECT p.wallet, p.wallet_kind, p.availability, p.enrolled_at, p.updated_at,
       (p.base_payout_verified_at IS NOT NULL) AS base_payout_verified,
       d.attention_amount::text, d.accept_pre_vote, d.accept_voting
FROM gate.profiles p LEFT JOIN gate.dao_policies d ON d.profile_id = p.id AND d.dao = 'nouns'
ORDER BY p.enrolled_at;
```

Reading the result:

- **Query 1 returns one environment** → the databases are already separate and
  the test Gates are genuine production test data, enrolled against production
  on purpose. Remove them with the per-wallet `closed` procedure in
  `GAVEL_GATE_DIRECTORY_CLEANUP.md`. Do **not** add an operator deletion
  capability for this.
- **Query 1 returns both `production` and `test`** → staging and production
  share a database. That is the bug below, and cleanup alone will not hold:
  staging can re-publish into production at any time.
- **Query 3 shows quotes against a `test` deployment** in the production
  database → staging has transacted here, whatever query 1 says today.

Note for query 4: `base_payout_verified` is only ever set for a **contract**
wallet, and the chain it was verified against is not persisted. It does not
identify the environment. An EOA row carries no provenance at all.

## The fix

`assertEnvironmentIsolation` in `packages/server/bin/gavel-server.js` refuses to
start a Gate API whose database holds a deployment from another environment,
before the API can serve a directory:

```
Gate database is shared with another environment: this process is
production/8453 but the database also holds test/84532. Gate profiles are not
scoped by environment, so these deployments would publish each other's Gates in
the public directory and overwrite each other's enrollments. Give each
environment its own database before starting.
```

This is the smallest change that isolates production, because one database per
environment is already a load-bearing assumption of the schema — `wallet` is
UNIQUE with no environment dimension — rather than a deployment preference.
Nothing enforced it; now something does.

Splitter rotation is unaffected. Several deployments may coexist, which
`GAVEL_GATE_EXPERIMENTAL.md` requires while an old splitter drains; only a
*foreign environment* is refused. Environment and chain are already 1:1
(`settlementRuntimeConfigFromEnv` pins production to `8453` and test to
`84532`), and both are checked so the refusal can name what it found.

**Ownership and authentication semantics are unchanged.** The guard issues one
`SELECT` and decides whether to boot. Who may write a profile is still the
`dao_profile` session wallet presenting a matching `GateEnrollment` signature,
and no read path, proof, or session rule is touched.

### Deployment order matters

The guard **fails closed**. If production and staging share a database today,
deploying it will stop production from starting. Sequence it:

1. Run query 1 above.
2. If one environment, deploy — the guard is a no-op that keeps it that way.
3. If two, give staging its own database **first**: point staging's
   `GAVEL_GATE_DATABASE_URL` at a fresh database, run the migration there, and
   re-run its deployment configuration. Only then deploy the guard.

Do not resolve a shared database by deleting the foreign deployment row —
`gate.protect_splitter_deployment_identity` makes deployments immutable, and
the settlement history that references them must not be orphaned.

### Rejected alternative

Scoping profiles by an `environment` (or `audience`) column would isolate reads
inside a shared database, but `gate.profiles.wallet` is UNIQUE and
`profileId = sessionWallet`, so it would have to become `UNIQUE (wallet,
environment)` — changing the identity of a profile and therefore the ownership
model. That is a larger and riskier change than separating the databases, and
it would legitimize a configuration the rest of the schema does not support.

## Not to be touched

`0xC18017a8A8a1Ec36966faA823A135ff51A5F5425` is the real Safe enrollment.
Nothing in this document deletes or mutates it: the guard only reads, and the
cleanup procedure is per-wallet and opt-in.
