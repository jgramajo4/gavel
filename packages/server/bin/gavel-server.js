#!/usr/bin/env node
"use strict";

const { Contract, Interface, JsonRpcProvider, toBeHex } = require("ethers");
const { createAuthService } = require("../src/gate/auth");
const { createInboxService } = require("../src/gate/inbox-service");
const { createNounsIndexClient } = require("../src/gate/index-client");
const { createGateObservability } = require("../src/gate/observability");
const { createProfileService } = require("../src/gate/profile-service");
const { createQuoteSignerFromEnv } = require("../src/gate/quote-signer");
const { createGateServerRuntime, settlementRuntimeConfigFromEnv } = require("../src/gate/runtime");
const { PostgresGateStore, createPublicGateReader } = require("../src/gate/store");
const { createSubmissionService } = require("../src/gate/submission-service");
const { readBoundedText } = require("../src/gate/bounded-response");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NOUNS_TOKEN = "0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03";
const ERC1271 = new Interface(["function isValidSignature(bytes32 digest,bytes signature) view returns (bytes4)"]);
const NOUNS_VOTES = ["function getCurrentVotes(address account) view returns (uint96)"];

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  return value;
}
function address(env, name) {
  const value = required(env, name);
  if (!ADDRESS.test(value)) throw new TypeError(`${name} must be an Ethereum address`);
  return value.toLowerCase();
}
function origin(env, name) {
  let parsed;
  try { parsed = new URL(required(env, name)); } catch { throw new TypeError(`${name} must be an HTTP(S) origin`); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

function corsOriginsFromEnv(env = process.env) {
  const raw = env.GAVEL_GATE_CORS_ORIGINS;
  if (raw === undefined || raw === "") return Object.freeze([]);
  return Object.freeze(raw.split(",").map((value) => value.trim()).filter((value) => value !== "")
    .map((value) => {
      let parsed;
      try { parsed = new URL(value); } catch { throw new TypeError("GAVEL_GATE_CORS_ORIGINS must contain exact HTTPS origins"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password
          || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) {
        throw new TypeError("GAVEL_GATE_CORS_ORIGINS must contain exact HTTPS origins without credentials, path, query, or fragment");
      }
      return parsed.origin;
    }));
}
function integer(value, name, fallback, minimum = 1, maximum = 65_535) {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function serverConfigFromEnv(env = process.env) {
  const settlement = settlementRuntimeConfigFromEnv(env);
  if (!settlement) throw new TypeError("complete Gate settlement configuration is required");
  required(env, "GAVEL_GATE_DATABASE_URL");
  required(env, "GAVEL_GATE_BASE_RPC_URL");
  required(env, "GAVEL_GATE_ETHEREUM_RPC_URL");
  required(env, "GAVEL_GATE_QUOTE_SIGNER");

  const audience = required(env, "GAVEL_GATE_API_AUDIENCE");
  if (audience.length > 256) throw new TypeError("GAVEL_GATE_API_AUDIENCE is too long");
  const corsOrigins = corsOriginsFromEnv(env);
  return Object.freeze({
    settlement,
    databaseUrl: env.GAVEL_GATE_DATABASE_URL,
    baseRpcUrl: env.GAVEL_GATE_BASE_RPC_URL,
    ethereumRpcUrl: env.GAVEL_GATE_ETHEREUM_RPC_URL,
    indexUrl: origin(env, "GAVEL_GATE_INDEX_URL"),
    audience,
    corsOrigins,
    baseVerifier: address(env, "GAVEL_GATE_BASE_VERIFIER"),
    daoVerifier: address(env, "GAVEL_GATE_DAO_VERIFIER"),
    freshnessMs: integer(env.GAVEL_GATE_NOUNS_FRESHNESS_SECONDS, "GAVEL_GATE_NOUNS_FRESHNESS_SECONDS", 900, 1, 86_400) * 1_000,
    host: env.GAVEL_GATE_HOST || "0.0.0.0",
    port: integer(env.GAVEL_GATE_PORT, "GAVEL_GATE_PORT", 8080, 0),
  });
}

async function assertDatabaseReady(pool) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("database pool is required");
  const row = (await pool.query(`SELECT current_user AS "currentUser",
    m."migrationVersion",m."migrationChecksum",m."manifestMatches",
    r.rolsuper AS "isSuperuser",r.rolcreatedb AS "canCreateDb",r.rolcreaterole AS "canCreateRole",
    r.rolbypassrls AS "bypassRls",r.rolreplication AS "canReplicate",r.rolinherit AS "inheritsRoles",
    (SELECT count(*)::text FROM pg_auth_members am WHERE am.member=r.oid) AS "membershipCount",
    (SELECT count(*)::text FROM (
      SELECT d.oid FROM pg_database d WHERE d.datdba=r.oid
      UNION ALL SELECT n.oid FROM pg_namespace n WHERE n.nspowner=r.oid AND n.nspname !~ '^pg_(temp|toast_temp)_'
      UNION ALL SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relowner=r.oid AND n.nspname !~ '^pg_(temp|toast_temp)_'
      UNION ALL SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE p.proowner=r.oid AND n.nspname !~ '^pg_(temp|toast_temp)_'
    ) owned) AS "ownershipCount",
    has_schema_privilege(current_user,'gate','USAGE') AS "hasGateUsage",a."missingPrivileges"
    FROM pg_roles r CROSS JOIN gate.runtime_migration_status() m
    CROSS JOIN LATERAL (SELECT COALESCE(array_agg(p.requirement ORDER BY p.requirement)
      FILTER (WHERE NOT p.granted),ARRAY[]::text[]) AS "missingPrivileges"
      FROM gate.runtime_privilege_audit() p) a WHERE r.rolname=current_user`)).rows[0];
  if (!row || row.currentUser !== "gavel_gate" || row.isSuperuser || row.canCreateDb || row.canCreateRole
      || row.bypassRls || row.canReplicate || row.inheritsRoles || row.membershipCount !== "0"
      || row.ownershipCount !== "0" || row.hasGateUsage !== true) {
    throw new Error("Gate database must use the least-privilege gavel_gate role");
  }
  if (row.migrationVersion !== "gate/001_gate-v3"
      || row.migrationChecksum !== "sha256:gate-001-v4-runtime-privilege-audit"
      || row.manifestMatches !== true) {
    throw new Error("Gate database migration is missing or invalid");
  }
  if (!Array.isArray(row.missingPrivileges) || row.missingPrivileges.length > 0) {
    throw new Error(`Gate database runtime privilege audit failed: ${(row.missingPrivileges || []).join(",")}`);
  }
  return Object.freeze({ role: row.currentUser, migration: "gate/001_gate-v3" });
}

/**
 * Refuses a Gate database that is shared with another environment.
 *
 * `gate.profiles` carries no environment, deployment, or settlement-chain
 * column, and the directory read filters on DAO and availability alone:
 *
 *   FROM gate.profiles p LEFT JOIN gate.dao_policies d ON d.profile_id=p.id
 *   WHERE (d.dao=$1) AND (p.availability=$2)
 *
 * So every enrollment in a database is visible to every API process pointed at
 * it, whatever chain or environment that process is configured for. `wallet` is
 * additionally UNIQUE, so two environments do not merely see each other's
 * Gates — they share one mutable row per wallet, and the later enrollment wins.
 *
 * One database per environment is therefore a load-bearing assumption of the
 * schema rather than a deployment preference, and nothing enforced it. This
 * does, at startup, before the API can serve a directory.
 *
 * Splitter rotation is untouched: several deployments may coexist, and the
 * experimental rotation runbook requires exactly that while the old splitter
 * drains. What is refused is a *foreign* one — production and test sharing a
 * database. Environment and chain are already 1:1 (`settlementRuntimeConfigFromEnv`
 * pins production to 8453 and test to 84532), and both are checked so the
 * refusal can name what it found.
 *
 * This changes no ownership or authentication semantics: it reads one table and
 * decides whether to boot. Who may write a profile is still the `dao_profile`
 * session wallet with a matching `GateEnrollment` signature, unchanged.
 */
async function assertEnvironmentIsolation(pool, settlement) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("database pool is required");
  const environment = settlement?.environment;
  const chainId = String(settlement?.chainId ?? "");
  if (!environment || !chainId) throw new TypeError("settlement environment and chain are required");

  const rows = (await pool.query(`SELECT DISTINCT config->>'environment' AS environment,chain_id::text AS "chainId"
    FROM gate.splitter_deployments ORDER BY 1,2`)).rows;
  const foreign = rows.filter((row) => row.environment !== environment || row.chainId !== chainId);
  if (foreign.length === 0) return Object.freeze({ environment, chainId, deployments: rows.length });

  // Deployment environments and chain IDs are configuration, not secrets, so
  // naming them is what makes this failure fixable instead of mysterious.
  const found = foreign.map((row) => `${row.environment ?? "unlabeled"}/${row.chainId}`).join(", ");
  throw new Error(`Gate database is shared with another environment: this process is ${environment}/${chainId} `
    + `but the database also holds ${found}. Gate profiles are not scoped by environment, so these deployments `
    + "would publish each other's Gates in the public directory and overwrite each other's enrollments. "
    + "Give each environment its own database before starting.");
}

async function fetchJson(fetchImpl, url, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (response.status !== 200) throw new Error("canonical index unavailable");
    const text = await readBoundedText(response, 2 * 1024 * 1024, "canonical index response too large");
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canonical index response invalid");
    return value;
  } catch { throw new Error("canonical index unavailable"); }
  finally { clearTimeout(timer); }
}

function createCanonicalIndexSource({ baseUrl, ethereumProvider, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const originValue = new URL(baseUrl).origin;
  const token = new Contract(NOUNS_TOKEN, NOUNS_VOTES, ethereumProvider);
  return Object.freeze({
    async getHealth(dao) {
      if (dao !== "nouns") throw new Error("unsupported DAO");
      const body = await fetchJson(fetchImpl, `${originValue}/v1/daos/nouns/sync-status`);
      const sources = Array.isArray(body.sources) ? body.sources : [];
      const timestamps = sources.map((row) => ({ value: row.updatedAt, epoch: Date.parse(row.updatedAt) }));
      const allTimestampsValid = timestamps.every(({ epoch }) => Number.isFinite(epoch));
      const refreshedAt = allTimestampsValid
        ? timestamps.reduce((oldest, candidate) => candidate.epoch < oldest.epoch ? candidate : oldest).value
        : null;
      const failed = sources.length === 0 || !allTimestampsValid || sources.some((row) => row.lastError);
      return { healthy: !failed, refreshedAt: refreshedAt || "invalid", lastError: failed ? "sync_failed" : null };
    },
    async getProposal(dao, proposalId) {
      if (dao !== "nouns") throw new Error("unsupported DAO");
      const proposal = await fetchJson(fetchImpl, `${originValue}/v1/gate/daos/nouns/proposals/${encodeURIComponent(proposalId)}`);
      return { dao: "nouns", ...proposal };
    },
    async getTarget(dao, targetId) {
      if (dao !== "nouns") throw new Error("unsupported DAO");
      const target = await fetchJson(fetchImpl, `${originValue}/v1/gate/daos/nouns/targets/${encodeURIComponent(targetId)}`);
      return { dao: "nouns", ...target };
    },
    async getVotingPower(dao, wallet) {
      if (dao !== "nouns") throw new Error("unsupported DAO");
      const [amount, block] = await Promise.all([token.getCurrentVotes(wallet), ethereumProvider.getBlock("latest")]);
      if (!block?.hash || !Number.isSafeInteger(Number(block.number))) throw new Error("Ethereum RPC unavailable");
      return { dao, wallet: wallet.toLowerCase(), amount: String(amount), asOf: new Date(Number(block.timestamp) * 1000).toISOString(),
        sourceBlock: String(block.number), sourceBlockHash: block.hash };
    },
  });
}

function createRpcClient(url, chainId, providerOverride) {
  const provider = providerOverride || new JsonRpcProvider(url, Number(chainId), { staticNetwork: true });
  return Object.freeze({
    provider,
    getChainId: async () => BigInt(await provider.send("eth_chainId", [])).toString(),
    getBlockNumber: () => provider.getBlockNumber(),
    getBlock: (number) => provider.getBlock(number),
    getBlockTransactionCount: (number) => provider.send("eth_getBlockTransactionCountByNumber", [toBeHex(number)]),
    getBlockReceipts: (number) => provider.send("eth_getBlockReceipts", [toBeHex(number)]),
    getTransactionReceipt: (hash) => provider.getTransactionReceipt(hash),
    getTransaction: (hash) => provider.getTransaction(hash),
    getCode: (target) => provider.getCode(target),
    call: (transaction) => provider.call(transaction),
  });
}

async function bounded(read, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("dependency timeout")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function contractVerifier(client) {
  return async ({ wallet, digest, signature }) => {
    const code = await client.getCode(wallet);
    if (code === "0x") return { code, magicValue: "0x" };
    const result = await client.call({ to: wallet, data: ERC1271.encodeFunctionData("isValidSignature", [digest, signature]) });
    return { code, magicValue: ERC1271.decodeFunctionResult("isValidSignature", result)[0] };
  };
}

async function composeProduction(env) {
  const config = serverConfigFromEnv(env);
  const observability = createGateObservability();
  const baseClient = createRpcClient(config.baseRpcUrl, config.settlement.chainId);
  const ethereumClient = createRpcClient(config.ethereumRpcUrl, "1");
  const store = new PostgresGateStore({ connectionString: config.databaseUrl,
    baseCodeReader: ({ wallet }) => baseClient.getCode(wallet) });
  try {
    // Before anything else is composed, prove this database belongs to this
    // environment alone. See assertEnvironmentIsolation.
    await assertEnvironmentIsolation(store.pool, config.settlement);
    const source = createCanonicalIndexSource({ baseUrl: config.indexUrl, ethereumProvider: ethereumClient.provider });
  const indexClient = createNounsIndexClient({ source, freshnessMs: config.freshnessMs, observability });
  const authService = createAuthService({
    repository: store, audience: config.audience,
    base: { chainId: Number(config.settlement.chainId), verifier: config.baseVerifier },
    dao: { chainId: 1, verifier: config.daoVerifier, dao: "nouns" },
    chainVerifiers: { 1: contractVerifier(ethereumClient), [config.settlement.chainId]: contractVerifier(baseClient) },
  });
  const profileService = createProfileService({ repository: store, authService, indexClient,
    baseChainId: config.settlement.chainId });
  const deployment = await store.getDeployment({ chainId: config.settlement.chainId, splitter: config.settlement.splitter });
  if (!deployment) throw new Error("authoritative Gate deployment is missing");
  const quoteSigner = createQuoteSignerFromEnv(env, { chainId: config.settlement.chainId, splitter: config.settlement.splitter });
  const submissionService = createSubmissionService({
    store, publicReader: createPublicGateReader(store.pool), indexClient, quoteSigner,
    deployment: { id: deployment.id, chainId: deployment.chainId, splitter: deployment.splitter,
      token: deployment.token, codeHash: deployment.contractCodeHash },
    basePayerCodeReader: ({ wallet }) => baseClient.getCode(wallet),
  });
  const inboxService = createInboxService({ store });
  const operatorAlert = ({ source, code } = {}) => {
    const safeSource = source === "scanner_overlap" ? "overlap" : source;
    try { observability.recordOperatorAlert({ source: safeSource, code }); }
    catch { try { observability.recordOperatorAlert({ source: "gate", code: "OPERATION_FAILED" }); } catch {} }
  };
  const runtime = await createGateServerRuntime({ env, store, baseClient, authService, profileService,
    submissionService, inboxService, operatorAlert, observability,
    corsOrigins: config.corsOrigins,
    lifecycleReader: async ({ proposalId, targetId }) => targetId
      ? await indexClient.getTargetLifecycle(targetId)
      : (await indexClient.getProposalSnapshot(proposalId)).eligibility,
    onError: () => operatorAlert({ source: "gate_worker", code: "WORKER_FAILED" }),
    notifierLogger: { error(message) {
      const match = /^source=email_notifier code=([A-Z0-9_]{1,64})$/.exec(String(message));
      try { observability.alert({ source: "email_notifier", code: match?.[1] || "PROVIDER_ERROR" }); }
      catch { try { observability.alert({ source: "email_notifier", code: "PROVIDER_ERROR" }); } catch {} }
    } },
  });
  return { config, runtime, store, indexSource: source, ethereumClient, observability };
  } catch (error) {
    await store.close().catch(() => {});
    throw error;
  }
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function startGateServer({ env = process.env, dependencies = {}, installSignalHandlers = true } = {}) {
  const compose = dependencies.compose || composeProduction;
  const composed = await compose(env);
  const config = composed.config || { host: env.GAVEL_GATE_HOST || "0.0.0.0",
    port: integer(env.GAVEL_GATE_PORT, "GAVEL_GATE_PORT", 8080, 0) };
  const checkDatabase = dependencies.checkDatabase || (() => assertDatabaseReady(composed.store.pool));
  const checkIndex = dependencies.checkIndex || (async () => {
    const [health, ethereumChainId] = await Promise.all([
      bounded(() => composed.indexSource.getHealth("nouns")),
      bounded(() => composed.ethereumClient.getChainId()),
    ]);
    const refreshedAt = Date.parse(health?.refreshedAt);
    const age = Date.now() - refreshedAt;
    const freshnessHealth = health?.healthy !== true ? "unhealthy"
      : (!Number.isFinite(age) || age < 0 || age > config.freshnessMs) ? "stale" : "healthy";
    try {
      if (Number.isFinite(age) && age >= 0) {
        composed.observability?.gauge("gate_dao_freshness_age_seconds", age / 1000, { health: freshnessHealth });
      }
    } catch {}
    if (freshnessHealth !== "healthy"
        || ethereumChainId !== "1") throw new Error("canonical index or Ethereum RPC is unhealthy");
  });
  let stopping;
  let runtimeServerError;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      let failure;
      try { await composed.runtime.stop(); } catch (error) { failure = error; }
      try { await closeServer(composed.runtime.server); } catch (error) { failure ||= error; }
      try { await composed.store.close(); } catch (error) { failure ||= error; }
      if (runtimeServerError) composed.runtime.server.off("error", runtimeServerError);
      if (failure) throw failure;
    })();
    return stopping;
  };
  try {
    await checkDatabase(composed);
    await checkIndex(composed);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        composed.runtime.server.off("error", onError);
        composed.runtime.server.off("listening", onListening);
      };
      const onError = (error) => { cleanup(); reject(error); };
      const onListening = () => { cleanup(); resolve(); };
      composed.runtime.server.once("error", onError);
      composed.runtime.server.once("listening", onListening);
      composed.runtime.server.listen(config.port, config.host);
    });
    runtimeServerError = () => {
      process.exitCode = 1;
      void stop().catch(() => {});
    };
    composed.runtime.server.on("error", runtimeServerError);
    composed.runtime.start();
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  if (installSignalHandlers) {
    const shutdown = () => stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
  return Object.freeze({ server: composed.runtime.server, stop });
}

async function main() {
  try { await startGateServer(); }
  catch { process.stderr.write('{"level":"error","event":"gate_startup_failed"}\n'); process.exitCode = 1; }
}

if (require.main === module) main();

module.exports = { assertDatabaseReady, assertEnvironmentIsolation, bounded, createCanonicalIndexSource,
  createRpcClient, serverConfigFromEnv, startGateServer };
