const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONFIG_SCHEMA_VERSION,
  MigrationCode,
  configPath,
  loadGavelConfig,
  migrateGavelConfig,
  needsMigration,
  persistMigratedConfig,
} = require("../packages/core");

const SENTINEL_KEY = "0x" + "cd".repeat(32);
const SENTINEL_PHRASE =
  "sentinel canvas orbit puzzle ladder mirror tunnel violin gravel candle marble pepper";
const OWNER = "0x1111111111111111111111111111111111111111";

const codes = (result) => result.notes.map((note) => note.code);
const text = (result) => JSON.stringify(result);

test("a Nouns-only configuration becomes followedDaos: [nouns]", () => {
  const result = migrateGavelConfig({ version: 1, dao: "nouns", address: OWNER });
  assert.equal(result.migrated, true);
  assert.deepEqual(result.config.followedDaos, ["nouns"]);
  assert.equal(result.config.identity.address, OWNER);
  assert.equal(result.config.schemaVersion, CONFIG_SCHEMA_VERSION);
  assert.ok(codes(result).includes(MigrationCode.FOLLOWED_DAOS_FROM_SINGLE));
});

test("a configuration predating DAO selection follows the DAO it was built for", () => {
  const result = migrateGavelConfig({ version: 1, address: OWNER });
  assert.deepEqual(result.config.followedDaos, ["nouns"]);
  // Recorded, not silent: the user is told an assumption was made.
  assert.ok(codes(result).includes(MigrationCode.DEFAULTED_TO_NOUNS));
});

test("migration is idempotent", () => {
  const first = migrateGavelConfig({ version: 1, dao: "nouns", address: OWNER });
  assert.equal(needsMigration(first.config), false);
  const second = migrateGavelConfig(first.config);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.notes, []);
  assert.deepEqual(second.config, first.config);
  const third = migrateGavelConfig(second.config);
  assert.deepEqual(third.config, first.config);
});

test("an ambiguous `wallet` field migrates to the reading with less authority", () => {
  const result = migrateGavelConfig({ version: 1, dao: "nouns", wallet: OWNER });
  // It becomes the governance identity, read-only. Never a signer: a wrong
  // guess in that direction would silently arm one.
  assert.equal(result.config.identity.address, OWNER);
  assert.equal(result.config.wallet.type, "read-only");
  assert.equal(result.config.execution.mode, "unsigned");
  assert.ok(codes(result).includes(MigrationCode.AMBIGUOUS_WALLET));
  assert.match(text(result), /will not grant\s+signing authority/);
});

test("a plaintext secret is detected, removed, and never echoed", () => {
  const result = migrateGavelConfig({
    version: 1,
    dao: "nouns",
    wallet: { address: OWNER, privateKey: SENTINEL_KEY },
    mnemonic: SENTINEL_PHRASE,
  });
  const serialized = text(result);
  assert.ok(!serialized.includes(SENTINEL_KEY));
  assert.ok(!serialized.includes(SENTINEL_PHRASE));
  assert.ok(!JSON.stringify(result.config).includes(SENTINEL_KEY));
  assert.ok(codes(result).includes(MigrationCode.PLAINTEXT_SECRET_REMOVED));
  // The note says where to put it instead.
  assert.match(serialized, /encrypted keystore/);
  // Authority is reduced, never carried: the identity survives, the signer does not.
  assert.equal(result.config.identity.address, OWNER);
  assert.equal(result.config.wallet.type, "read-only");
});

test("a signing execution mode does not survive a migration to a read-only wallet", () => {
  const result = migrateGavelConfig({
    version: 1,
    daos: ["nouns", "ens"],
    execution: { mode: "waap-autonomous", safe: { address: OWNER, chainId: 1 } },
  });
  assert.deepEqual(result.config.followedDaos, ["nouns", "ens"]);
  assert.equal(result.config.execution.mode, "unsigned");
  assert.ok(codes(result).includes(MigrationCode.EXECUTION_MODE_CARRIED));
  // The Safe address is not signing authority, so it is preserved.
  assert.equal(result.config.execution.safe.address, OWNER);
});

test("an unknown legacy DAO is dropped with a note rather than carried", () => {
  const result = migrateGavelConfig({ version: 1, daos: ["nouns", "defunct-dao"] });
  assert.deepEqual(result.config.followedDaos, ["nouns"]);
  assert.ok(codes(result).includes(MigrationCode.UNKNOWN_DAO_DROPPED));
});

test("loading migrates transparently and persists once", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-migrate-"));
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    configPath(dataDir),
    JSON.stringify({ version: 1, dao: "nouns", wallet: { address: OWNER, privateKey: SENTINEL_KEY } }),
    "utf8",
  );

  const loaded = await loadGavelConfig({ dataDir });
  assert.equal(loaded.migrated, true);
  assert.deepEqual(loaded.config.followedDaos, ["nouns"]);

  const persisted = await persistMigratedConfig({ dataDir });
  assert.equal(persisted.written, true);
  const raw = await fs.readFile(configPath(dataDir), "utf8");
  // The secret is gone from disk, and the notes that replaced it are not.
  assert.ok(!raw.includes(SENTINEL_KEY));
  assert.match(raw, /PLAINTEXT_SECRET_REMOVED/);

  // Second load sees a current document and reports no migration.
  const again = await loadGavelConfig({ dataDir });
  assert.equal(again.migrated, false);
  assert.deepEqual(again.notes, []);
});

test("a missing config is first launch, not an error", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gavel-fresh-"));
  const loaded = await loadGavelConfig({ dataDir });
  assert.equal(loaded.exists, false);
  assert.equal(loaded.config.onboarding.completed, false);
  assert.deepEqual(loaded.config.followedDaos, []);
});
