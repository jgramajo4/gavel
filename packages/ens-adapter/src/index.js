const { createHash } = require("node:crypto");
const { Contract, Interface, getAddress, id, keccak256, toUtf8Bytes } = require("ethers");

const { Support } = require("../../core/src/schema/governance");
const { predictionDocumentSchema } = require("../../core/src/schema/prediction");
const { normalizedProposalSchema } = require("../../core/src/schema/governance");
const { inspectNounsProposal } = require("../../nouns-adapter/src/security");

const CHAIN_ID = 1;
const ENS_GOVERNOR_ADDRESS = getAddress("0x323A76393544d5ecca80cd6ef2A560C6a395b7E3");
const ENS_TOKEN_ADDRESS = getAddress("0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72");
const ENS_TIMELOCK_ADDRESS = getAddress("0xFe89cc7aBB2C4183683ab71653C4cdc9B02D44b7");
const ACTIVE_STATE = 1;
const STATE_LABELS = ["PENDING", "ACTIVE", "CANCELLED", "DEFEATED", "SUCCEEDED", "QUEUED", "EXPIRED", "EXECUTED"];
const SUPPORT_CODES = Object.freeze({ [Support.AGAINST]: 0, [Support.FOR]: 1, [Support.ABSTAIN]: 2 });

const ENS_GOVERNOR_ABI = [
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalSnapshot(uint256 proposalId) view returns (uint256)",
  "function proposalDeadline(uint256 proposalId) view returns (uint256)",
  "function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes,uint256 forVotes,uint256 abstainVotes)",
  "function quorum(uint256 blockNumber) view returns (uint256)",
  "function getVotes(address account,uint256 blockNumber) view returns (uint256)",
  "function hasVoted(uint256 proposalId,address account) view returns (bool)",
  "function hashProposal(address[] targets,uint256[] values,bytes[] calldatas,bytes32 descriptionHash) pure returns (uint256)",
  "function castVoteWithReason(uint256 proposalId,uint8 support,string reason) returns (uint256)",
];
const ENS_TOKEN_ABI = [
  "function getVotes(address account) view returns (uint256)",
  "function getPastVotes(address account,uint256 blockNumber) view returns (uint256)",
  "function delegates(address account) view returns (address)",
  "function delegate(address delegatee)",
];

const governorInterface = new Interface(ENS_GOVERNOR_ABI);
const tokenInterface = new Interface(ENS_TOKEN_ABI);

function decimal(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed.toString();
  } catch {
    throw new TypeError(`${label} must be an unsigned integer`);
  }
}

function hasCode(code) {
  return typeof code === "string" && !/^0x0*$/i.test(code);
}

function safeErrorMessage(error) {
  return String(error?.shortMessage || error?.reason || error?.message || "unknown RPC failure")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function executableCalldata(action) {
  if (!action.signature) return action.calldata;
  return `${id(action.signature).slice(0, 10)}${action.calldata.replace(/^0x/, "")}`;
}

function proposalIdentityInput(proposal) {
  return {
    targets: proposal.actions.map((action) => action.target),
    values: proposal.actions.map((action) => action.valueWei),
    calldatas: proposal.actions.map(executableCalldata),
    descriptionHash: keccak256(toUtf8Bytes(proposal.description)),
  };
}

function indexedProposalContentHash(proposal) {
  const material = {
    description: proposal.description,
    targets: proposal.actions.map((action) => action.target),
    values: proposal.actions.map((action) => action.valueWei),
    signatures: proposal.actions.map((action) => action.signature),
    calldatas: proposal.actions.map((action) => action.calldata),
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function basePredictionChecks(prediction, proposal, selectedSupport, input, blockers) {
  const block = (code, message) => blockers.push({ code, message });
  if (prediction.dao !== "ens" || prediction.chainId !== CHAIN_ID) {
    block("PREDICTION_NETWORK_MISMATCH", "Prediction is not for ENS on Ethereum mainnet.");
  }
  if (prediction.proposalId !== proposal.id || prediction.proposalContentHash !== proposal.contentHash) {
    block("PREDICTION_PROPOSAL_MISMATCH", "Prediction does not match the supplied normalized proposal.");
  }
  if (selectedSupport !== prediction.recommendation) {
    block("RECOMMENDATION_NOT_CONFIRMED", `Selected support ${selectedSupport} does not confirm recommendation ${prediction.recommendation}.`);
  }
  const review = prediction.predictionReview || {
    requiresHumanReview: true,
    autonomyAllowed: false,
    reasonCodes: ["LEGACY_PREDICTION_REQUIRES_REVIEW"],
  };
  const reviewAcknowledged = Boolean(input.acknowledgePredictionReview);
  if (review.requiresHumanReview && !reviewAcknowledged) {
    block("PREDICTION_REVIEW_REQUIRED", "This recommendation requires explicit human review acknowledgement.");
  }
  const security = prediction.security;
  if (!security || security.proposalContentHash !== proposal.contentHash) {
    block("SECURITY_REPORT_MISSING_OR_STALE", "A matching structural proposal inspection is required.");
  }
  if (security?.flags.some((flag) => flag.severity === "CRITICAL")) {
    block("CRITICAL_SECURITY_FINDING", "Critical structural findings prevent transaction preparation.");
  }
  const securityReviewAcknowledged = Boolean(input.acknowledgeSecurityReview);
  if (security?.summary.requiresHumanReview && !securityReviewAcknowledged) {
    block("SECURITY_REVIEW_REQUIRED", "Structural findings require explicit human review acknowledgement.");
  }
  return { review, reviewAcknowledged, security, securityReviewAcknowledged };
}

class EnsDaoAdapter {
  constructor(options) {
    if (!options?.provider) throw new TypeError("A JSON-RPC provider is required");
    this.id = "ens";
    this.chainId = CHAIN_ID;
    this.governanceContracts = Object.freeze({
      governor: ENS_GOVERNOR_ADDRESS,
      token: ENS_TOKEN_ADDRESS,
      timelock: ENS_TIMELOCK_ADDRESS,
    });
    this.capabilities = Object.freeze({
      analyze: true,
      predict: true,
      prepareVote: true,
      safeSupervised: true,
      waapAutonomous: false,
    });
    this.supportedActions = Object.freeze(["CAST_VOTE"]);
    this.provider = options.provider;
    this.governor = options.governor || new Contract(ENS_GOVERNOR_ADDRESS, ENS_GOVERNOR_ABI, options.provider);
    this.token = options.token || new Contract(ENS_TOKEN_ADDRESS, ENS_TOKEN_ABI, options.provider);
    this.proposalLoader = options.proposalLoader;
    this.now = options.now || (() => new Date());
  }

  validateProposal(proposal) {
    return inspectNounsProposal(proposal);
  }

  async getVotingPower(address, blockTag) {
    if (blockTag != null) return this.token.getPastVotes(address, blockTag);
    return this.token.getVotes(address);
  }

  async getCurrentDelegate(address) {
    return this.token.delegates(address);
  }

  async hasVoted(proposalId, address) {
    return this.governor.hasVoted(proposalId, address);
  }

  async prepareDelegation(input) {
    const assetOwnerAddress = getAddress(input.assetOwnerAddress);
    const requiredDelegateAddress = getAddress(input.requiredDelegateAddress);
    const [network, code, currentDelegate] = await Promise.all([
      this.provider.getNetwork(),
      this.provider.getCode(ENS_TOKEN_ADDRESS),
      this.token.delegates(assetOwnerAddress),
    ]);
    const blockers = [];
    if (Number(network.chainId) !== CHAIN_ID) blockers.push({ code: "WRONG_CHAIN", message: "RPC is not Ethereum mainnet." });
    if (!hasCode(code)) blockers.push({ code: "TOKEN_CODE_MISSING", message: "ENS token code is missing." });
    const transaction = blockers.length === 0 ? {
      kind: "UNSIGNED_EVM_TRANSACTION",
      from: assetOwnerAddress,
      to: ENS_TOKEN_ADDRESS,
      chainId: CHAIN_ID,
      value: "0",
      data: tokenInterface.encodeFunctionData("delegate", [requiredDelegateAddress]),
      function: "delegate(address)",
    } : null;
    return {
      schemaVersion: "1.0.0",
      generatedAt: this.now().toISOString(),
      dao: this.id,
      chainId: CHAIN_ID,
      assetOwnerAddress,
      currentDelegateAddress: getAddress(currentDelegate),
      requiredDelegateAddress,
      status: transaction ? "READY_TO_SIGN" : "BLOCKED",
      blockers,
      transaction,
    };
  }

  async fetchProposal(proposalId) {
    const requestedId = decimal(proposalId, "proposal id");
    if (typeof this.proposalLoader !== "function") {
      throw new Error("ENS proposal metadata requires an indexed proposal loader");
    }
    const indexed = normalizedProposalSchema.parse(await this.proposalLoader(requestedId));
    if (indexed.id !== requestedId || indexed.dao !== "ens" || indexed.chainId !== CHAIN_ID) {
      throw new Error("Indexed ENS proposal identity does not match the request");
    }
    if (indexedProposalContentHash(indexed) !== indexed.contentHash) {
      throw new Error("Indexed ENS proposal content hash does not match canonical proposal material");
    }
    const identity = proposalIdentityInput(indexed);
    const [stateRaw, snapshotRaw, deadlineRaw, votesRaw, canonicalIdRaw] = await Promise.all([
      this.governor.state(requestedId),
      this.governor.proposalSnapshot(requestedId),
      this.governor.proposalDeadline(requestedId),
      this.governor.proposalVotes(requestedId),
      this.governor.hashProposal(identity.targets, identity.values, identity.calldatas, identity.descriptionHash),
    ]);
    if (decimal(canonicalIdRaw, "canonical proposal id") !== requestedId) {
      throw new Error("Canonical ENS proposal hash differs from indexed metadata");
    }
    const snapshot = decimal(snapshotRaw, "proposal snapshot block");
    const deadline = decimal(deadlineRaw, "proposal deadline block");
    if (snapshot !== indexed.startBlock || deadline !== indexed.endBlock) {
      throw new Error("Canonical ENS voting window differs from indexed metadata");
    }
    const state = STATE_LABELS[Number(stateRaw)] || `UNKNOWN_${Number(stateRaw)}`;
    const against = decimal(votesRaw.againstVotes ?? votesRaw[0], "against votes");
    const forVotes = decimal(votesRaw.forVotes ?? votesRaw[1], "for votes");
    const abstain = decimal(votesRaw.abstainVotes ?? votesRaw[2], "abstain votes");
    const quorum = decimal(await this.governor.quorum(snapshot), "quorum votes");
    return normalizedProposalSchema.parse({ ...indexed, state, outcome: state, startBlock: snapshot, endBlock: deadline, quorumVotes: quorum, againstVotes: against, forVotes, abstainVotes: abstain });
  }

  async prepareVote(input) {
    const prediction = predictionDocumentSchema.parse(input.prediction);
    const proposal = normalizedProposalSchema.parse(input.proposal);
    const selectedSupport = String(input.selectedSupport || "").toUpperCase();
    if (!(selectedSupport in SUPPORT_CODES)) throw new Error("selectedSupport must be AGAINST, FOR, or ABSTAIN");
    const modelVoter = getAddress(prediction.voter);
    const assetOwnerAddress = getAddress(input.assetOwnerAddress || prediction.voter);
    const votingAddress = getAddress(input.executionAddress || input.votingAddress || prediction.voter);
    const reason = typeof input.reason === "string" ? input.reason.trim() : prediction.draftReason.text?.trim() || "";
    if (reason.length > 10000) throw new Error("Voting reason must not exceed 10000 characters");
    const blockers = [];
    const review = basePredictionChecks(prediction, proposal, selectedSupport, input, blockers);
    const block = (code, message) => blockers.push({ code, message });
    const identity = proposalIdentityInput(proposal);

    const [network, checkedAtBlock, governorCode, tokenCode, stateRaw, snapshotRaw, deadlineRaw, alreadyVoted, votingPowerRaw, delegateRaw, canonicalIdRaw] =
      await Promise.all([
        this.provider.getNetwork(),
        this.provider.getBlockNumber(),
        this.provider.getCode(ENS_GOVERNOR_ADDRESS),
        this.provider.getCode(ENS_TOKEN_ADDRESS),
        this.governor.state(proposal.id),
        this.governor.proposalSnapshot(proposal.id),
        this.governor.proposalDeadline(proposal.id),
        this.governor.hasVoted(proposal.id, votingAddress),
        this.governor.getVotes(votingAddress, proposal.startBlock),
        this.token.delegates(assetOwnerAddress),
        this.governor.hashProposal(identity.targets, identity.values, identity.calldatas, identity.descriptionHash),
      ]);

    if (Number(network.chainId) !== CHAIN_ID) block("WRONG_CHAIN", "RPC is not Ethereum mainnet.");
    if (!hasCode(governorCode)) block("GOVERNANCE_CODE_MISSING", "ENS Governor code is missing at the canonical address.");
    if (!hasCode(tokenCode)) block("TOKEN_CODE_MISSING", "ENS token code is missing at the canonical address.");
    const stateCode = Number(stateRaw);
    if (stateCode !== ACTIVE_STATE) block("PROPOSAL_NOT_ACTIVE", `ENS proposal state is ${STATE_LABELS[stateCode] || `UNKNOWN_${stateCode}`}.`);
    const snapshotBlock = decimal(snapshotRaw, "proposal snapshot block");
    const deadlineBlock = decimal(deadlineRaw, "proposal deadline block");
    const votingWindowMatches = snapshotBlock === proposal.startBlock && deadlineBlock === proposal.endBlock;
    if (!votingWindowMatches) block("VOTING_WINDOW_MISMATCH", "Canonical ENS voting window differs from the normalized proposal.");
    const proposalIdentityMatches = decimal(canonicalIdRaw, "canonical proposal id") === proposal.id;
    if (!proposalIdentityMatches) block("CANONICAL_PROPOSAL_MISMATCH", "Canonical ENS proposal hash differs from the normalized proposal.");
    if (alreadyVoted) block("DUPLICATE_VOTE", `${votingAddress} has already voted on ENS proposal ${proposal.id}.`);
    const votingPower = decimal(votingPowerRaw, "snapshot voting power");
    if (BigInt(votingPower) === 0n) block("NO_SNAPSHOT_VOTING_POWER", `${votingAddress} had no voting power at block ${snapshotBlock}.`);
    const currentDelegateAddress = getAddress(delegateRaw);
    const delegationMatches = currentDelegateAddress === votingAddress;
    if (!delegationMatches) block("DELEGATION_MISMATCH", `${assetOwnerAddress} delegates to ${currentDelegateAddress}, not ${votingAddress}.`);

    const data = governorInterface.encodeFunctionData("castVoteWithReason", [proposal.id, SUPPORT_CODES[selectedSupport], reason]);
    let simulation = { attempted: false, succeeded: false, estimatedGas: null };
    if (blockers.length === 0) {
      simulation.attempted = true;
      try {
        const request = { from: votingAddress, to: ENS_GOVERNOR_ADDRESS, data, value: 0n };
        await this.provider.call(request);
        simulation = { attempted: true, succeeded: true, estimatedGas: decimal(await this.provider.estimateGas(request), "estimated gas") };
      } catch (error) {
        block("SIMULATION_FAILED", `ENS vote simulation failed: ${safeErrorMessage(error)}`);
      }
    }
    const status = blockers.length === 0 ? "READY_TO_SIGN" : "BLOCKED";
    return {
      schemaVersion: "1.1.0",
      generatedAt: this.now().toISOString(),
      dao: this.id,
      chainId: CHAIN_ID,
      proposalId: proposal.id,
      proposalContentHash: proposal.contentHash,
      modelVoter,
      votingAddress,
      addressRoles: { modelAddress: modelVoter, assetOwnerAddress, currentDelegateAddress, executionAddress: votingAddress, requiredDelegateAddress: votingAddress },
      recommendation: prediction.recommendation,
      selectedSupport,
      confidencePercent: prediction.confidencePercent,
      policySource: prediction.policySource,
      policySourceId: prediction.policySourceId,
      reason: { text: reason, source: input.reason ? "USER_CONFIRMED" : "PREDICTION_DRAFT" },
      flags: prediction.flags,
      predictionReview: { ...review.review, reviewAcknowledged: review.reviewAcknowledged },
      security: {
        riskLevel: review.security?.summary.riskLevel || "CRITICAL",
        requiresHumanReview: review.security?.summary.requiresHumanReview || false,
        reviewAcknowledged: review.securityReviewAcknowledged,
        flags: review.security?.flags || [],
      },
      verification: {
        checkedAtBlock: decimal(checkedAtBlock, "checked block"),
        governanceAddress: ENS_GOVERNOR_ADDRESS,
        tokenAddress: ENS_TOKEN_ADDRESS,
        governanceCodePresent: hasCode(governorCode),
        tokenCodePresent: hasCode(tokenCode),
        proposalState: { code: stateCode, label: STATE_LABELS[stateCode] || `UNKNOWN_${stateCode}`, active: stateCode === ACTIVE_STATE },
        proposalIdentityMatches,
        votingWindowMatches,
        executableActionsMatch: proposalIdentityMatches,
        receipt: { hasVoted: Boolean(alreadyVoted), support: 0, votes: "0" },
        votingPower: { snapshotBlock, votes: votingPower, eligible: BigInt(votingPower) > 0n },
        delegation: { modelVoterDelegatee: currentDelegateAddress, assetOwnerAddress, currentDelegateAddress, requiredDelegateAddress: votingAddress, matchesVotingAddress: delegationMatches },
        simulation,
      },
      status,
      blockers,
      transaction: status === "READY_TO_SIGN" ? {
        kind: "UNSIGNED_EVM_TRANSACTION",
        from: votingAddress,
        to: ENS_GOVERNOR_ADDRESS,
        chainId: CHAIN_ID,
        value: "0",
        data,
        function: "castVoteWithReason(uint256,uint8,string)",
      } : null,
      attribution: { appliedInternally: false, clientId: null },
    };
  }
}

module.exports = {
  CHAIN_ID,
  ENS_GOVERNOR_ADDRESS,
  ENS_TOKEN_ADDRESS,
  ENS_TIMELOCK_ADDRESS,
  ENS_GOVERNOR_ABI,
  ENS_TOKEN_ABI,
  SUPPORT_CODES,
  proposalIdentityInput,
  EnsDaoAdapter,
};
