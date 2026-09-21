"use strict";

const { Interface, TypedDataEncoder, keccak256 } = require("ethers");
const { createBaseSettlementAdapter, DEFAULT_SCAN_CONCURRENCY, MAX_SCAN_CONCURRENCY }
  = require("./base-settlement-adapter");
const { createGateHttpServer } = require("./http");
const { createNotificationWorker } = require("./notification-worker");
const { createGateRelayService } = require("./relay-service");
const { createGateRelayerFromEnv } = require("./relay-signer");
const { createAgentMailSender, createDeliverySettingsCipher, createEmailNotifier } = require("./notifiers/email");
const { createSettlementService } = require("./settlement-service");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^[1-9][0-9]*$/;
const PRODUCTION_BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AGENTMAIL_ORIGINS = new Set([
  "https://api.agentmail.to",
  "https://x402.api.agentmail.to",
  "https://mpp.api.agentmail.to",
  "https://api.agentmail.eu",
]);
const INBOX_LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const INBOX_DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const NOTIFIER_CONFIG_KEYS = Object.freeze([
  "GAVEL_GATE_NOTIFIER_MODE", "GAVEL_GATE_ENCRYPTION_KEY", "AGENTMAIL_API_KEY",
  "AGENTMAIL_FROM_INBOX", "AGENTMAIL_API_URL",
]);
// The remote relay is opt-in and all-or-nothing: either both keys are present
// and valid, or this deployment serves no relay route at all.
const RELAY_CONFIG_KEYS = Object.freeze(["GAVEL_GATE_RELAYER_KEY", "GAVEL_GATE_RELAYER_ADDRESS"]);
const SETTLEMENT_CONFIG_KEYS = Object.freeze([
  "GAVEL_GATE_ENVIRONMENT",
  "GAVEL_GATE_SPLITTER",
  "GAVEL_GATE_BASE_USDC",
  "GAVEL_GATE_TEST_TOKEN_LABEL",
  "GAVEL_GATE_BASE_RPC_URL",
  "GAVEL_GATE_BASE_CHAIN_ID",
  "GAVEL_GATE_QUOTE_SIGNER_ADDRESS",
  "GAVEL_GATE_OWNER_RECIPIENT",
  "GAVEL_GATE_CONFIRMATION_DEPTH",
  "GAVEL_GATE_REORG_OVERLAP_BLOCKS",
  "GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE",
  "GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS",
  "GAVEL_GATE_BASE_RPC_TIMEOUT_MS",
  "GAVEL_GATE_NOTIFICATION_LEASE_MS",
]);

function positive(value, name, fallback) {
  const raw = value === undefined ? String(fallback) : String(value);
  if (!DECIMAL.test(raw)) throw new TypeError(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} must be a positive safe integer`);
  return parsed;
}

function validAddress(value) { return typeof value === "string" && ADDRESS.test(value); }
function validInboxAddress(value) {
  if (typeof value !== "string" || value.length > 254) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && local.length <= 64 && INBOX_LOCAL.test(local)
    && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && domain.length > 0 && domain.length <= 253
    && domain.split(".").every((label) => INBOX_DOMAIN_LABEL.test(label));
}
function sameAddress(actual, expected) {
  return validAddress(actual) && validAddress(expected) && actual.toLowerCase() === expected.toLowerCase();
}

function notifierRuntimeConfigFromEnv(env = process.env) {
  const mode = env.GAVEL_GATE_NOTIFIER_MODE;
  if (typeof mode !== "string" || mode === "") {
    throw new TypeError("GAVEL_GATE_NOTIFIER_MODE is required and must be exactly disabled or agentmail");
  }
  if (mode !== "disabled" && mode !== "agentmail") {
    throw new TypeError("GAVEL_GATE_NOTIFIER_MODE must be exactly disabled or agentmail");
  }
  if (mode === "disabled") {
    const unexpected = NOTIFIER_CONFIG_KEYS.slice(1)
      .some((name) => Object.prototype.hasOwnProperty.call(env, name));
    if (unexpected) throw new TypeError("disabled notifier mode cannot include AgentMail or encryption configuration");
    return Object.freeze({ mode });
  }
  if (typeof env.AGENTMAIL_API_KEY !== "string" || env.AGENTMAIL_API_KEY === "") {
    throw new TypeError("AGENTMAIL_API_KEY is required for AgentMail notifier mode");
  }
  if (!validInboxAddress(env.AGENTMAIL_FROM_INBOX)) {
    throw new TypeError("AGENTMAIL_FROM_INBOX must be a valid inbox address");
  }
  createDeliverySettingsCipher({ encodedKey: env.GAVEL_GATE_ENCRYPTION_KEY });
  const apiUrl = env.AGENTMAIL_API_URL || "https://api.agentmail.to";
  let parsed;
  try { parsed = new URL(apiUrl); } catch { throw new TypeError("AGENTMAIL_API_URL must be an allowlisted HTTPS origin"); }
  if (!AGENTMAIL_ORIGINS.has(parsed.origin) || parsed.href !== `${parsed.origin}/`
      || parsed.username || parsed.password) {
    throw new TypeError("AGENTMAIL_API_URL must be an allowlisted HTTPS origin");
  }
  return Object.freeze({ mode, encryptionKey: env.GAVEL_GATE_ENCRYPTION_KEY,
    apiKey: env.AGENTMAIL_API_KEY, fromInbox: env.AGENTMAIL_FROM_INBOX, apiUrl: parsed.origin });
}

function authoritativeDeploymentMatches(deployment, config) {
  const persistedConfig = deployment?.config;
  if (!persistedConfig || typeof persistedConfig !== "object" || Array.isArray(persistedConfig)) return false;
  if (persistedConfig.environment !== config.environment || String(deployment.chainId) !== config.chainId
      || !sameAddress(deployment.token, config.token) || !sameAddress(deployment.splitter, config.splitter)
      || !sameAddress(deployment.signer, config.quoteSigner)
      || !sameAddress(deployment.gavelRecipient, config.gavelRecipient)
      || typeof deployment.contractCodeHash !== "string" || !BYTES32.test(deployment.contractCodeHash)) return false;
  if (config.environment === "production") return !Object.hasOwn(persistedConfig, "testTokenLabel");
  return persistedConfig.testTokenLabel === config.testTokenLabel;
}

function submissionIdentityMatches(service, deployment) {
  const identity = service?.runtimeIdentity;
  return identity && typeof identity === "object"
    && identity.deploymentId === deployment.id
    && String(identity.chainId) === String(deployment.chainId)
    && sameAddress(identity.splitter, deployment.splitter)
    && sameAddress(identity.token, deployment.token)
    && sameAddress(identity.quoteSigner, deployment.signer)
    && typeof identity.codeHash === "string"
    && identity.codeHash.toLowerCase() === deployment.contractCodeHash.toLowerCase();
}

const SPLITTER_READS = new Interface([
  "function usdc() view returns (address)",
  "function quoteSigner() view returns (address)",
  "function gavelRecipient() view returns (address)",
  "function GAVEL_FEE_AMOUNT() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);
const TOKEN_READS = new Interface([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

async function boundedRpc(operation, timeoutMs, name) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Base RPC ${name} timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function readContract(client, target, iface, method, timeoutMs) {
  const result = await boundedRpc(() => client.call({ to: target, data: iface.encodeFunctionData(method) }),
    timeoutMs, method);
  const data = typeof result === "string" ? result : result?.data;
  if (typeof data !== "string") throw new Error(`${method} RPC result is incomplete`);
  return iface.decodeFunctionResult(method, data)[0];
}

async function readOnchainDeployment({ client, splitter, token, rpcTimeoutMs = 10_000 }) {
  if (!client || typeof client.getCode !== "function") {
    throw new TypeError("baseClient.getCode is required for deployment attestation");
  }
  if (typeof client.call !== "function") throw new TypeError("baseClient.call is required for deployment attestation");
  const deployedBytecode = await boundedRpc(() => client.getCode(splitter), rpcTimeoutMs, "getCode");
  const [usdc, quoteSigner, gavelRecipient, gavelFeeAmount, domainSeparator,
    tokenName, tokenVersion, tokenDomainSeparator] = await Promise.all([
    readContract(client, splitter, SPLITTER_READS, "usdc", rpcTimeoutMs),
    readContract(client, splitter, SPLITTER_READS, "quoteSigner", rpcTimeoutMs),
    readContract(client, splitter, SPLITTER_READS, "gavelRecipient", rpcTimeoutMs),
    readContract(client, splitter, SPLITTER_READS, "GAVEL_FEE_AMOUNT", rpcTimeoutMs),
    readContract(client, splitter, SPLITTER_READS, "DOMAIN_SEPARATOR", rpcTimeoutMs),
    readContract(client, token, TOKEN_READS, "name", rpcTimeoutMs),
    readContract(client, token, TOKEN_READS, "version", rpcTimeoutMs),
    readContract(client, token, TOKEN_READS, "DOMAIN_SEPARATOR", rpcTimeoutMs),
  ]);
  return { deployedBytecode, usdc, quoteSigner, gavelRecipient, gavelFeeAmount: String(gavelFeeAmount),
    domainSeparator, tokenName, tokenVersion, tokenDomainSeparator };
}

function assertOnchainDeployment(attestation, deployment, config) {
  try {
    if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)
        || typeof attestation.deployedBytecode !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(attestation.deployedBytecode)
        || keccak256(attestation.deployedBytecode).toLowerCase() !== deployment.contractCodeHash.toLowerCase()
        || !sameAddress(attestation.usdc, deployment.token)
        || !sameAddress(attestation.quoteSigner, deployment.signer)
        || !sameAddress(attestation.gavelRecipient, deployment.gavelRecipient)
        || String(attestation.gavelFeeAmount) !== "250000"
        || typeof attestation.tokenName !== "string" || attestation.tokenName.length === 0
        || typeof attestation.tokenVersion !== "string" || attestation.tokenVersion.length === 0) throw new Error("mismatch");
    const splitterDomain = TypedDataEncoder.hashDomain({
      name: "GavelGateSplitter", version: "1", chainId: config.chainId, verifyingContract: config.splitter,
    });
    const tokenDomain = TypedDataEncoder.hashDomain({
      name: attestation.tokenName, version: attestation.tokenVersion,
      chainId: config.chainId, verifyingContract: config.token,
    });
    if (!BYTES32.test(attestation.domainSeparator) || attestation.domainSeparator.toLowerCase() !== splitterDomain.toLowerCase()
        || !BYTES32.test(attestation.tokenDomainSeparator)
        || attestation.tokenDomainSeparator.toLowerCase() !== tokenDomain.toLowerCase()
        || (config.environment === "production"
          && (attestation.tokenName !== "USD Coin" || attestation.tokenVersion !== "2"))) throw new Error("mismatch");
  } catch {
    throw new Error("onchain deployment attestation does not match the authoritative deployment");
  }
}

function settlementRuntimeConfigFromEnv(env = process.env) {
  const configured = SETTLEMENT_CONFIG_KEYS.some((key) => env[key] !== undefined && env[key] !== "");
  if (!configured) return null;
  if (typeof env.GAVEL_GATE_SPLITTER !== "string" || !env.GAVEL_GATE_SPLITTER) {
    throw new TypeError("GAVEL_GATE_SPLITTER is required when settlement is configured");
  }
  if (!ADDRESS.test(env.GAVEL_GATE_SPLITTER)) throw new TypeError("GAVEL_GATE_SPLITTER must be an Ethereum address");
  const environment = env.GAVEL_GATE_ENVIRONMENT;
  const token = env.GAVEL_GATE_BASE_USDC;
  if (typeof environment !== "string" || !environment) {
    throw new TypeError("GAVEL_GATE_ENVIRONMENT is required when settlement is configured");
  }
  if (!new Set(["production", "test"]).has(environment)) {
    throw new TypeError("GAVEL_GATE_ENVIRONMENT must be exactly production or test");
  }
  if (typeof token !== "string" || !ADDRESS.test(token)) {
    throw new TypeError("GAVEL_GATE_BASE_USDC must be an Ethereum address");
  }
  if (environment === "production" && token.toLowerCase() !== PRODUCTION_BASE_USDC) {
    throw new TypeError("production settlement environment requires canonical Base native USDC");
  }
  if (environment === "production" && Object.hasOwn(env, "GAVEL_GATE_TEST_TOKEN_LABEL")) {
    throw new TypeError("production settlement environment requires the test token label to be unset");
  }
  if (environment === "test" && (typeof env.GAVEL_GATE_TEST_TOKEN_LABEL !== "string"
      || env.GAVEL_GATE_TEST_TOKEN_LABEL.trim() === "")) {
    throw new TypeError("test token label GAVEL_GATE_TEST_TOKEN_LABEL is required");
  }
  for (const name of ["GAVEL_GATE_QUOTE_SIGNER_ADDRESS", "GAVEL_GATE_OWNER_RECIPIENT"]) {
    if (!validAddress(env[name])) throw new TypeError(`${name} must be an Ethereum address`);
  }
  const chainId = String(env.GAVEL_GATE_BASE_CHAIN_ID ?? "8453");
  if (!DECIMAL.test(chainId)) throw new TypeError("GAVEL_GATE_BASE_CHAIN_ID must be a positive decimal integer");
  if (environment === "production" && chainId !== "8453") {
    throw new TypeError("production settlement environment requires Base mainnet chain 8453");
  }
  if (environment === "test" && chainId !== "84532") {
    throw new TypeError("test settlement environment requires Base Sepolia chain 84532");
  }
  const overlap = positive(env.GAVEL_GATE_REORG_OVERLAP_BLOCKS, "GAVEL_GATE_REORG_OVERLAP_BLOCKS", 64);
  const maxBlockRange = positive(env.GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE,
    "GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE", 5_000);
  if (maxBlockRange <= overlap) {
    throw new TypeError("GAVEL_GATE_SETTLEMENT_MAX_BLOCK_RANGE must be greater than GAVEL_GATE_REORG_OVERLAP_BLOCKS");
  }
  // In-flight RPCs per scan phase. This changes transport only: the scanner performs the same
  // logical reads either way, and a higher bound simply lets more of them be batched together.
  // Shares the adapter's constants rather than repeating the literals: these two config readers
  // have already drifted apart once.
  const scanConcurrency = positive(env.GAVEL_GATE_SETTLEMENT_SCAN_CONCURRENCY,
    "GAVEL_GATE_SETTLEMENT_SCAN_CONCURRENCY", DEFAULT_SCAN_CONCURRENCY);
  if (scanConcurrency > MAX_SCAN_CONCURRENCY) {
    throw new TypeError(`GAVEL_GATE_SETTLEMENT_SCAN_CONCURRENCY must not exceed ${MAX_SCAN_CONCURRENCY}`);
  }
  // JSON-RPC batch width. Providers that reject or cap batches need this lowered to match;
  // 1 disables batching and restores one HTTP round trip per call.
  const rpcBatchMaxCount = positive(env.GAVEL_GATE_BASE_RPC_BATCH_MAX_COUNT,
    "GAVEL_GATE_BASE_RPC_BATCH_MAX_COUNT", 100);
  if (rpcBatchMaxCount > 1_000) throw new TypeError("GAVEL_GATE_BASE_RPC_BATCH_MAX_COUNT must not exceed 1000");
  const notificationLeaseMs = positive(env.GAVEL_GATE_NOTIFICATION_LEASE_MS,
    "GAVEL_GATE_NOTIFICATION_LEASE_MS", 5 * 60_000);
  if (notificationLeaseMs > 3_600_000) throw new TypeError("GAVEL_GATE_NOTIFICATION_LEASE_MS must not exceed 3600000");
  const confirmationDepth = positive(env.GAVEL_GATE_CONFIRMATION_DEPTH, "GAVEL_GATE_CONFIRMATION_DEPTH", 1);
  if (confirmationDepth !== 1) throw new TypeError("GAVEL_GATE_CONFIRMATION_DEPTH must be exactly 1 for the MVP");
  const monitorConfirmations = positive(env.GAVEL_GATE_REORG_MONITOR_CONFIRMATIONS,
    "GAVEL_GATE_REORG_MONITOR_CONFIRMATIONS", 64);
  if (monitorConfirmations !== 64) {
    throw new TypeError("GAVEL_GATE_REORG_MONITOR_CONFIRMATIONS must be exactly 64 for the MVP");
  }
  const rpcTimeoutMs = positive(env.GAVEL_GATE_BASE_RPC_TIMEOUT_MS, "GAVEL_GATE_BASE_RPC_TIMEOUT_MS", 10_000);
  if (rpcTimeoutMs > 60_000) throw new TypeError("GAVEL_GATE_BASE_RPC_TIMEOUT_MS must not exceed 60000");
  return Object.freeze({
    environment,
    chainId,
    token: token.toLowerCase(),
    ...(environment === "test" ? { testTokenLabel: env.GAVEL_GATE_TEST_TOKEN_LABEL } : {}),
    splitter: env.GAVEL_GATE_SPLITTER.toLowerCase(),
    quoteSigner: env.GAVEL_GATE_QUOTE_SIGNER_ADDRESS.toLowerCase(),
    gavelRecipient: env.GAVEL_GATE_OWNER_RECIPIENT.toLowerCase(),
    confirmationDepth,
    monitorConfirmations,
    overlap,
    maxBlockRange,
    scanConcurrency,
    rpcBatchMaxCount,
    pollIntervalMs: positive(env.GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS, "GAVEL_GATE_SETTLEMENT_POLL_INTERVAL_MS", 5_000),
    rpcTimeoutMs,
    notificationLeaseMs,
  });
}

async function createGateServerRuntime(options = {}) {
  const env = options.env ?? process.env;
  const config = settlementRuntimeConfigFromEnv(env);
  // A relay key with no settlement runtime would be a funded wallet with no
  // authoritative deployment to validate against. Fail closed at startup.
  if (!config && RELAY_CONFIG_KEYS.some((key) => env[key] !== undefined && env[key] !== "")) {
    throw new TypeError("Gate relay configuration requires a configured settlement runtime");
  }
  const notifierConfig = notifierRuntimeConfigFromEnv(env);
  if (notifierConfig.mode === "agentmail" && !config) {
    throw new TypeError("AgentMail notifier mode requires configured settlement runtime");
  }
  if (notifierConfig.mode === "disabled" && options.notificationProvider !== undefined) {
    throw new TypeError("disabled notifier mode cannot include a notification provider");
  }
  if (notifierConfig.mode === "agentmail" && options.notificationProvider !== undefined) {
    throw new TypeError("AgentMail notifier mode cannot include an injected notification provider");
  }
  const factories = {
    createBaseSettlementAdapter,
    createSettlementService,
    createGateRelayService,
    createGateHttpServer,
    ...options.factories,
  };
  const scheduler = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    ...options.scheduler,
  };
  const onError = options.onError ?? (() => {});
  if (typeof onError !== "function") throw new TypeError("onError must be a function");
  const observability = options.observability;
  if (observability !== undefined && typeof observability?.observeWorkerResult !== "function") {
    throw new TypeError("observability.observeWorkerResult must be a function");
  }

  let adapter = null;
  let settlementService = null;
  let relayService = null;
  let notificationWorker = null;
  let notificationProvider = options.notificationProvider;
  let profileService = options.profileService;
  const jobs = [];

  if (config) {
    if (!options.store || typeof options.store !== "object") throw new TypeError("store is required for configured settlement");
    if (typeof options.store.markExpired !== "function") throw new TypeError("store.markExpired is required for configured settlement");
    if (!options.baseClient || typeof options.baseClient !== "object") throw new TypeError("baseClient is required for configured settlement");
    if (typeof options.lifecycleReader !== "function") throw new TypeError("lifecycleReader is required for configured settlement");
    if (typeof options.operatorAlert !== "function") throw new TypeError("operatorAlert is required for configured settlement");
    if (typeof options.store.getDeployment !== "function") throw new TypeError("store.getDeployment is required for configured settlement");
    if (typeof options.baseClient.getChainId !== "function") throw new TypeError("baseClient.getChainId is required for configured settlement");
    if (notificationProvider !== undefined && typeof notificationProvider !== "function") {
      throw new TypeError("notificationProvider must be a function");
    }
    const deployment = await boundedRpc(
      () => options.store.getDeployment({ chainId: config.chainId, splitter: config.splitter }),
      config.rpcTimeoutMs, "deployment registry read");
    if (!authoritativeDeploymentMatches(deployment, config)) {
      throw new Error("authoritative deployment identity does not match settlement configuration");
    }
    if (!submissionIdentityMatches(options.submissionService, deployment)) {
      throw new Error("submission service does not match the authoritative deployment identity");
    }
    const rpcChain = BigInt(await boundedRpc(() => options.baseClient.getChainId(), config.rpcTimeoutMs, "getChainId")).toString();
    if (rpcChain !== config.chainId) {
      throw new Error(`RPC chain ${rpcChain} does not match configured chain ${config.chainId}`);
    }
    const attestation = await readOnchainDeployment({
      client: options.baseClient, chainId: config.chainId, splitter: config.splitter, token: config.token,
      rpcTimeoutMs: config.rpcTimeoutMs,
    });
    assertOnchainDeployment(attestation, deployment, config);
    adapter = factories.createBaseSettlementAdapter({
      client: options.baseClient,
      chainId: config.chainId,
      splitter: config.splitter,
      confirmationDepth: config.confirmationDepth,
      overlap: config.overlap,
      maxBlockRange: config.maxBlockRange,
      scanConcurrency: config.scanConcurrency,
      rpcTimeoutMs: config.rpcTimeoutMs,
    });
    settlementService = factories.createSettlementService({
      store: options.store,
      adapter,
      lifecycleReader: options.lifecycleReader,
      operatorAlert: options.operatorAlert,
      monitorConfirmations: config.monitorConfirmations,
    });
    const observedJob = (name, job) => async () => {
      const result = await job();
      try { observability?.observeWorkerResult(name, result); } catch {}
      return result;
    };
    jobs.push(observedJob("expire", () => options.store.markExpired()),
      observedJob("scan", settlementService.scanOnce),
      observedJob("reconcile", settlementService.reconcileSubmitted),
      observedJob("monitor", settlementService.monitorOnce));
    // The remote relay, when this deployment is the one holding the funded
    // gas-only wallet. It is mounted only with a configured relayer AND a
    // submission service to look the owner-bound quote up in: it can never
    // broadcast anything Gate did not sign itself.
    const relayer = options.relayer !== undefined
      ? options.relayer
      : createGateRelayerFromEnv(env, { provider: options.baseClient?.provider, chainId: config.chainId });
    // `options.submissionService` is already proven to match the authoritative
    // deployment above, so the relay resolves owner-bound quotes through the
    // same service that issued them.
    if (relayer) {
      relayService = factories.createGateRelayService({
        relayer,
        submissionService: options.submissionService,
        deployment: {
          chainId: config.chainId,
          splitter: deployment.splitter,
          token: deployment.token,
          quoteSigner: deployment.signer,
        },
        // The token's OWN EIP-712 name and version, as attested against its
        // on-chain DOMAIN_SEPARATOR at startup. Never guessed.
        tokenDomain: { name: attestation.tokenName, version: attestation.tokenVersion },
      });
    }
    if (notifierConfig.mode === "agentmail") {
      const { encryptDestination, resolveDestination: decryptDestination } = createDeliverySettingsCipher({
        encodedKey: notifierConfig.encryptionKey,
      });
      if (typeof encryptDestination !== "function" || typeof decryptDestination !== "function"
          || typeof profileService?.withDestinationEncryption !== "function") {
        throw new TypeError("profile service destination encryption binding is required in AgentMail mode");
      }
      const probeProfileId = "gavel-gate-notifier-startup-probe";
      const probeDestination = "notifier-probe@example.invalid";
      const probeEnvelope = await encryptDestination(probeProfileId, probeDestination);
      if (await decryptDestination(probeProfileId, probeEnvelope) !== probeDestination) {
        throw new TypeError("delivery settings cipher startup round trip failed");
      }
      profileService = profileService.withDestinationEncryption(encryptDestination);
      const send = createAgentMailSender({
        apiUrl: notifierConfig.apiUrl,
        apiKey: notifierConfig.apiKey,
        fromInbox: notifierConfig.fromInbox,
      });
      const sink = options.notifierLogger;
      const logger = Object.freeze({
        error(message) {
          const redacted = /^source=email_notifier code=[A-Z0-9_]{1,64}$/.test(String(message))
            ? String(message) : "source=email_notifier code=REDACTED";
          try { sink?.error?.(redacted); } catch {}
        },
      });
      notificationProvider = createEmailNotifier({
        send,
        resolveDestination: (destinationRef, profileId) => decryptDestination(profileId, destinationRef),
        logger,
      });
    }
    if (notificationProvider) {
      notificationWorker = createNotificationWorker({
        store: options.store, provider: notificationProvider, leaseMs: config.notificationLeaseMs,
        operatorAlert: options.operatorAlert,
      });
      jobs.push(observedJob("notification", notificationWorker.runOnce));
    }
  }

  const httpOptions = {
    authService: options.authService,
    profileService,
    ...(!config || options.submissionService === undefined ? {} : { submissionService: options.submissionService }),
    ...(options.inboxService === undefined ? {} : { inboxService: options.inboxService }),
    ...(settlementService ? { settlementService } : {}),
    ...(relayService ? { relayService } : {}),
    ...(observability ? { observability } : {}),
    ...(options.corsOrigins === undefined ? {} : { corsOrigins: options.corsOrigins }),
  };
  const server = factories.createGateHttpServer(httpOptions);
  const timers = [];
  const running = new Map();
  let stopping = false;

  async function invoke(job) {
    if (stopping || running.has(job)) return undefined;
    const execution = Promise.resolve().then(job);
    running.set(job, execution);
    try { return await execution; }
    finally { if (running.get(job) === execution) running.delete(job); }
  }

  function start() {
    if (timers.length || !config) return;
    for (const job of jobs) {
      const timer = scheduler.setInterval(() => invoke(job).catch(onError), config.pollIntervalMs);
      if (typeof timer?.unref === "function") timer.unref();
      timers.push(timer);
    }
  }

  async function stop() {
    stopping = true;
    while (timers.length) scheduler.clearInterval(timers.shift());
    const results = await Promise.allSettled([...running.values()]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  return Object.freeze({
    server,
    config,
    adapter,
    settlementService,
    relayService,
    notificationWorker,
    notificationProvider,
    runOnce: () => Promise.all(jobs.map(invoke)),
    start,
    stop,
  });
}

module.exports = { RELAY_CONFIG_KEYS, createGateServerRuntime, notifierRuntimeConfigFromEnv, readOnchainDeployment,
  settlementRuntimeConfigFromEnv };
