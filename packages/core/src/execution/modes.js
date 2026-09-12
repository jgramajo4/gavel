/**
 * The execution mode registry.
 *
 * Modes are data, not a branch. The previous `capabilityForMode()` was an
 * if-chain over Safe and WaaP, which shaped the architecture around exactly the
 * two providers that happened to exist. A registry lets a new backend be added
 * by declaring it -- and lets modes be declared before they are implemented, so
 * nothing has to be restructured when one lands.
 *
 * A declared-but-unimplemented mode fails closed twice over: an adapter has to
 * opt in through its `capabilities`, and the engine refuses a mode with no
 * registered execution adapter.
 */

const { ExecutionMode } = require("../schema/execution");

/**
 * Who authorizes an action in this mode.
 *
 *   OFFLINE     nothing is submitted anywhere; Gavel hands back calldata.
 *   SUPERVISED  a human authorizes after Gavel proposes. Gavel cannot complete
 *               the action alone, by construction.
 *   AUTONOMOUS  a policy authorizes and Gavel completes the action.
 */
const ExecutionModeKind = Object.freeze({
  OFFLINE: "OFFLINE",
  SUPERVISED: "SUPERVISED",
  AUTONOMOUS: "AUTONOMOUS",
});

const modes = new Map();

function registerExecutionMode(definition) {
  const mode = String(definition?.mode || "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(mode)) throw new TypeError("An execution mode id is required");
  if (!Object.values(ExecutionModeKind).includes(definition.kind)) {
    throw new TypeError(`Execution mode ${mode} needs a kind`);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(definition.capability || "")) {
    throw new TypeError(`Execution mode ${mode} needs a DAO adapter capability key`);
  }
  const entry = Object.freeze({
    mode,
    kind: definition.kind,
    capability: definition.capability,
    // The identity role a mode requires. Enforced in `execution/identity/`: a
    // supervised mode may only be given a proposal identity, an autonomous one
    // only an execution identity.
    identityRole: definition.identityRole || null,
    implemented: definition.implemented === true,
    description: definition.description || "",
  });
  modes.set(mode, entry);
  return entry;
}

function getExecutionMode(mode) {
  const entry = modes.get(String(mode || ""));
  if (!entry) {
    throw new Error(
      `Unknown execution mode: ${mode}. Known modes: ${[...modes.keys()].join(", ")}`,
    );
  }
  return entry;
}

function listExecutionModes() {
  return [...modes.values()];
}

function isAutonomous(mode) {
  return getExecutionMode(mode).kind === ExecutionModeKind.AUTONOMOUS;
}

/** The DAO adapter capability key gating a mode. Replaces the old if-chain. */
function capabilityForMode(mode) {
  return getExecutionMode(mode).capability;
}

/**
 * Modes that ship today.
 *
 * `unsigned` is the honest name for "Gavel produced calldata and stopped". It
 * is a real mode rather than a missing one, so the offline BYOH path has the
 * same lifecycle, records and audit trail as everything else.
 */
registerExecutionMode({
  mode: ExecutionMode.UNSIGNED,
  kind: ExecutionModeKind.OFFLINE,
  capability: "prepareVote",
  identityRole: null,
  implemented: true,
  description: "Validated calldata handed back for out-of-band signing.",
});
registerExecutionMode({
  mode: ExecutionMode.SAFE_SUPERVISED,
  kind: ExecutionModeKind.SUPERVISED,
  capability: "safeSupervised",
  identityRole: "proposal",
  implemented: true,
  description: "Proposed into a Safe queue; human Safe owners authorize and execute.",
});
registerExecutionMode({
  mode: ExecutionMode.WAAP_AUTONOMOUS,
  kind: ExecutionModeKind.AUTONOMOUS,
  capability: "waapAutonomous",
  identityRole: "execution",
  implemented: true,
  description: "Signed and broadcast by a policy-constrained execution wallet.",
});

/**
 * Modes the architecture anticipates. Declared so the shape of the system is
 * visibly not two-provider-specific, and unimplemented so selecting one gives a
 * clear error instead of silently doing something else.
 */
const FUTURE_EXECUTION_MODES = Object.freeze({
  EOA_SUPERVISED: "eoa-supervised",
  ERC4337: "erc4337",
  BANKR_WALLET: "bankr-wallet",
  HARDWARE_WALLET: "hardware-wallet",
});

registerExecutionMode({
  mode: FUTURE_EXECUTION_MODES.EOA_SUPERVISED,
  kind: ExecutionModeKind.SUPERVISED,
  capability: "eoaSupervised",
  identityRole: "proposal",
  implemented: false,
  description: "Presented to a human-held EOA for signature.",
});
registerExecutionMode({
  mode: FUTURE_EXECUTION_MODES.ERC4337,
  kind: ExecutionModeKind.SUPERVISED,
  capability: "erc4337",
  identityRole: "proposal",
  implemented: false,
  description: "Submitted as a user operation through a bundler.",
});
registerExecutionMode({
  mode: FUTURE_EXECUTION_MODES.BANKR_WALLET,
  kind: ExecutionModeKind.AUTONOMOUS,
  capability: "bankrWallet",
  identityRole: "execution",
  implemented: false,
  description: "Signed by a hosted Bankr-managed execution wallet.",
});
registerExecutionMode({
  mode: FUTURE_EXECUTION_MODES.HARDWARE_WALLET,
  kind: ExecutionModeKind.SUPERVISED,
  capability: "hardwareWallet",
  identityRole: "proposal",
  implemented: false,
  description: "Presented to a hardware-backed signer for human confirmation.",
});

module.exports = {
  ExecutionModeKind,
  FUTURE_EXECUTION_MODES,
  capabilityForMode,
  getExecutionMode,
  isAutonomous,
  listExecutionModes,
  registerExecutionMode,
};
