const { Contract } = require("ethers");

const { installGovernanceContract } = require("../../core/src/dao/contract");
const { inspectNounsProposal } = require("./security");
const { DEFAULT_ENDPOINT, NounsSubgraphHistoryAdapter } = require("./history");
const {
  CHAIN_ID,
  GOVERNANCE_ADDRESS,
  GOVERNANCE_ABI,
  NOUNS_TOKEN_ADDRESS,
  NOUNS_TOKEN_ABI,
  NounsVotePreparationAdapter,
  decodeNounsVoteCall,
} = require("./vote");
const { NounsDelegationPreparationAdapter } = require("./delegation");
const {
  DEFAULT_ETHEREUM_RPC_URL,
  createEthereumProvider,
  resolveEthereumRpcUrl,
} = require("./rpc");

class NounsDaoAdapter {
  constructor(options) {
    if (!options?.provider) throw new TypeError("A JSON-RPC provider is required");
    this.id = "nouns";
    this.chainId = CHAIN_ID;
    this.governanceContracts = {
      governor: GOVERNANCE_ADDRESS,
      token: NOUNS_TOKEN_ADDRESS,
    };
    this.capabilities = Object.freeze({
      analyze: true,
      predict: true,
      prepareVote: true,
      safeSupervised: true,
      waapAutonomous: true,
    });
    this.supportedActions = Object.freeze(["CAST_VOTE"]);
    // Nouns records one receipt per voter per proposal: `getReceipt().hasVoted`
    // is decisive and the governor rejects a second vote. So neither repeat
    // voting nor replacement is permitted, and the execution layer enforces
    // exactly that without knowing why.
    installGovernanceContract(this, {
      adapterVersion: "nouns@1.1.0",
      semantics: { canVoteMultipleTimes: false, canReplaceVote: false },
      governanceTargets: [GOVERNANCE_ADDRESS],
      // castRefundableVoteWithReason(uint256,uint8,string,uint32)
      governanceSelectors: { CAST_VOTE: ["0x8136730f"] },
    });
    this.provider = options.provider;
    this.governance = options.governance || new Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, options.provider);
    this.token = options.nounsToken || options.token || new Contract(NOUNS_TOKEN_ADDRESS, NOUNS_TOKEN_ABI, options.provider);
    this.votePreparation = new NounsVotePreparationAdapter({
      ...options,
      governance: this.governance,
      nounsToken: this.token,
    });
    this.delegationPreparation = new NounsDelegationPreparationAdapter({
      ...options,
      token: this.token,
    });
  }

  validateProposal(proposal) {
    return inspectNounsProposal(proposal);
  }

  /**
   * Decode a Nouns vote call so core can bind the governance decision to the
   * bytes it claims to represent.
   *
   * A selector alone says which function is called, not with what: the same
   * `castRefundableVoteWithReason` selector encodes a vote FOR proposal 42 and
   * a vote AGAINST proposal 999. Core cannot decode this without becoming
   * Nouns-aware, so the adapter does it and core cross-checks the result.
   */
  decodeGovernanceCall(action, data) {
    if (action !== "CAST_VOTE") throw new Error(`Nouns does not decode governance action ${action}`);
    return decodeNounsVoteCall(data);
  }

  async getVotingPower(address, blockTag) {
    if (blockTag != null) return this.token.getPriorVotes(address, blockTag);
    return this.token.getCurrentVotes(address);
  }

  async getCurrentDelegate(address) {
    return this.token.delegates(address);
  }

  async hasVoted(proposalId, address) {
    const receipt = await this.governance.getReceipt(proposalId, address);
    return Boolean(receipt?.hasVoted ?? receipt?.[0]);
  }

  async prepareVote(input) {
    return this.votePreparation.prepare(input);
  }

  async prepareDelegation(input) {
    return this.delegationPreparation.prepare(input);
  }

  history(options = {}) {
    return new NounsSubgraphHistoryAdapter(options);
  }
}

module.exports = {
  NounsDaoAdapter,
  decodeNounsVoteCall,
  NounsDelegationPreparationAdapter,
  NounsSubgraphHistoryAdapter,
  DEFAULT_ENDPOINT,
  DEFAULT_ETHEREUM_RPC_URL,
  createEthereumProvider,
  resolveEthereumRpcUrl,
  inspectNounsProposal,
  CHAIN_ID,
  GOVERNANCE_ADDRESS,
  NOUNS_TOKEN_ADDRESS,
};
