const { ExecutionMode } = require("../schema/execution");

const REQUIRED_ADAPTER_METHODS = [
  "validateProposal",
  "getVotingPower",
  "getCurrentDelegate",
  "hasVoted",
  "prepareVote",
];

function assertDaoAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("DAO adapter is required");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(adapter.id || "")) throw new TypeError("DAO adapter id is invalid");
  if (!Number.isInteger(adapter.chainId) || adapter.chainId <= 0) throw new TypeError("DAO adapter chainId is invalid");
  if (!adapter.governanceContracts?.governor) throw new TypeError("DAO adapter governor is required");
  if (!adapter.capabilities || !Array.isArray(adapter.supportedActions)) {
    throw new TypeError("DAO adapter capabilities and supportedActions are required");
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") throw new TypeError(`DAO adapter ${adapter.id} is missing ${method}()`);
  }
  return adapter;
}

function capabilityForMode(mode) {
  if (mode === ExecutionMode.UNSIGNED) return "prepareVote";
  if (mode === ExecutionMode.SAFE_SUPERVISED) return "safeSupervised";
  if (mode === ExecutionMode.WAAP_AUTONOMOUS) return "waapAutonomous";
  throw new Error(`Unsupported execution mode: ${mode}`);
}

function assertModeSupported(adapterInput, mode) {
  const adapter = assertDaoAdapter(adapterInput);
  const capability = capabilityForMode(mode);
  if (adapter.capabilities[capability] !== true) {
    throw new Error(`${adapter.id} does not support ${mode}`);
  }
  return adapter;
}

function assertActionSupported(adapterInput, action, mode) {
  const adapter = assertModeSupported(adapterInput, mode);
  if (!adapter.supportedActions.includes(action)) {
    throw new Error(`${adapter.id} does not support governance action ${action}`);
  }
  return adapter;
}

class DaoRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapterInput) {
    const adapter = assertDaoAdapter(adapterInput);
    if (this.adapters.has(adapter.id)) throw new Error(`DAO adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return adapter;
  }

  get(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unsupported DAO: ${id}`);
    return adapter;
  }
}

module.exports = {
  DaoRegistry,
  assertDaoAdapter,
  assertModeSupported,
  assertActionSupported,
  capabilityForMode,
};
