const { getAddress } = require("ethers");

const { ExecutionMode, ExecutionStatus, executionResultSchema } = require("../../schema/execution");
const {
  assertPreparedGovernanceTransaction,
  assertExecutorDidNotMutate,
} = require("../transaction-binding");

const SAFE_STATUSES = new Set(Object.values(ExecutionStatus));

class SafeSupervisedExecutor {
  constructor(options) {
    if (!options?.client || typeof options.client.propose !== "function") {
      throw new TypeError("Safe proposer client is required");
    }
    this.type = ExecutionMode.SAFE_SUPERVISED;
    this.client = options.client;
    this.safeAddress = getAddress(options.safeAddress);
    this.chainId = options.chainId == null ? null : Number(options.chainId);
  }

  async getExecutionAddress() {
    return this.safeAddress;
  }

  async submit(transaction) {
    const prepared = assertPreparedGovernanceTransaction(transaction);
    if (getAddress(prepared.executionAddress) !== this.safeAddress) {
      throw new Error("Prepared execution address does not match the configured Safe");
    }
    if (this.chainId !== null && prepared.chainId !== this.chainId) {
      throw new Error("Prepared transaction chain does not match the configured Safe chain");
    }
    const result = await this.client.propose({
      safeAddress: this.safeAddress,
      chainId: prepared.chainId,
      transaction: {
        from: prepared.executionAddress,
        to: prepared.target,
        data: prepared.calldata,
        value: prepared.value,
      },
      metadata: {
        adapter: prepared.adapter,
        action: prepared.action,
        proposalId: prepared.proposalId,
        support: prepared.support,
        reason: prepared.reason,
        intentHash: prepared.intentHash,
      },
    });
    if (result?.transaction) assertExecutorDidNotMutate(prepared, result.transaction);
    const executionId = result?.safeTxHash || result?.executionId;
    if (!executionId) throw new Error("Safe proposer returned no execution identifier");
    return executionResultSchema.parse({
      executor: this.type,
      status: ExecutionStatus.PROPOSED,
      executionId: String(executionId),
      intentHash: prepared.intentHash,
      transactionHash: null,
    });
  }

  async getStatus(executionId) {
    if (typeof this.client.getStatus !== "function") {
      throw new Error("Safe proposer client does not support status checks");
    }
    const result = await this.client.getStatus(executionId);
    if (!SAFE_STATUSES.has(result?.status)) throw new Error("Safe returned an unknown execution status");
    return { executionId, ...result };
  }
}

module.exports = { SafeSupervisedExecutor };
