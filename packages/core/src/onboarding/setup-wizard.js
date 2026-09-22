/**
 * The setup wizard, as a state machine rather than a stack of screens.
 *
 * The TUI renders it and owns none of it. That matters for two reasons:
 * the same flow has to be reachable from the CLI for headless runtimes, and
 * the step logic -- which execution modes a given wallet can offer, whether a
 * DAO can be followed, what the review page says -- is configuration
 * semantics, which belong beside the config model and not inside a component.
 *
 * Eleven steps, of which most users touch four. Defaults are real defaults:
 * read-only wallet, unsigned execution, local inference, direct networking,
 * all DAOs unselected. A user who presses Enter through the whole wizard ends
 * up with a working, safe, monitoring-only Gavel.
 *
 * Nothing here can produce a config containing a secret. Every step writes
 * references -- a variable name, a keystore label, a session topic -- and the
 * review step renders through the same redaction as everything else.
 */

const { getAddress } = require("ethers");

const { ExecutionMode } = require("../schema/execution");
const { getExecutionMode, listExecutionModes } = require("../execution/modes");
const { WalletConnectionType } = require("../wallet/provider");
const { listWalletMethods } = require("../wallet/providers");
const { daoSupports, getDaoDescriptor, listDaoDescriptors, normalizeDaoSelection } = require("../dao/catalog");
const { InferenceMode, NetworkMode, IMPLEMENTED_NETWORK_MODES, validateGavelConfig } = require("../config/schema");
const { resolveSecretAudit } = require("../config/secrets");
const { defaultGavelConfig, parseGavelConfig } = require("../config/schema");
const { redactSecrets } = require("../config/secrets");

const SetupStep = Object.freeze({
  WELCOME: "welcome",
  DATA_DIR: "data-dir",
  DAOS: "daos",
  WALLET: "wallet",
  VERIFY: "verify",
  EXECUTION: "execution",
  INFERENCE: "inference",
  PRIVACY: "privacy",
  NOTIFICATIONS: "notifications",
  REVIEW: "review",
  FINISH: "finish",
});

/**
 * Step metadata. `advisory` steps never block Next -- they present state the
 * user should see (verification results, the review) rather than collecting a
 * decision, and a DAO being down must not trap someone in the wizard.
 */
const SETUP_STEPS = Object.freeze([
  Object.freeze({
    id: SetupStep.WELCOME,
    title: "Welcome",
    summary:
      "Gavel follows governance across the DAOs you choose, recommends how to vote using local or configured inference, and leaves signing to the wallet you pick.",
    advisory: true,
  }),
  Object.freeze({
    id: SetupStep.DATA_DIR,
    title: "Private data",
    summary: "Where Gavel keeps your preferences, followed DAOs and local governance history.",
  }),
  Object.freeze({ id: SetupStep.DAOS, title: "Follow DAOs", summary: "Pick the governance systems you care about." }),
  Object.freeze({ id: SetupStep.WALLET, title: "Connect wallet", summary: "How you want to control signing, if at all." }),
  Object.freeze({
    id: SetupStep.VERIFY,
    title: "Check DAOs",
    summary: "What Gavel can see for your identity in each followed DAO.",
    advisory: true,
  }),
  Object.freeze({ id: SetupStep.EXECUTION, title: "Execution", summary: "What Gavel may do once it has a recommendation." }),
  Object.freeze({ id: SetupStep.INFERENCE, title: "Recommendations", summary: "Where recommendations are computed." }),
  Object.freeze({ id: SetupStep.PRIVACY, title: "Privacy", summary: "How Gavel reaches the network." }),
  Object.freeze({ id: SetupStep.NOTIFICATIONS, title: "Alerts", summary: "What Gavel tells you about, across every followed DAO." }),
  Object.freeze({ id: SetupStep.REVIEW, title: "Review", summary: "Everything you chose. No secrets are shown or stored.", advisory: true }),
  Object.freeze({ id: SetupStep.FINISH, title: "Finish", summary: "Open Gavel.", advisory: true }),
]);

const STEP_IDS = Object.freeze(SETUP_STEPS.map((step) => step.id));

/** What the data-directory step explains. Written once, shown verbatim. */
const DATA_DIR_CONTENTS = Object.freeze({
  stored: Object.freeze([
    "your preferences and followed DAOs",
    "your local governance profile and voting history",
    "recommendation history and local workflow state",
    "cached proposal metadata",
  ]),
  notStored: Object.freeze([
    "seed phrases",
    "private keys",
    "API keys or provider credentials",
    "WalletConnect session secrets",
  ]),
});

/**
 * Which execution modes this setup can actually offer.
 *
 * Unavailable modes are returned with a reason rather than filtered out: a
 * missing "Safe-supervised" option looks like Gavel does not support Safes,
 * while a disabled one with "no followed DAO supports Safe execution" is an
 * explanation. The wizard refuses to *select* an unavailable one.
 */
function listExecutionOptions(input = {}) {
  const walletType = input.walletType || WalletConnectionType.READ_ONLY;
  const followedDaos = input.followedDaos || [];
  const canSign = walletType !== WalletConnectionType.READ_ONLY;

  return listExecutionModes()
    .filter((mode) => mode.implemented)
    .map((mode) => {
      const blockers = [];
      if (mode.mode === ExecutionMode.EOA_SUPERVISED && !canSign) {
        blockers.push("Connect a wallet to approve votes interactively.");
      }
      if (mode.capability !== "prepareVote") {
        const supporting = followedDaos.filter((dao) => daoSupports(dao, mode.capability));
        if (followedDaos.length > 0 && supporting.length === 0) {
          blockers.push(
            `None of your followed DAOs support ${mode.mode} execution.`,
          );
        }
      }
      if (mode.mode === ExecutionMode.WAAP_AUTONOMOUS && input.autonomousAcknowledged !== true) {
        // Never offered as a one-keystroke choice. Selecting it requires the
        // acknowledgement the config schema then enforces.
        blockers.push("Autonomous execution requires explicit setup and acknowledgement.");
      }
      return {
        mode: mode.mode,
        kind: mode.kind,
        label:
          {
            [ExecutionMode.UNSIGNED]: "Prepare only",
            [ExecutionMode.EOA_SUPERVISED]: "Interactive approval",
            [ExecutionMode.SAFE_SUPERVISED]: "Safe-supervised",
            [ExecutionMode.WAAP_AUTONOMOUS]: "Autonomous",
          }[mode.mode] || mode.mode,
        description: mode.description,
        available: blockers.length === 0,
        blockers,
        supportedDaos: followedDaos.filter(
          (dao) => mode.capability === "prepareVote" || daoSupports(dao, mode.capability),
        ),
      };
    });
}

function listInferenceOptions() {
  return [
    {
      mode: InferenceMode.LOCAL,
      label: "Local",
      description: "Gavel's own precedent engine, in this process. Nothing leaves the machine.",
      available: true,
      blockers: [],
    },
    {
      mode: InferenceMode.REMOTE,
      label: "Remote provider",
      description: "A configured scoring endpoint. Proposal text is sent to it.",
      available: true,
      blockers: [],
    },
    {
      mode: InferenceMode.RUNTIME,
      label: "Runtime-provided",
      description: "The host harness supplies inference (Claude Code, Hermes, Bankr, ...).",
      available: true,
      blockers: [],
    },
  ];
}

function listNetworkOptions() {
  return Object.values(NetworkMode).map((network) => ({
    network,
    label: { [NetworkMode.DIRECT]: "Direct", [NetworkMode.TOR]: "Tor", [NetworkMode.NYM]: "Nym" }[network],
    available: IMPLEMENTED_NETWORK_MODES.includes(network),
    blockers: IMPLEMENTED_NETWORK_MODES.includes(network) ? [] : ["Not implemented in this build."],
  }));
}

function issue(code, message) {
  return { code, message };
}

/**
 * The wizard.
 *
 * Holds a draft config and a cursor. `apply()` is the only way to change the
 * draft, so every mutation goes through one validation path, and `next()`
 * cannot advance past a step whose answer would not validate.
 */
class SetupWizard {
  #steps;

  constructor(options = {}) {
    this.env = options.env || process.env;
    this.draft = parseGavelConfig(options.config || defaultGavelConfig());
    this.#steps = SETUP_STEPS;
    // Resume where the user left off, if the recorded step still exists.
    const resumeAt = options.step || this.draft.onboarding.lastStep;
    const index = STEP_IDS.indexOf(resumeAt);
    this.index = index >= 0 ? index : 0;
    this.walletMethods = options.walletMethods || listWalletMethods({ env: this.env, ...options.walletContext });
    // Verification results, injected: probing a DAO is a network operation and
    // the wizard is pure.
    this.verification = options.verification || [];
    this.now = options.now || (() => new Date());
  }

  get steps() {
    return this.#steps;
  }

  get step() {
    return this.#steps[this.index];
  }

  get stepId() {
    return this.step.id;
  }

  get isFirst() {
    return this.index === 0;
  }

  get isLast() {
    return this.index === this.#steps.length - 1;
  }

  /** What the current step needs to render. One switch, in one place. */
  options() {
    switch (this.stepId) {
      case SetupStep.DATA_DIR:
        return { dataDir: this.draft.runtime.dataDir, contents: DATA_DIR_CONTENTS };
      case SetupStep.DAOS:
        return {
          daos: listDaoDescriptors().map((descriptor) => ({
            id: descriptor.id,
            displayName: descriptor.displayName,
            network: descriptor.network,
            summary: descriptor.summary,
            selected: this.draft.followedDaos.includes(descriptor.id),
            available: descriptor.status === "supported",
          })),
          selected: this.draft.followedDaos,
        };
      case SetupStep.WALLET:
        return { methods: this.walletMethods, selected: this.draft.wallet.type };
      case SetupStep.VERIFY:
        return { results: this.verification, identity: this.draft.identity.address };
      case SetupStep.EXECUTION:
        return {
          modes: listExecutionOptions({
            walletType: this.draft.wallet.type,
            followedDaos: this.draft.followedDaos,
            autonomousAcknowledged: Boolean(this.draft.execution.autonomous?.acknowledgedAt),
          }),
          selected: this.draft.execution.mode,
        };
      case SetupStep.INFERENCE:
        return { modes: listInferenceOptions(), selected: this.draft.inference.mode };
      case SetupStep.PRIVACY:
        return { networks: listNetworkOptions(), selected: this.draft.privacy.network };
      case SetupStep.NOTIFICATIONS:
        return {
          settings: this.draft.notifications,
          // Calendar reminders are offered only when a followed DAO can supply
          // a calendar. Nothing currently can, so the option stays hidden
          // rather than being a switch that does nothing.
          calendarAvailable: this.draft.followedDaos.some((dao) => daoSupports(dao, "calendar")),
        };
      case SetupStep.REVIEW:
        return this.review();
      default:
        return {};
    }
  }

  /**
   * Apply an answer to a step. Returns `{ ok, issues }` and mutates nothing on
   * failure, so a rejected answer leaves the draft exactly as it was.
   */
  apply(stepId, value) {
    const issues = [];
    const draft = structuredClone(this.draft);

    switch (stepId) {
      case SetupStep.DATA_DIR: {
        const dataDir = typeof value?.dataDir === "string" ? value.dataDir.trim() : "";
        draft.runtime.dataDir = dataDir === "" ? null : dataDir;
        break;
      }
      case SetupStep.DAOS: {
        const { selected, unknown } = normalizeDaoSelection(value?.daos || []);
        for (const id of unknown) issues.push(issue("UNKNOWN_DAO", `Unknown DAO: ${id}`));
        draft.followedDaos = selected;
        // Dropping a DAO can invalidate the execution mode that depended on it.
        const stillSupported = listExecutionOptions({
          walletType: draft.wallet.type,
          followedDaos: selected,
          autonomousAcknowledged: Boolean(draft.execution.autonomous?.acknowledgedAt),
        }).find((option) => option.mode === draft.execution.mode);
        if (stillSupported && !stillSupported.available) draft.execution.mode = ExecutionMode.UNSIGNED;
        break;
      }
      case SetupStep.WALLET: {
        const type = value?.type;
        const method = this.walletMethods.find((entry) => entry.type === type);
        if (!method) {
          issues.push(issue("UNKNOWN_WALLET_METHOD", `Unknown wallet method: ${type}`));
          break;
        }
        if (!method.available) {
          issues.push(issue("WALLET_METHOD_UNAVAILABLE", method.blockers[0] || `${method.label} is unavailable.`));
          break;
        }
        draft.wallet.type = type;
        draft.wallet.local = null;
        draft.wallet.walletconnect = null;
        if (type === WalletConnectionType.LOCAL) {
          const signer = value?.signer === "environment" ? "environment" : "keystore";
          draft.wallet.local = {
            signer,
            keystoreLabel: signer === "keystore" ? value?.keystoreLabel || null : null,
            variable: signer === "environment" ? value?.variable || "GAVEL_PRIVATE_KEY" : null,
          };
        }
        if (type === WalletConnectionType.WALLET_CONNECT) {
          draft.wallet.walletconnect = {
            projectIdVariable: value?.projectIdVariable || "WALLETCONNECT_PROJECT_ID",
            // Only the safe fields. A transport's full session object never
            // reaches config.
            session: value?.session
              ? {
                  topic: value.session.topic || null,
                  account: value.session.account ? getAddress(value.session.account) : null,
                  chainId: value.session.chainId ?? null,
                  expiresAt: value.session.expiresAt || null,
                }
              : null,
          };
        }
        if (value?.address) {
          try {
            draft.identity.address = getAddress(value.address);
          } catch {
            issues.push(issue("INVALID_ADDRESS", "That is not a valid Ethereum address."));
          }
        }
        // A wallet change can make the current execution mode impossible.
        const option = listExecutionOptions({
          walletType: draft.wallet.type,
          followedDaos: draft.followedDaos,
          autonomousAcknowledged: Boolean(draft.execution.autonomous?.acknowledgedAt),
        }).find((entry) => entry.mode === draft.execution.mode);
        if (option && !option.available) draft.execution.mode = ExecutionMode.UNSIGNED;
        break;
      }
      case SetupStep.EXECUTION: {
        const mode = value?.mode;
        const option = listExecutionOptions({
          walletType: draft.wallet.type,
          followedDaos: draft.followedDaos,
          autonomousAcknowledged: value?.acknowledgeAutonomous === true,
        }).find((entry) => entry.mode === mode);
        if (!option) {
          issues.push(issue("UNKNOWN_EXECUTION_MODE", `Unknown execution mode: ${mode}`));
          break;
        }
        if (!option.available) {
          issues.push(issue("EXECUTION_MODE_UNAVAILABLE", option.blockers[0] || `${option.label} is unavailable.`));
          break;
        }
        draft.execution.mode = mode;
        if (mode === ExecutionMode.SAFE_SUPERVISED) {
          if (!value?.safeAddress) {
            issues.push(issue("SAFE_ADDRESS_REQUIRED", "Safe-supervised execution needs the Safe address."));
            break;
          }
          draft.execution.safe = {
            address: getAddress(value.safeAddress),
            chainId: Number(value.chainId || 1),
            proposerIdentity: value.proposerIdentity || null,
          };
        }
        if (mode === ExecutionMode.WAAP_AUTONOMOUS) {
          if (!value?.executionAddress) {
            issues.push(issue("EXECUTION_ADDRESS_REQUIRED", "Autonomous execution needs its own execution wallet."));
            break;
          }
          const executionAddress = getAddress(value.executionAddress);
          if (draft.identity.address && executionAddress === getAddress(draft.identity.address)) {
            // Separate roles, separate keys. The engine enforces this too; the
            // wizard refuses it earlier so the mistake is never configured.
            issues.push(
              issue(
                "AUTONOMOUS_ADDRESS_NOT_SEPARATE",
                "The autonomous execution wallet must be a different address from your governance identity.",
              ),
            );
            break;
          }
          draft.execution.autonomous = {
            executionAddress,
            policyId: value.policyId || null,
            acknowledgedAt: this.now().toISOString(),
          };
        }
        // Switching modes never touches delegation. If a DAO needs a
        // delegation change, that is a separate, explicit transaction.
        break;
      }
      case SetupStep.INFERENCE: {
        const mode = value?.mode;
        if (!Object.values(InferenceMode).includes(mode)) {
          issues.push(issue("UNKNOWN_INFERENCE_MODE", `Unknown inference mode: ${mode}`));
          break;
        }
        draft.inference.mode = mode;
        draft.inference.endpointVariable =
          mode === InferenceMode.REMOTE ? value?.endpointVariable || "PREDICTION_URL" : null;
        break;
      }
      case SetupStep.PRIVACY: {
        const network = value?.network;
        const option = listNetworkOptions().find((entry) => entry.network === network);
        if (!option) {
          issues.push(issue("UNKNOWN_NETWORK_MODE", `Unknown network mode: ${network}`));
          break;
        }
        if (!option.available) {
          issues.push(issue("NETWORK_MODE_UNIMPLEMENTED", option.blockers[0]));
          break;
        }
        draft.privacy.network = network;
        break;
      }
      case SetupStep.NOTIFICATIONS: {
        draft.notifications = {
          proposalAlerts: value?.proposalAlerts ?? draft.notifications.proposalAlerts,
          dailyBriefing: value?.dailyBriefing ?? draft.notifications.dailyBriefing,
          executionAlerts: value?.executionAlerts ?? draft.notifications.executionAlerts,
          calendarReminders:
            this.draft.followedDaos.some((dao) => daoSupports(dao, "calendar")) &&
            (value?.calendarReminders ?? draft.notifications.calendarReminders),
        };
        break;
      }
      default:
        break;
    }

    if (issues.length > 0) return { ok: false, issues, config: this.draft };
    draft.onboarding.lastStep = this.stepId;
    this.draft = parseGavelConfig(draft);
    return { ok: true, issues: [], config: this.draft };
  }

  /** Blocking problems with the *current* step, if any. */
  blockers() {
    if (this.step.advisory) return [];
    if (this.stepId === SetupStep.DAOS && this.draft.followedDaos.length === 0) {
      return [issue("NO_DAOS_SELECTED", "Choose at least one DAO to follow.")];
    }
    const { issues } = validateGavelConfig(this.draft);
    // Only issues the current step is responsible for should block it.
    const owned = {
      [SetupStep.WALLET]: /^WALLET_/,
      [SetupStep.EXECUTION]: /^(SAFE_|AUTONOMOUS_|EXECUTION_)/,
      [SetupStep.INFERENCE]: /^INFERENCE_/,
      [SetupStep.PRIVACY]: /^NETWORK_/,
    }[this.stepId];
    return owned ? issues.filter((entry) => owned.test(entry.code)) : [];
  }

  canAdvance() {
    return this.blockers().length === 0;
  }

  next() {
    const blockers = this.blockers();
    if (blockers.length > 0) return { ok: false, issues: blockers, step: this.step };
    if (!this.isLast) this.index += 1;
    this.draft.onboarding.lastStep = this.stepId;
    return { ok: true, issues: [], step: this.step };
  }

  back() {
    if (!this.isFirst) this.index -= 1;
    this.draft.onboarding.lastStep = this.stepId;
    return { ok: true, step: this.step };
  }

  goto(stepId) {
    const index = STEP_IDS.indexOf(stepId);
    if (index < 0) throw new Error(`Unknown setup step: ${stepId}`);
    this.index = index;
    this.draft.onboarding.lastStep = this.stepId;
    return this.step;
  }

  /**
   * The review page.
   *
   * Assembled from the draft and the secret *audit*, then passed through
   * redaction on the way out. Three independent reasons a value cannot appear
   * here: it is not in the config, the audit returns status not value, and
   * redaction runs anyway.
   */
  review() {
    const { issues } = validateGavelConfig(this.draft);
    const wallet = this.draft.wallet;
    const executionOption = listExecutionOptions({
      walletType: wallet.type,
      followedDaos: this.draft.followedDaos,
      autonomousAcknowledged: Boolean(this.draft.execution.autonomous?.acknowledgedAt),
    }).find((entry) => entry.mode === this.draft.execution.mode);

    const daos = listDaoDescriptors()
      .map((descriptor) => {
        const followed = this.draft.followedDaos.includes(descriptor.id);
        const verified = this.verification.find((entry) => entry.dao === descriptor.id);
        return {
          id: descriptor.id,
          displayName: descriptor.displayName,
          followed,
          status: !followed ? "Not selected" : verified ? verified.level : "Unchecked",
          reasons: followed && verified ? verified.reasons : [],
        };
      });

    return redactSecrets({
      daos,
      wallet: {
        type: wallet.type,
        label: this.walletMethods.find((method) => method.type === wallet.type)?.label || wallet.type,
        address: this.draft.identity.address,
        // References only.
        signerSource:
          wallet.type === WalletConnectionType.LOCAL
            ? { kind: wallet.local?.signer || null, variable: wallet.local?.variable || null, label: wallet.local?.keystoreLabel || null }
            : null,
        session: wallet.walletconnect?.session
          ? { topic: wallet.walletconnect.session.topic, chainId: wallet.walletconnect.session.chainId, expiresAt: wallet.walletconnect.session.expiresAt }
          : null,
      },
      execution: {
        mode: this.draft.execution.mode,
        label: executionOption?.label || this.draft.execution.mode,
        safeAddress: this.draft.execution.safe?.address || null,
        autonomousAddress: this.draft.execution.autonomous?.executionAddress || null,
        payoutAddress: this.draft.execution.payoutAddress || null,
      },
      inference: { mode: this.draft.inference.mode },
      privacy: { network: this.draft.privacy.network },
      notifications: this.draft.notifications,
      privateData: { dataDir: this.draft.runtime.dataDir, contents: DATA_DIR_CONTENTS },
      secrets: resolveSecretAudit({ env: this.env }),
      issues,
      overall: issues.length === 0 ? "Ready" : "Needs attention",
    });
  }

  /** Mark onboarding complete and hand back the config to persist. */
  finish() {
    const { issues } = validateGavelConfig(this.draft);
    if (issues.length > 0) return { ok: false, issues, config: this.draft };
    this.draft = parseGavelConfig({
      ...this.draft,
      onboarding: { completed: true, completedAt: this.now().toISOString(), lastStep: SetupStep.FINISH },
    });
    return { ok: true, issues: [], config: this.draft };
  }
}

function createSetupWizard(options) {
  return new SetupWizard(options);
}

module.exports = {
  DATA_DIR_CONTENTS,
  SETUP_STEPS,
  STEP_IDS,
  SetupStep,
  SetupWizard,
  createSetupWizard,
  listExecutionOptions,
  listInferenceOptions,
  listNetworkOptions,
};
