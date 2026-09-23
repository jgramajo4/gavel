/**
 * Readiness, per DAO and for the runtime.
 *
 * The old question was "is Gavel ready?", which only has an answer when there
 * is one DAO. With several, readiness is a matrix: the index may be fresh for
 * one DAO and stale for another, and a user may be able to vote in one and
 * only watch another. A single boolean would have to be the AND of all of it,
 * which makes one stale indexer look like a broken application.
 *
 * So readiness is three separable questions, asked per DAO:
 *
 *   monitor   can Gavel see this DAO's proposals?
 *   analyze   can Gavel reason about them?
 *   vote      can this identity actually cast a vote here?
 *
 * They degrade independently. Having no voting power in a DAO is a *fact about
 * the user*, not a failure: `vote` is unavailable, `monitor` and `analyze`
 * stay ready, and the reason is informational. Following a DAO you cannot vote
 * in is a normal, supported way to use a governance client.
 */

const { ExecutionMode } = require("../schema/execution");
const { ExecutionModeKind, getExecutionMode } = require("../execution/modes");
const { WalletConnectionType } = require("../wallet/provider");
const { interactiveExecutionAvailability } = require("../wallet/providers");
const { findDaoDescriptor } = require("../dao/catalog");
const { InferenceMode } = require("../config/schema");
const { resolveIndexApiEndpoint } = require("../config/index-api-endpoint");

const ReadinessLevel = Object.freeze({
  READY: "ready",
  DEGRADED: "degraded",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown",
});

/** How loudly to say it. `info` is a fact, not a problem. */
const ReasonSeverity = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
});

const RANK = Object.freeze({
  [ReadinessLevel.READY]: 0,
  [ReadinessLevel.DEGRADED]: 1,
  [ReadinessLevel.UNKNOWN]: 2,
  [ReadinessLevel.UNAVAILABLE]: 3,
});

function worst(...levels) {
  return levels.reduce((left, right) => (RANK[right] > RANK[left] ? right : left), ReadinessLevel.READY);
}

function reason(code, message, severity = ReasonSeverity.WARNING) {
  return { code, message, severity };
}

/**
 * Runtime readiness: everything that is true regardless of which DAO is in view.
 *
 * Each signal is independent so the UI can say which layer is broken --
 * "config invalid" and "inference unreachable" are different problems with
 * different fixes, and collapsing them into "not ready" helps nobody.
 */
function resolveRuntimeReadiness(input = {}) {
  const { config } = input;
  const signals = {};
  const reasons = [];

  const configIssues = input.configIssues || [];
  signals.config = configIssues.length === 0 ? ReadinessLevel.READY : ReadinessLevel.DEGRADED;
  for (const issue of configIssues) {
    reasons.push(reason(issue.code, issue.message, ReasonSeverity.WARNING));
  }

  let indexEndpoint;
  try {
    const resolved = resolveIndexApiEndpoint(config, input.env || process.env);
    indexEndpoint = resolved.metadata;
    signals.indexEndpoint = ReadinessLevel.READY;
  } catch (error) {
    indexEndpoint = error.metadata || { source: "unknown", variable: null, status: "invalid" };
    signals.indexEndpoint = ReadinessLevel.UNAVAILABLE;
    reasons.push(reason(error.code || "INDEX_API_URL_INVALID", error.message, ReasonSeverity.ERROR));
  }

  if (input.dataDirWritable === true) {
    signals.dataDir = ReadinessLevel.READY;
  } else if (input.dataDirWritable === false) {
    signals.dataDir = ReadinessLevel.UNAVAILABLE;
    reasons.push(
      reason(
        "DATA_DIR_UNWRITABLE",
        `Gavel cannot write to its private data directory (${input.dataDir || "GAVEL_DATA_DIR"}). ` +
          "Preferences and local history cannot be saved.",
        ReasonSeverity.ERROR,
      ),
    );
  } else {
    signals.dataDir = ReadinessLevel.UNKNOWN;
  }

  const inferenceMode = config?.inference?.mode || InferenceMode.LOCAL;
  if (inferenceMode === InferenceMode.LOCAL) {
    // The precedent engine runs in-process and has nothing to reach.
    signals.inference = ReadinessLevel.READY;
  } else if (input.inferenceReachable === false) {
    signals.inference = ReadinessLevel.DEGRADED;
    reasons.push(
      reason(
        "INFERENCE_UNREACHABLE",
        `Configured ${inferenceMode} inference is unreachable. Recommendations fall back to local precedents.`,
        ReasonSeverity.WARNING,
      ),
    );
  } else {
    signals.inference = input.inferenceReachable === true ? ReadinessLevel.READY : ReadinessLevel.UNKNOWN;
  }

  const walletType = config?.wallet?.type || WalletConnectionType.READ_ONLY;
  if (walletType === WalletConnectionType.READ_ONLY) {
    // Fully supported, not degraded. Gavel monitors, analyzes and prepares.
    signals.wallet = ReadinessLevel.READY;
    reasons.push(
      reason("WALLET_READ_ONLY", "Read-only: Gavel prepares votes but will not sign or broadcast.", ReasonSeverity.INFO),
    );
  } else if (input.walletConnected === false) {
    signals.wallet = ReadinessLevel.DEGRADED;
    reasons.push(
      reason(
        "WALLET_DISCONNECTED",
        walletType === WalletConnectionType.WALLET_CONNECT
          ? "The WalletConnect session is not active. Reconnect to sign."
          : "The local signer is not available. Gavel can still monitor and prepare.",
        ReasonSeverity.WARNING,
      ),
    );
  } else {
    signals.wallet = input.walletConnected === true ? ReadinessLevel.READY : ReadinessLevel.UNKNOWN;
  }

  const mode = config?.execution?.mode || ExecutionMode.UNSIGNED;
  let executionLevel = ReadinessLevel.READY;
  // Fail-safe: a mode this build does not recognize is treated as requiring a
  // human, never as autonomous. Computed here, beside the lookup that can
  // throw, so no caller has to repeat it -- repeating it is how a guarded
  // lookup becomes an unguarded one somewhere else.
  let humanApprovalRequired = true;
  const interactive = input.interactive || interactiveExecutionAvailability();
  try {
    const definition = getExecutionMode(mode);
    humanApprovalRequired = definition.kind !== ExecutionModeKind.AUTONOMOUS;
    if (!definition.implemented) {
      executionLevel = ReadinessLevel.UNAVAILABLE;
      reasons.push(reason("EXECUTION_MODE_UNIMPLEMENTED", `Execution mode ${mode} is not implemented.`, ReasonSeverity.ERROR));
    } else if (mode === ExecutionMode.EOA_SUPERVISED && !interactive.available) {
      // Readiness reports what this build can actually submit, not what the
      // config asked for. Saying "ready" here and failing at submit time is
      // the mismatch this check exists to remove.
      executionLevel = ReadinessLevel.UNAVAILABLE;
      reasons.push(reason("EXECUTION_INTERACTIVE_UNAVAILABLE", interactive.reason, ReasonSeverity.ERROR));
    } else if (
      definition.kind !== ExecutionModeKind.OFFLINE &&
      walletType === WalletConnectionType.READ_ONLY &&
      mode === ExecutionMode.EOA_SUPERVISED
    ) {
      executionLevel = ReadinessLevel.UNAVAILABLE;
      reasons.push(
        reason("EXECUTION_NEEDS_WALLET", "Interactive approval needs a connected wallet.", ReasonSeverity.ERROR),
      );
    } else if (mode === ExecutionMode.WAAP_AUTONOMOUS && !config?.execution?.autonomous?.acknowledgedAt) {
      executionLevel = ReadinessLevel.UNAVAILABLE;
      reasons.push(
        reason(
          "AUTONOMOUS_NOT_ACKNOWLEDGED",
          "Autonomous execution has not been explicitly enabled. Credentials alone never enable it.",
          ReasonSeverity.ERROR,
        ),
      );
    }
  } catch (error) {
    executionLevel = ReadinessLevel.UNAVAILABLE;
    reasons.push(reason("EXECUTION_MODE_UNKNOWN", error.message, ReasonSeverity.ERROR));
  }
  signals.execution = executionLevel;

  return {
    level: worst(...Object.values(signals)),
    signals,
    reasons,
    indexEndpoint,
    executionMode: mode,
    humanApprovalRequired,
    interactiveAvailable: interactive.available,
    walletType,
  };
}

/**
 * Per-DAO readiness from a probe result.
 *
 * The probe is injected rather than performed here: core must not reach an
 * adapter or the network, and a caller that already has a live adapter should
 * not have to build a second one. A probe that threw is passed in as `error`,
 * which is what keeps one unreachable indexer from taking the process down.
 */
function resolveDaoReadiness(input = {}) {
  const dao = String(input.dao || "");
  const descriptor = findDaoDescriptor(dao);
  // A followed DAO this build does not know -- a hand-edited config, a
  // catalog change across an upgrade, a removed adapter -- is a fact to
  // report, not a crash. It stays in the list, visibly unavailable, so the
  // healthy DAOs beside it are still answered and the user can see what to
  // fix. It is never silently dropped and never reinterpreted as another DAO.
  if (!descriptor) {
    return {
      dao,
      displayName: dao,
      chainId: null,
      known: false,
      signals: {
        index: ReadinessLevel.UNAVAILABLE,
        identity: ReadinessLevel.UNAVAILABLE,
        vote: ReadinessLevel.UNAVAILABLE,
      },
      monitor: ReadinessLevel.UNAVAILABLE,
      analyze: ReadinessLevel.UNAVAILABLE,
      vote: ReadinessLevel.UNAVAILABLE,
      votingPower: null,
      votingPowerLabel: "Voting power",
      delegation: null,
      delegationLabel: "Delegation",
      usable: false,
      level: ReadinessLevel.UNAVAILABLE,
      reasons: [
        reason(
          "UNKNOWN_DAO",
          `${dao} is followed but is not supported by this build. Remove it with ` +
            `\`gavel daos unfollow ${dao}\`, or upgrade to a build that supports it.`,
          ReasonSeverity.ERROR,
        ),
      ],
    };
  }
  const probe = input.probe || {};
  const reasons = [];

  let index = ReadinessLevel.UNKNOWN;
  if (probe.error) {
    index = ReadinessLevel.UNAVAILABLE;
    reasons.push(
      reason(
        "INDEX_UNAVAILABLE",
        `${descriptor.displayName} indexer unavailable: ${probe.error}`,
        ReasonSeverity.ERROR,
      ),
    );
  } else if (probe.indexFresh === true) {
    index = ReadinessLevel.READY;
  } else if (probe.indexFresh === false) {
    index = ReadinessLevel.DEGRADED;
    reasons.push(
      reason(
        "INDEX_STALE",
        `${descriptor.displayName} proposal data is stale. Shown proposals may be out of date.`,
        ReasonSeverity.WARNING,
      ),
    );
  }

  let identity = ReadinessLevel.UNKNOWN;
  if (!input.identityAddress) {
    identity = ReadinessLevel.UNAVAILABLE;
    reasons.push(
      reason("IDENTITY_UNSET", "No governance identity is configured.", ReasonSeverity.INFO),
    );
  } else if (probe.identityResolved === false) {
    identity = ReadinessLevel.DEGRADED;
    reasons.push(
      reason(
        "IDENTITY_UNRESOLVED",
        `${descriptor.displayName} state for this identity could not be read.`,
        ReasonSeverity.WARNING,
      ),
    );
  } else {
    identity = ReadinessLevel.READY;
  }

  // Voting. Three separate facts, deliberately not merged:
  //   the DAO supports voting at all,
  //   this identity has power,
  //   the DAO's delegation requirement (where it has one) is satisfied.
  let vote = ReadinessLevel.UNKNOWN;
  if (descriptor.capabilities.voting !== true) {
    vote = ReadinessLevel.UNAVAILABLE;
    reasons.push(reason("VOTING_UNSUPPORTED", `${descriptor.displayName} voting is not supported yet.`, ReasonSeverity.INFO));
  } else if (identity === ReadinessLevel.UNAVAILABLE) {
    vote = ReadinessLevel.UNAVAILABLE;
  } else if (probe.votingPower != null && BigInt(probe.votingPower) === 0n) {
    // Not an error. Following a DAO you hold no stake in is normal.
    vote = ReadinessLevel.UNAVAILABLE;
    reasons.push(
      reason(
        "NO_VOTING_POWER",
        `This identity has no ${descriptor.terminology.votingPower.toLowerCase()} in ${descriptor.displayName}. ` +
          "You can still follow and analyze its proposals.",
        ReasonSeverity.INFO,
      ),
    );
  } else if (descriptor.capabilities.delegation === true && probe.delegationReady === false) {
    vote = ReadinessLevel.DEGRADED;
    reasons.push(
      reason(
        "DELEGATION_REQUIRED",
        `${descriptor.displayName} ${descriptor.terminology.delegation.toLowerCase()} does not point at the voting address. ` +
          "Gavel will not change it on its own.",
        ReasonSeverity.WARNING,
      ),
    );
  } else if (probe.votingPower != null) {
    vote = ReadinessLevel.READY;
  }

  const monitor = descriptor.capabilities.proposals === true ? index : ReadinessLevel.UNAVAILABLE;
  // Analysis reads indexed proposals plus local history: a stale index still
  // supports it, an unreachable one does not.
  const analyze =
    descriptor.capabilities.analyze === true
      ? index === ReadinessLevel.UNAVAILABLE
        ? ReadinessLevel.UNAVAILABLE
        : ReadinessLevel.READY
      : ReadinessLevel.UNAVAILABLE;

  return {
    dao: descriptor.id,
    displayName: descriptor.displayName,
    chainId: descriptor.chainId,
    known: true,
    signals: { index, identity, vote },
    monitor,
    analyze,
    vote,
    votingPower: probe.votingPower != null ? String(probe.votingPower) : null,
    votingPowerLabel: descriptor.terminology.votingPower,
    delegation: probe.delegateAddress || null,
    delegationLabel: descriptor.terminology.delegation,
    // `usable` is the question the launch path asks: can the user do anything
    // at all with this DAO? Voting is not part of it.
    usable: monitor !== ReadinessLevel.UNAVAILABLE,
    level: worst(monitor, analyze),
    reasons,
  };
}

/**
 * The whole picture.
 *
 * `canLaunch` is deliberately generous: the app opens whenever the runtime
 * works, even if every followed DAO is down, because the settings screen and
 * the DAO list are exactly what a user needs at that moment. The only thing
 * that stops Gavel launching is a runtime that cannot function.
 */
function summarizeGavelReadiness(input = {}) {
  const runtime = input.runtime || resolveRuntimeReadiness({ config: input.config });
  const daos = input.daos || [];
  const usable = daos.filter((dao) => dao.usable);
  const votable = daos.filter((dao) => dao.vote === ReadinessLevel.READY);
  const unavailable = daos.filter((dao) => !dao.usable);

  const level =
    runtime.signals.dataDir === ReadinessLevel.UNAVAILABLE
      ? ReadinessLevel.UNAVAILABLE
      : daos.length === 0
        ? runtime.level
        : unavailable.length === 0
          ? worst(runtime.level, ...daos.map((dao) => dao.level))
          : // One DAO down is a degraded client, never an unavailable one.
            worst(runtime.level, ReadinessLevel.DEGRADED);

  return {
    level,
    canLaunch: runtime.signals.dataDir !== ReadinessLevel.UNAVAILABLE && runtime.signals.config !== ReadinessLevel.UNAVAILABLE,
    runtime,
    daos,
    counts: {
      followed: daos.length,
      monitorable: usable.length,
      votable: votable.length,
      unavailable: unavailable.length,
    },
  };
}

/** `nouns  monitor ready  analyze ready  vote unavailable`. One DAO, one line. */
function formatDaoReadinessLine(dao) {
  const name = findDaoDescriptor(dao.dao)?.displayName || dao.dao;
  return `${name.padEnd(10)} monitor ${dao.monitor}  analyze ${dao.analyze}  vote ${dao.vote}`;
}

module.exports = {
  ReadinessLevel,
  ReasonSeverity,
  formatDaoReadinessLine,
  resolveDaoReadiness,
  resolveRuntimeReadiness,
  summarizeGavelReadiness,
};
