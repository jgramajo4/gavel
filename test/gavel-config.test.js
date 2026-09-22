const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONFIG_SCHEMA_VERSION,
  InferenceMode,
  NetworkMode,
  configPath,
  defaultGavelConfig,
  loadGavelConfig,
  parseGavelConfig,
  redactMessage,
  redactSecrets,
  resolveSecretAudit,
  resolveSecretStatus,
  saveGavelConfig,
  serializeGavelConfig,
  validateGavelConfig,
} = require("../packages/core");

/**
 * Sentinel values. Every assertion below is "this exact string never appears",
 * so a leak anywhere in serialization, status, logs or persistence fails a
 * test rather than being noticed later in a support bundle.
 */
const SENTINEL_KEY = "0x" + "ab".repeat(32);
const SENTINEL_PHRASE =
  "sentinel canvas orbit puzzle ladder mirror tunnel violin gravel candle marble pepper";
const SENTINEL_TOKEN = "sk-sentinel-do-not-leak-1234567890";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gavel-config-"));
}

test("the default config is safe, complete and DAO-neutral", () => {
  const config = defaultGavelConfig();
  assert.equal(config.schemaVersion, CONFIG_SCHEMA_VERSION);
  // Pressing Enter through the wizard must leave a monitoring-only client.
  assert.deepEqual(config.followedDaos, []);
  assert.equal(config.wallet.type, "read-only");
  assert.equal(config.execution.mode, "unsigned");
  assert.equal(config.inference.mode, InferenceMode.LOCAL);
  assert.equal(config.privacy.network, NetworkMode.DIRECT);
  assert.equal(config.onboarding.completed, false);
  assert.equal(validateGavelConfig(config).valid, true);
});

test("cross-branch validation catches what a field schema cannot", () => {
  const issues = (overrides) =>
    validateGavelConfig(parseGavelConfig({ ...defaultGavelConfig(), ...overrides })).issues.map(
      (issue) => issue.code,
    );

  assert.deepEqual(issues({ followedDaos: ["nouns", "made-up"] }), ["UNKNOWN_DAO"]);
  assert.ok(issues({ wallet: { type: "local" } }).includes("WALLET_LOCAL_UNCONFIGURED"));
  assert.ok(
    issues({ wallet: { type: "local", local: { signer: "environment" } } }).includes(
      "WALLET_VARIABLE_UNNAMED",
    ),
  );
  assert.ok(issues({ execution: { mode: "safe-supervised" } }).includes("SAFE_UNCONFIGURED"));
  // Interactive approval with nothing that can sign is refused.
  assert.ok(
    issues({ execution: { mode: "eoa-supervised" }, wallet: { type: "read-only" } }).includes(
      "EXECUTION_NEEDS_WALLET",
    ),
  );
  // Credentials existing is never consent.
  assert.ok(
    issues({
      execution: {
        mode: "waap-autonomous",
        autonomous: { executionAddress: "0x" + "11".repeat(20), acknowledgedAt: null },
      },
    }).includes("AUTONOMOUS_NOT_ACKNOWLEDGED"),
  );
  assert.equal(
    issues({
      wallet: { type: "walletconnect" },
      execution: {
        mode: "waap-autonomous",
        autonomous: {
          executionAddress: "0x" + "11".repeat(20),
          acknowledgedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }).length,
    0,
  );
  // A declared-but-unimplemented network mode is rejected, not quietly used.
  assert.ok(issues({ privacy: { network: "tor" } }).includes("NETWORK_MODE_UNIMPLEMENTED"));
});

test("configuration cannot hold a secret, and a write that tries fails", async () => {
  const dataDir = await tempDir();
  const config = {
    ...defaultGavelConfig(),
    followedDaos: ["nouns"],
    identity: { address: "0x" + "22".repeat(20), label: SENTINEL_KEY },
  };
  await assert.rejects(
    saveGavelConfig(config, { dataDir }),
    /Refusing to write a secret to Gavel configuration at identity\.label/,
  );
  // Nothing was written, so a rejected save cannot half-persist a secret.
  await assert.rejects(fs.readFile(configPath(dataDir), "utf8"), /ENOENT/);
});

test("saved configuration is private, reloads unchanged, and holds no secret", async () => {
  const dataDir = await tempDir();
  const config = {
    ...defaultGavelConfig(),
    followedDaos: ["nouns", "ens"],
    identity: { address: "0x" + "22".repeat(20), label: "primary" },
    wallet: {
      type: "local",
      local: { signer: "environment", keystoreLabel: null, variable: "GAVEL_PRIVATE_KEY" },
      walletconnect: null,
    },
  };
  const saved = await saveGavelConfig(config, { dataDir });
  const stat = await fs.stat(saved.path);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);

  const raw = await fs.readFile(saved.path, "utf8");
  assert.doesNotMatch(raw, /ab{10}/);
  assert.ok(!raw.includes(SENTINEL_KEY) && !raw.includes(SENTINEL_PHRASE));
  // The reference is stored; the value is not.
  assert.match(raw, /"variable": "GAVEL_PRIVATE_KEY"/);

  const reloaded = await loadGavelConfig({ dataDir });
  assert.equal(reloaded.migrated, false);
  assert.deepEqual(reloaded.config.followedDaos, ["nouns", "ens"]);
  assert.equal(reloaded.config.wallet.local.variable, "GAVEL_PRIVATE_KEY");
});

test("redaction covers serialization, status, logs, errors and diagnostics", () => {
  const diagnostic = {
    config: { wallet: { privateKey: SENTINEL_KEY, variable: "GAVEL_PRIVATE_KEY" } },
    session: { topic: "abc", symKey: SENTINEL_KEY },
    notes: [`recovered with ${SENTINEL_PHRASE}`],
    provider: { apiKey: SENTINEL_TOKEN },
    nested: { deep: { mnemonic: SENTINEL_PHRASE } },
  };
  const serialized = JSON.stringify(redactSecrets(diagnostic));
  for (const sentinel of [SENTINEL_KEY, SENTINEL_PHRASE, SENTINEL_TOKEN]) {
    assert.ok(!serialized.includes(sentinel), sentinel.slice(0, 12));
  }
  // References survive: the whole point is that status stays useful.
  assert.match(serialized, /GAVEL_PRIVATE_KEY/);
  assert.match(serialized, /"topic":"abc"/);

  // Error and log text, including a value in a field with an innocent name.
  assert.ok(!redactMessage(`failed using ${SENTINEL_KEY}`).includes(SENTINEL_KEY));
  assert.ok(!redactMessage(`OPENAI_API_KEY=${SENTINEL_TOKEN}`).includes(SENTINEL_TOKEN));
  assert.ok(!JSON.stringify(redactSecrets({ label: SENTINEL_KEY })).includes(SENTINEL_KEY));

  // A status table survives as a table, and a value smuggled inside one does
  // not: the exemption is from being blanked, not from being redacted.
  const audit = redactSecrets({
    secrets: [{ variable: "GAVEL_PRIVATE_KEY", status: "configured", apiKey: SENTINEL_TOKEN }],
  });
  assert.equal(audit.secrets[0].variable, "GAVEL_PRIVATE_KEY");
  assert.equal(audit.secrets[0].apiKey, "[redacted]");

  // A cyclic diagnostic bundle must not hang or throw.
  const cyclic = { name: "bundle" };
  cyclic.self = cyclic;
  assert.equal(redactSecrets(cyclic).self, "[circular]");
});

test("secret status is source and status, never a value", () => {
  const env = { GAVEL_PRIVATE_KEY: SENTINEL_KEY, WALLETCONNECT_PROJECT_ID: "  " };
  const signer = resolveSecretStatus("execution-signer", { env });
  assert.equal(signer.source, "environment");
  assert.equal(signer.status, "configured");
  assert.equal(signer.variable, "GAVEL_PRIVATE_KEY");
  assert.ok(!JSON.stringify(signer).includes(SENTINEL_KEY));

  // Whitespace is not a configured secret.
  assert.equal(resolveSecretStatus("walletconnect-project", { env }).status, "not-required");
  assert.equal(
    resolveSecretStatus("walletconnect-project", { env, required: true }).status,
    "missing",
  );

  const audit = JSON.stringify(resolveSecretAudit({ env }));
  assert.ok(!audit.includes(SENTINEL_KEY));
  assert.match(audit, /GAVEL_PRIVATE_KEY/);

  // And the serialized config, which is what `gavel config show --json` prints.
  const serialized = JSON.stringify(
    serializeGavelConfig({
      ...defaultGavelConfig(),
      wallet: {
        type: "local",
        local: { signer: "environment", keystoreLabel: null, variable: "GAVEL_PRIVATE_KEY" },
        walletconnect: null,
      },
    }),
  );
  assert.ok(!serialized.includes(SENTINEL_KEY));
});
