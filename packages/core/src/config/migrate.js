/**
 * Migration from the Nouns-only configuration to the multi-DAO model.
 *
 * Two rules shape every decision here.
 *
 * 1. Migration never *increases* authority. Where the old format is ambiguous
 *    about whether a field named a governance identity or a signer, the
 *    migration takes the reading with less authority and records a note asking
 *    the user to confirm. A wrong guess in that direction costs a prompt; the
 *    other direction silently arms a signer.
 *
 * 2. A plaintext secret found in old configuration is detected, never echoed,
 *    and removed. It is not copied into the new file, not written to
 *    GAVEL_DATA_DIR, not printed and not logged -- the note says a secret was
 *    found and where to put it instead, and says nothing about its value.
 *
 * Migration is idempotent: running it on an already-migrated config returns
 * the same config and adds no notes.
 */

const { getAddress } = require("ethers");

const { ExecutionMode } = require("../schema/execution");
const { WalletConnectionType } = require("../wallet/provider");
const { isKnownDao, normalizeDaoSelection } = require("../dao/catalog");
const { isPlaintextSecret } = require("./secrets");
const { CONFIG_SCHEMA_VERSION, defaultGavelConfig, parseGavelConfig } = require("./schema");

const MigrationCode = Object.freeze({
  FOLLOWED_DAOS_FROM_SINGLE: "FOLLOWED_DAOS_FROM_SINGLE_DAO",
  DEFAULTED_TO_NOUNS: "FOLLOWED_DAOS_DEFAULTED",
  AMBIGUOUS_WALLET: "AMBIGUOUS_WALLET_FIELD",
  PLAINTEXT_SECRET_REMOVED: "PLAINTEXT_SECRET_REMOVED",
  UNKNOWN_DAO_DROPPED: "UNKNOWN_DAO_DROPPED",
  EXECUTION_MODE_CARRIED: "EXECUTION_MODE_CARRIED",
});

function note(notes, code, message, at) {
  notes.push({ at, code, message });
}

function readAddress(value) {
  try {
    return getAddress(String(value));
  } catch {
    return null;
  }
}

/**
 * Is this already the current model? Cheap enough to call on every load, which
 * is what makes `loadConfig()` able to migrate transparently.
 */
function needsMigration(document) {
  if (!document || typeof document !== "object") return true;
  return document.schemaVersion !== CONFIG_SCHEMA_VERSION;
}

/**
 * Migrate a legacy document.
 *
 * Accepts the shapes that existed before this model: a bare `{ dao }`, a
 * `{ daos: [...] }`, a TUI-era `{ wallet }`, and a config carrying an
 * execution mode. Anything unrecognized is dropped rather than carried
 * forward, because a field nobody can interpret is not configuration.
 */
function migrateGavelConfig(documentInput, options = {}) {
  const at = (options.now ? options.now() : new Date()).toISOString();
  const document = documentInput && typeof documentInput === "object" ? documentInput : {};

  if (!needsMigration(document)) {
    // Idempotent: a current document is returned parsed and unchanged, with no
    // new notes, so migration can run on every load without accumulating noise.
    return { config: parseGavelConfig(document), migrated: false, notes: [] };
  }

  const notes = [];
  const config = defaultGavelConfig();

  // --- followed DAOs ---------------------------------------------------
  const legacyDaos = Array.isArray(document.daos)
    ? document.daos
    : document.dao
      ? [document.dao]
      : document.followedDaos || [];
  const { selected, unknown } = normalizeDaoSelection(legacyDaos);
  for (const id of unknown) {
    note(notes, MigrationCode.UNKNOWN_DAO_DROPPED, `Dropped unknown DAO "${id}" from followed DAOs.`, at);
  }
  if (selected.length > 0) {
    config.followedDaos = selected;
    note(
      notes,
      MigrationCode.FOLLOWED_DAOS_FROM_SINGLE,
      `Carried ${selected.join(", ")} forward as followed DAOs.`,
      at,
    );
  } else if (isKnownDao("nouns") && legacyDaos.length === 0 && options.assumeLegacyDefault !== false) {
    // A config with no DAO at all predates DAO selection entirely, and the
    // only DAO that existed then was the default one. Recorded rather than
    // assumed silently.
    config.followedDaos = ["nouns"];
    note(
      notes,
      MigrationCode.DEFAULTED_TO_NOUNS,
      "This configuration predates DAO selection; following the DAO it was built for. Add or remove DAOs in Settings.",
      at,
    );
  }

  // --- identity and wallet ---------------------------------------------
  // The old `wallet` field is the ambiguous one: in different versions it
  // meant the address whose votes are read, the signer, or a Safe.
  const legacyWallet = document.wallet;
  let identityAddress = readAddress(document.address || document.voter || document.identity?.address);

  if (typeof legacyWallet === "string") {
    const address = readAddress(legacyWallet);
    if (address) {
      identityAddress = identityAddress || address;
      note(
        notes,
        MigrationCode.AMBIGUOUS_WALLET,
        `The old "wallet" field named ${address}. It has been migrated as your governance identity ` +
          "(read-only). If it was a signer, reconnect it in Settings -- migration will not grant " +
          "signing authority on its own.",
        at,
      );
    }
  } else if (legacyWallet && typeof legacyWallet === "object") {
    const address = readAddress(legacyWallet.address);
    if (address) identityAddress = identityAddress || address;
    for (const [key, value] of Object.entries(legacyWallet)) {
      if (isPlaintextSecret(value)) {
        // Detected by shape, never by reading it out. Nothing about the value
        // reaches the note, the config, or any log.
        note(
          notes,
          MigrationCode.PLAINTEXT_SECRET_REMOVED,
          `A plaintext secret was found in wallet.${key} and has been removed. ` +
            "Move it to an encrypted keystore (`gavel identity create`) or a host-provided " +
            "environment variable, then reconnect the wallet in Settings.",
          at,
        );
      }
    }
  }
  if (isPlaintextSecret(document.privateKey) || isPlaintextSecret(document.mnemonic)) {
    note(
      notes,
      MigrationCode.PLAINTEXT_SECRET_REMOVED,
      "A plaintext signing secret was found in the old configuration and has been removed. " +
        "Move it to an encrypted keystore or a host-provided environment variable.",
      at,
    );
  }

  config.identity.address = identityAddress;
  // Migration always lands read-only. Re-attaching a signer is one explicit
  // step in Settings, and that step is where authority is granted.
  config.wallet.type = WalletConnectionType.READ_ONLY;

  // --- execution --------------------------------------------------------
  const legacyMode = document.execution?.mode || document.mode;
  if (legacyMode && Object.values(ExecutionMode).includes(legacyMode)) {
    if (legacyMode === ExecutionMode.UNSIGNED) {
      config.execution.mode = ExecutionMode.UNSIGNED;
    } else {
      // A signing mode cannot survive a migration that produced a read-only
      // wallet. Dropping to unsigned keeps the user's security model intact:
      // nothing that could sign before can sign now without a new decision.
      config.execution.mode = ExecutionMode.UNSIGNED;
      note(
        notes,
        MigrationCode.EXECUTION_MODE_CARRIED,
        `The previous execution mode was "${legacyMode}". Gavel has started in unsigned mode ` +
          "because the wallet must be reconnected first. Re-select the mode in Settings.",
        at,
      );
    }
  }
  const safeAddress = readAddress(document.execution?.safe?.address || document.safe?.address || document.safe);
  if (safeAddress) {
    config.execution.safe = {
      address: safeAddress,
      chainId: Number(document.execution?.safe?.chainId || document.safe?.chainId || 1),
      proposerIdentity: document.execution?.safe?.proposerIdentity || null,
    };
  }

  // --- runtime, inference, privacy, notifications ------------------------
  if (typeof document.dataDir === "string" && document.dataDir.trim() !== "") {
    config.runtime.dataDir = document.dataDir.trim();
  }
  if (typeof document.indexApiUrl === "string") config.runtime.indexApiUrl = document.indexApiUrl;

  config.onboarding.completed = false;
  config.migrationNotes = notes;
  return { config: parseGavelConfig(config), migrated: true, notes };
}

module.exports = { MigrationCode, migrateGavelConfig, needsMigration };
