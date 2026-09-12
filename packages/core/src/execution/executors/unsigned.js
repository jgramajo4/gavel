const { ExecutionMode, ExecutionStatus, executionResultSchema } = require("../../schema/execution");
const { assertDeprecatedPathAllowed, assertPreparedGovernanceTransaction } = require("../transaction-binding");

class UnsignedExecutor {
  constructor(executionAddress) {
    assertDeprecatedPathAllowed("UnsignedExecutor");
    this.type = ExecutionMode.UNSIGNED;
    this.executionAddress = executionAddress;
  }

  async getExecutionAddress() {
    return this.executionAddress;
  }

  async submit(transaction) {
    const prepared = assertPreparedGovernanceTransaction(transaction);
    return executionResultSchema.parse({
      executor: this.type,
      status: ExecutionStatus.PREPARED,
      executionId: prepared.intentHash,
      intentHash: prepared.intentHash,
      transactionHash: null,
    });
  }
}

module.exports = { UnsignedExecutor };
