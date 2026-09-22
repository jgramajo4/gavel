/**
 * Reading and writing Gavel's configuration inside GAVEL_DATA_DIR.
 *
 * GAVEL_DATA_DIR is runtime-owned private state, not a secret vault. It holds
 * followed DAOs, preferences, the local governance profile, recommendation
 * history and non-secret workflow state. It never holds a key, a phrase or an
 * API credential -- `assertNoSecrets()` runs on every write, so a future
 * caller that tries cannot.
 *
 * Every deployment gets its own directory by pointing GAVEL_DATA_DIR
 * somewhere else: a standalone TUI, Hermes, Bankr and a container can run side
 * by side without sharing state, because nothing here resolves a path any
 * other way.
 */

const fs = require("node:fs/promises");
const path = require("node:path");

const { privatePath, resolveDataDir } = require("../storage/private-state");
const { isPlaintextSecret, redactSecrets } = require("./secrets");
const { defaultGavelConfig, parseGavelConfig } = require("./schema");
const { migrateGavelConfig, needsMigration } = require("./migrate");

const CONFIG_FILENAME = "config.json";

function configPath(dataDirInput) {
  const dataDir = dataDirInput || resolveDataDir();
  return privatePath(dataDir, CONFIG_FILENAME);
}

/**
 * Refuse to persist anything secret-shaped.
 *
 * The config model has no field for a secret, so reaching this means a caller
 * put one somewhere it does not belong. Failing the write is the only safe
 * response: a partially-written config is recoverable, a leaked key is not.
 * The error names the path and never the value.
 */
function assertNoSecrets(value, trail = []) {
  if (typeof value === "string") {
    if (isPlaintextSecret(value)) {
      throw new Error(
        `Refusing to write a secret to Gavel configuration at ${trail.join(".") || "<root>"}. ` +
          "Secrets belong in an encrypted keystore or the environment; configuration stores only a reference.",
      );
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const [key, entry] of Object.entries(value)) assertNoSecrets(entry, [...trail, key]);
  return value;
}

async function readConfigFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Gavel configuration at ${file} is not valid JSON`);
    }
    throw error;
  }
}

/**
 * Load, migrating transparently.
 *
 * A missing file is not an error: it means onboarding has not run, which is a
 * legitimate first-launch state the wizard handles. `migrated` tells the caller
 * whether the on-disk document changed shape, so the TUI can show the
 * migration notes once rather than on every launch.
 */
async function loadGavelConfig(options = {}) {
  const dataDir = options.dataDir || resolveDataDir({ env: options.env });
  const file = options.file || configPath(dataDir);
  const document = await readConfigFile(file);
  if (!document) {
    return { config: defaultGavelConfig(), path: file, dataDir, exists: false, migrated: false, notes: [] };
  }
  if (needsMigration(document)) {
    const { config, notes } = migrateGavelConfig(document, { now: options.now });
    return { config, path: file, dataDir, exists: true, migrated: true, notes };
  }
  return { config: parseGavelConfig(document), path: file, dataDir, exists: true, migrated: false, notes: [] };
}

/** Write with 0600 on the file and 0700 on the directory. */
async function saveGavelConfig(configInput, options = {}) {
  const dataDir = options.dataDir || resolveDataDir({ env: options.env });
  const file = options.file || configPath(dataDir);
  const config = parseGavelConfig(configInput);
  assertNoSecrets(config);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600);
  return { config, path: file, dataDir };
}

/**
 * Persist a migrated config once, so the notes are not regenerated forever.
 * Returns the saved config and whether a write happened.
 */
async function persistMigratedConfig(options = {}) {
  const loaded = await loadGavelConfig(options);
  if (!loaded.migrated) return { ...loaded, written: false };
  const saved = await saveGavelConfig(loaded.config, { ...options, dataDir: loaded.dataDir, file: loaded.path });
  return { ...loaded, config: saved.config, written: true };
}

/** The config as it may be printed, logged or sent to a diagnostic bundle. */
function serializeGavelConfig(config) {
  return redactSecrets(parseGavelConfig(config));
}

module.exports = {
  CONFIG_FILENAME,
  assertNoSecrets,
  configPath,
  loadGavelConfig,
  persistMigratedConfig,
  saveGavelConfig,
  serializeGavelConfig,
};
