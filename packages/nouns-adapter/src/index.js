const { Contract } = require("ethers");

const { inspectNounsProposal } = require("./security");
const { DEFAULT_ENDPOINT, NounsSubgraphHistoryAdapter } = require("./history");
const {
  CHAIN_ID,
  GOVERNANCE_ADDRESS,
  GOVERNANCE_ABI,
  NOUNS_TOKEN_ADDRESS,
  NOUNS_TOKEN_ABI,
  NounsVotePreparationAdapter,
} = require("./vote");
const { NounsDelegationPreparationAdapter } = require("./delegation");

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
  NounsDelegationPreparationAdapter,
  NounsSubgraphHistoryAdapter,
  DEFAULT_ENDPOINT,
  inspectNounsProposal,
  CHAIN_ID,
  GOVERNANCE_ADDRESS,
  NOUNS_TOKEN_ADDRESS,
};
