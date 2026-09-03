const { getAddress } = require("ethers");

const { assertActionSupported } = require("../../dao/registry");
const { ExecutionMode, ExecutionStatus, executionResultSchema } = require("../../schema/execution");
const {
  assertPreparedGovernanceTransaction,
  assertExecutorDidNotMutate,
} = require("../transaction-binding");

class WaapAutonomousExecutor {
  constructor(options) {
    if (!options?.client || typeof options.client.submit !== "function") {
      throw new TypeError("WaaP governance client is required");
    }
    if (typeof options.policy !== "function") throw new TypeError("WaaP policy hook is required");
    this.type = ExecutionMode.WAAP_AUTONOMOUS;
    this.client = options.client;
    this.policy = options.policy;
    this.adapter = options.adapter;
    this.executionAddress = getAddress(options.executionAddress);
  }

  async getExecutionAddress() {
    return this.executionAddress;
  }

  async submit(transaction) {
    const prepared = assertPreparedGovernanceTransaction(transaction);
    assertActionSupported(this.adapter, prepared.action, this.type);
    if (prepared.adapter !== this.adapter.id || prepared.chainId !== this.adapter.chainId) {
      throw new Error("Prepared transaction does not match the WaaP DAO adapter");
    }
    if (getAddress(prepared.executionAddress) !== this.executionAddress) {
      throw new Error("Prepared execution address does not match WaaP");
    }
    if (prepared.autonomyAllowed !== true) {
      throw new Error("Prediction review policy blocks autonomous execution");
    }
    const policyResult = await this.policy(prepared);
    if (policyResult !== true && policyResult?.allowed !== true) {
      throw new Error(`WaaP policy blocked governance execution${policyResult?.reason ? `: ${policyResult.reason}` : ""}`);
    }
    const result = await this.client.submit({
      scope: {
        adapter: prepared.adapter,
        action: prepared.action,
        governor: this.adapter.governanceContracts.governor,
      },
      transaction: {
        from: prepared.executionAddress,
        to: prepared.target,
        data: prepared.calldata,
        value: prepared.value,
        chainId: prepared.chainId,
      },
      intentHash: prepared.intentHash,
    });
    if (result?.transaction) assertExecutorDidNotMutate(prepared, result.transaction);
    const executionId = result?.executionId || result?.transactionHash;
    if (!executionId) throw new Error("WaaP returned no execution identifier");
    return executionResultSchema.parse({
      executor: this.type,
      status: result?.status || ExecutionStatus.EXECUTED,
      executionId: String(executionId),
      intentHash: prepared.intentHash,
      transactionHash: result?.transactionHash || null,
    });
  }
}

module.exports = { WaapAutonomousExecutor };
