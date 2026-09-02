const { Contract, Interface, getAddress } = require("ethers");

const { createPreparedGovernanceTransaction } = require("../../core/src/execution/transaction-binding");
const { CHAIN_ID, NOUNS_TOKEN_ADDRESS, NOUNS_TOKEN_ABI } = require("./vote");

const tokenInterface = new Interface(NOUNS_TOKEN_ABI);

function hasCode(code) {
  return typeof code === "string" && !/^0x0*$/i.test(code);
}

class NounsDelegationPreparationAdapter {
  constructor(options) {
    if (!options?.provider) throw new TypeError("A JSON-RPC provider is required");
    this.provider = options.provider;
    this.token = options.token || new Contract(NOUNS_TOKEN_ADDRESS, NOUNS_TOKEN_ABI, options.provider);
    this.now = options.now || (() => new Date());
  }

  async prepare(input) {
    const assetOwnerAddress = getAddress(input.assetOwnerAddress);
    const requiredDelegateAddress = getAddress(input.requiredDelegateAddress);
    let network;
    let code;
    let currentDelegateAddress;
    try {
      [network, code, currentDelegateAddress] = await Promise.all([
        this.provider.getNetwork(),
        this.provider.getCode(NOUNS_TOKEN_ADDRESS),
        this.token.delegates(assetOwnerAddress),
      ]);
    } catch (error) {
      throw new Error(`Delegation preparation failed closed: ${error.message}`);
    }
    if (Number(network.chainId) !== CHAIN_ID) throw new Error("Delegation RPC is not Ethereum mainnet");
    if (!hasCode(code)) throw new Error("Canonical Nouns token code is unavailable");

    const current = getAddress(currentDelegateAddress);
    const alreadyDelegated = current === requiredDelegateAddress;
    const calldata = tokenInterface.encodeFunctionData("delegate", [requiredDelegateAddress]);
    const transaction = createPreparedGovernanceTransaction({
      adapter: "nouns",
      action: "DELEGATE_VOTES",
      chainId: CHAIN_ID,
      target: NOUNS_TOKEN_ADDRESS,
      calldata,
      value: "0",
      proposalId: null,
      support: null,
      reason: `Explicitly delegate Nouns governance power to ${requiredDelegateAddress}`,
      executionAddress: assetOwnerAddress,
      validatedAt: this.now(),
    });
    return {
      dao: "nouns",
      chainId: CHAIN_ID,
      assetOwnerAddress,
      currentDelegateAddress: current,
      requiredDelegateAddress,
      delegationChangeRequired: !alreadyDelegated,
      disclosure: alreadyDelegated
        ? `No delegation change is required; ${assetOwnerAddress} already delegates to ${requiredDelegateAddress}.`
        : `Delegation will change from ${current} to ${requiredDelegateAddress}. This transaction is unsigned and was not submitted.`,
      status: alreadyDelegated ? "ALREADY_CONFIGURED" : "PREPARED",
      transaction: alreadyDelegated ? null : transaction,
    };
  }
}

module.exports = { NounsDelegationPreparationAdapter };
