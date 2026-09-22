/**
 * The client-configuration commands.
 *
 * Everything the TUI's wizard and settings screens configure has to be
 * reachable here, because the CLI is the boundary Hermes, Bankr, OpenClaw,
 * IronClaw, Pi, Claude Code, Codex and OpenCode actually speak. If a setting
 * can only be changed by pressing a key in an Ink component, then the TUI owns
 * configuration semantics -- which is exactly the coupling this package exists
 * to prevent.
 *
 * Every command answers in JSON with `--json`, and every JSON answer goes out
 * through `redactSecrets()`. A runtime can therefore ask "what DAOs are
 * enabled, can Gavel vote, which execution mode applies, is human approval
 * required" and get a machine-readable answer with nothing sensitive in it.
 */

const { parseArgs } = require("node:util");

const {
  ExecutionMode,
  daoCapabilityMatrix,
  getDaoDescriptor,
  getExecutionMode,
  isKnownDao,
  listDaoDescriptors,
  listWalletMethods,
  loadGavelConfig,
  normalizeDaoSelection,
  redactSecrets,
  resolveDaoReadiness,
  resolveRuntimeReadiness,
  resolveSecretAudit,
  saveGavelConfig,
  serializeGavelConfig,
  summarizeGavelReadiness,
  validateGavelConfig,
} = require("@gavel/core");
const { listWiredDaos } = require("@gavel/daos");

function writeJson(document, write = process.stdout.write.bind(process.stdout)) {
  write(`${JSON.stringify(redactSecrets(document), null, 2)}\n`);
}

function flags(argv, options) {
  return parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean", default: false }, ...options } });
}

/** `gavel daos list|capabilities|follow|unfollow` */
async function daosCommand(argv, io = {}) {
  const write = io.write || process.stdout.write.bind(process.stdout);
  const [subcommand = "list", ...rest] = argv;

  if (subcommand === "list") {
    const { values } = flags(rest, {});
    const loaded = await loadGavelConfig(io);
    const rows = listWiredDaos().map((descriptor) => ({
      id: descriptor.id,
      displayName: descriptor.displayName,
      network: descriptor.network,
      chainId: descriptor.chainId,
      status: descriptor.status,
      // `wired` is the honest answer to "can this build actually use it",
      // separate from "does the catalog know about it".
      available: descriptor.wired,
      followed: loaded.config.followedDaos.includes(descriptor.id),
    }));
    if (values.json) return writeJson({ command: "daos.list", daos: rows }, write);
    for (const row of rows) {
      const mark = row.followed ? "[x]" : "[ ]";
      const availability = row.available ? "" : "  (adapter unavailable)";
      write(`${mark} ${row.id.padEnd(12)} ${row.displayName.padEnd(10)} ${row.network}${availability}\n`);
    }
    return undefined;
  }

  if (subcommand === "capabilities") {
    const { values } = flags(rest, { dao: { type: "string" } });
    const ids = values.dao ? [getDaoDescriptor(values.dao).id] : listDaoDescriptors().map((entry) => entry.id);
    const matrix = daoCapabilityMatrix(ids);
    if (values.json) return writeJson({ command: "daos.capabilities", daos: matrix }, write);
    for (const row of matrix) {
      write(`${row.displayName}\n`);
      for (const capability of row.capabilities) {
        write(`  ${capability.supported ? "✓" : "·"} ${capability.capability}\n`);
      }
    }
    return undefined;
  }

  if (subcommand === "follow" || subcommand === "unfollow") {
    const { values, positionals } = flags(rest, {});
    if (positionals.length === 0) throw new Error(`${subcommand} requires at least one DAO id`);
    const loaded = await loadGavelConfig(io);
    const requested = positionals.map((id) => String(id).toLowerCase());
    const unknown = requested.filter((id) => !isKnownDao(id));
    if (unknown.length > 0) throw new Error(`Unknown DAO: ${unknown.join(", ")}`);
    const next =
      subcommand === "follow"
        ? [...loaded.config.followedDaos, ...requested]
        : loaded.config.followedDaos.filter((id) => !requested.includes(id));
    const { selected } = normalizeDaoSelection(next);
    const saved = await saveGavelConfig(
      { ...loaded.config, followedDaos: selected },
      { ...io, dataDir: loaded.dataDir, file: loaded.path },
    );
    if (values.json) return writeJson({ command: `daos.${subcommand}`, followedDaos: saved.config.followedDaos }, write);
    write(`Following: ${saved.config.followedDaos.join(", ") || "(none)"}\n`);
    return undefined;
  }

  throw new Error("daos accepts the subcommands list, capabilities, follow and unfollow");
}

/**
 * `gavel wallet status`
 *
 * Reports the connection *type*, the governance address and the reference to
 * wherever a signer comes from. It never reports a key, a phrase or a session
 * secret, because it never has access to one: the config holds references only.
 */
async function walletCommand(argv, io = {}) {
  const write = io.write || process.stdout.write.bind(process.stdout);
  const [subcommand = "status", ...rest] = argv;
  if (subcommand !== "status") throw new Error("wallet accepts the subcommand status");
  const { values } = flags(rest, {});
  const loaded = await loadGavelConfig(io);
  const wallet = loaded.config.wallet;
  const methods = listWalletMethods({ env: io.env || process.env });
  const document = {
    command: "wallet.status",
    type: wallet.type,
    label: methods.find((method) => method.type === wallet.type)?.label || wallet.type,
    identityAddress: loaded.config.identity.address,
    signerSource:
      wallet.local && { kind: wallet.local.signer, variable: wallet.local.variable, label: wallet.local.keystoreLabel },
    session: wallet.walletconnect?.session
      ? {
          topic: wallet.walletconnect.session.topic,
          account: wallet.walletconnect.session.account,
          chainId: wallet.walletconnect.session.chainId,
          expiresAt: wallet.walletconnect.session.expiresAt,
          expired: wallet.walletconnect.session.expiresAt
            ? Date.parse(wallet.walletconnect.session.expiresAt) <= Date.now()
            : null,
        }
      : null,
    // The roles, named separately. A generic "wallet" field is what made these
    // confusable in the first place.
    roles: {
      governanceIdentity: loaded.config.identity.address,
      safeAddress: loaded.config.execution.safe?.address || null,
      autonomousExecutionAddress: loaded.config.execution.autonomous?.executionAddress || null,
      payoutAddress: loaded.config.execution.payoutAddress || null,
    },
    availableMethods: methods.map((method) => ({ type: method.type, available: method.available, blockers: method.blockers })),
  };
  if (values.json) return writeJson(document, write);
  write(`Wallet        ${document.label}\n`);
  write(`Identity      ${document.identityAddress || "(not set)"}\n`);
  if (document.signerSource) {
    write(`Signer        ${document.signerSource.kind}\n`);
    if (document.signerSource.variable) write(`Variable      ${document.signerSource.variable}\n`);
    if (document.signerSource.label) write(`Keystore      ${document.signerSource.label}\n`);
  }
  if (document.session) write(`Session       ${document.session.expired ? "expired" : "active"}\n`);
  return undefined;
}

/**
 * `gavel readiness`
 *
 * The multi-DAO answer. `canLaunch` is deliberately separate from `level`: one
 * unreachable indexer degrades the client, it does not make Gavel unusable,
 * and a runtime deciding whether to start needs those to be different
 * questions.
 */
async function readinessCommand(argv, io = {}) {
  const write = io.write || process.stdout.write.bind(process.stdout);
  const { values } = flags(argv, {});
  const loaded = await loadGavelConfig(io);
  const { issues } = validateGavelConfig(loaded.config);
  const probe = io.probe || (async () => ({}));

  const runtime = resolveRuntimeReadiness({
    config: loaded.config,
    configIssues: issues,
    dataDir: loaded.dataDir,
    dataDirWritable: io.dataDirWritable,
    walletConnected: io.walletConnected,
    inferenceReachable: io.inferenceReachable,
  });

  const daos = [];
  for (const dao of loaded.config.followedDaos) {
    // Each DAO is probed independently and a thrown probe becomes that DAO's
    // error. One failing indexer must never abort the others.
    let result;
    try {
      result = await probe({ dao, identityAddress: loaded.config.identity.address });
    } catch (error) {
      result = { error: error.message };
    }
    daos.push(
      resolveDaoReadiness({ dao, probe: result, identityAddress: loaded.config.identity.address }),
    );
  }

  const summary = summarizeGavelReadiness({ runtime, daos, config: loaded.config });
  const document = {
    command: "readiness",
    level: summary.level,
    canLaunch: summary.canLaunch,
    executionMode: runtime.executionMode,
    // The question a harness actually asks before acting on a recommendation.
    humanApprovalRequired: getExecutionMode(runtime.executionMode).kind !== "AUTONOMOUS",
    runtime: { level: runtime.level, signals: runtime.signals, reasons: runtime.reasons },
    daos: Object.fromEntries(
      daos.map((dao) => [
        dao.dao,
        { index: dao.signals.index, identity: dao.signals.identity, vote: dao.signals.vote, monitor: dao.monitor, analyze: dao.analyze, reasons: dao.reasons },
      ]),
    ),
    counts: summary.counts,
  };
  if (values.json) return writeJson(document, write);
  write(`Overall       ${document.level}${document.canLaunch ? "" : " (cannot launch)"}\n`);
  write(`Execution     ${document.executionMode}\n`);
  for (const dao of daos) {
    write(`${dao.displayName.padEnd(12)} monitor ${dao.monitor}  analyze ${dao.analyze}  vote ${dao.vote}\n`);
  }
  return undefined;
}

/** `gavel secrets status` -- source and status, never a value. */
async function secretsCommand(argv, io = {}) {
  const write = io.write || process.stdout.write.bind(process.stdout);
  const [subcommand = "status", ...rest] = argv;
  if (subcommand !== "status") throw new Error("secrets accepts the subcommand status");
  const { values } = flags(rest, {});
  const rows = resolveSecretAudit({ env: io.env || process.env });
  if (values.json) return writeJson({ command: "secrets.status", secrets: rows }, write);
  for (const row of rows) {
    write(`${row.variable.padEnd(28)} source: ${row.source.padEnd(12)} status: ${row.status}\n`);
  }
  return undefined;
}

/** `gavel config show|path|migrate` */
async function configCommand(argv, io = {}) {
  const write = io.write || process.stdout.write.bind(process.stdout);
  const [subcommand = "show", ...rest] = argv;
  const { values } = flags(rest, {});
  const loaded = await loadGavelConfig(io);

  if (subcommand === "path") {
    write(`${loaded.path}\n`);
    return undefined;
  }
  if (subcommand === "show") {
    const { issues } = validateGavelConfig(loaded.config);
    const document = {
      command: "config.show",
      path: loaded.path,
      dataDir: loaded.dataDir,
      exists: loaded.exists,
      migrated: loaded.migrated,
      migrationNotes: loaded.notes,
      config: serializeGavelConfig(loaded.config),
      issues,
    };
    if (values.json) return writeJson(document, write);
    write(`Config        ${loaded.path}\n`);
    write(`DAOs          ${loaded.config.followedDaos.join(", ") || "(none)"}\n`);
    write(`Wallet        ${loaded.config.wallet.type}\n`);
    write(`Execution     ${loaded.config.execution.mode}\n`);
    write(`Inference     ${loaded.config.inference.mode}\n`);
    write(`Private data  ${loaded.dataDir}\n`);
    for (const issue of issues) write(`⚠ ${issue.code}: ${issue.message}\n`);
    return undefined;
  }
  if (subcommand === "migrate") {
    const saved = await saveGavelConfig(loaded.config, { ...io, dataDir: loaded.dataDir, file: loaded.path });
    if (values.json) {
      return writeJson(
        { command: "config.migrate", migrated: loaded.migrated, notes: loaded.notes, config: serializeGavelConfig(saved.config) },
        write,
      );
    }
    write(loaded.migrated ? "Configuration migrated.\n" : "Configuration already current.\n");
    for (const note of loaded.notes) write(`  ${note.code}: ${note.message}\n`);
    return undefined;
  }
  throw new Error("config accepts the subcommands show, path and migrate");
}

module.exports = {
  ExecutionMode,
  configCommand,
  daosCommand,
  readinessCommand,
  secretsCommand,
  walletCommand,
};
