const { Contract, Interface, getAddress } = require("ethers");

const { normalizedProposalSchema, Support } = require("../../core/src/schema/governance");
const { predictionDocumentSchema } = require("../../core/src/schema/prediction");
const { votePreparationSchema } = require("./schema/preparation");
const { canonicalProposalVersion } = require("./freshness");

const CHAIN_ID = 1;
const CLIENT_ID = 38;
const GOVERNANCE_ADDRESS = getAddress("0x6f3E6272A167e8AcCb32072d08E0957F9c79223d");
const NOUNS_TOKEN_ADDRESS = getAddress("0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03");
const ACTIVE_STATE = 1;
const STATE_LABELS = ["PENDING", "ACTIVE", "CANCELLED", "DEFEATED", "SUCCEEDED", "QUEUED", "EXPIRED", "EXECUTED", "VETOED", "OBJECTION_PERIOD"];
const SUPPORT_CODES = Object.freeze({ [Support.AGAINST]: 0, [Support.FOR]: 1, [Support.ABSTAIN]: 2 });

const GOVERNANCE_ABI = [
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposals(uint256 proposalId) view returns (uint256 id,address proposer,uint256 proposalThreshold,uint256 quorumVotes,uint256 eta,uint256 startBlock,uint256 endBlock,uint256 forVotes,uint256 againstVotes,uint256 abstainVotes,bool canceled,bool vetoed,bool executed,uint256 totalSupply,uint256 creationBlock)",
  "function getActions(uint256 proposalId) view returns (address[] targets,uint256[] values,string[] signatures,bytes[] calldatas)",
  "function getReceipt(uint256 proposalId,address voter) view returns (bool hasVoted,uint8 support,uint96 votes)",
  "function castRefundableVoteWithReason(uint256 proposalId,uint8 support,string reason,uint32 clientId)",
];
const NOUNS_TOKEN_ABI = [
  "function getPriorVotes(address account,uint256 blockNumber) view returns (uint96)",
  "function getCurrentVotes(address account) view returns (uint96)",
  "function delegates(address delegator) view returns (address)",
  "function delegate(address delegatee)",
];
const voteInterface = new Interface(GOVERNANCE_ABI);

function field(value, name, index) {
  return value?.[index] ?? value?.[name];
}

function decimal(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed.toString();
  } catch {
    throw new Error(`${label} must be an unsigned integer`);
  }
}

function hasCode(code) {
  return typeof code === "string" && !/^0x0*$/i.test(code);
}

function canonicalActions(proposalResult) {
  const targets = Array.from(field(proposalResult, "targets", 0) || []);
  const values = Array.from(field(proposalResult, "values", 1) || []);
  const signatures = Array.from(field(proposalResult, "signatures", 2) || []);
  const calldatas = Array.from(field(proposalResult, "calldatas", 3) || []);
  if (![values, signatures, calldatas].every((items) => items.length === targets.length)) {
    throw new Error("Canonical Nouns proposal action arrays have inconsistent lengths");
  }
  return targets.map((target, index) => ({
    index,
    target: getAddress(target),
    valueWei: decimal(values[index], `action ${index} value`),
    signature: String(signatures[index]),
    calldata: String(calldatas[index]).toLowerCase(),
  }));
}

function actionsMatch(localActions, chainActions) {
  if (localActions.length !== chainActions.length) return false;
  return localActions.every((action, index) => {
    const canonical = chainActions[index];
    return (
      action.index === canonical.index &&
      getAddress(action.target) === canonical.target &&
      action.valueWei === canonical.valueWei &&
      action.signature === canonical.signature &&
      action.calldata.toLowerCase() === canonical.calldata
    );
  });
}

function safeErrorMessage(error) {
  const message = error?.shortMessage || error?.reason || error?.message || "unknown RPC failure";
  return String(message).replace(/\s+/g, " ").slice(0, 300);
}

class NounsVotePreparationAdapter {
  constructor(options) {
    if (!options?.provider) throw new TypeError("A JSON-RPC provider is required");
    this.provider = options.provider;
    this.governance = options.governance || new Contract(GOVERNANCE_ADDRESS, GOVERNANCE_ABI, options.provider);
    this.nounsToken = options.nounsToken || new Contract(NOUNS_TOKEN_ADDRESS, NOUNS_TOKEN_ABI, options.provider);
    this.now = options.now || (() => new Date());
    this.freshnessVerifier = options.freshnessVerifier || canonicalProposalVersion;
  }

  async prepare(input) {
    const prediction = predictionDocumentSchema.parse(input.prediction);
    const proposal = normalizedProposalSchema.parse(input.proposal);
    const modelVoter = getAddress(prediction.voter);
    const assetOwnerAddress = getAddress(input.assetOwnerAddress || prediction.voter);
    const votingAddress = getAddress(input.executionAddress || input.votingAddress || prediction.voter);
    const selectedSupport = String(input.selectedSupport || "").toUpperCase();
    if (!(selectedSupport in SUPPORT_CODES)) {
      throw new Error("selectedSupport must be AGAINST, FOR, or ABSTAIN");
    }
    const explicitReason = typeof input.reason === "string" ? input.reason.trim() : "";
    const draftReason = prediction.draftReason.text?.trim() || "";
    const reason = explicitReason || draftReason;
    if (!reason) throw new Error("A confirmed voting reason or available prediction draft is required");
    if (reason.length > 10000) throw new Error("Voting reason must not exceed 10000 characters");

    const blockers = [];
    const block = (code, message) => blockers.push({ code, message });
    if (prediction.dao !== "nouns" || prediction.chainId !== CHAIN_ID) {
      block("PREDICTION_NETWORK_MISMATCH", "Prediction is not for Nouns on Ethereum mainnet.");
    }
    if (prediction.proposalId !== proposal.id || prediction.proposalContentHash !== proposal.contentHash) {
      block("PREDICTION_PROPOSAL_MISMATCH", "Prediction does not match the supplied normalized proposal.");
    }
    if (selectedSupport !== prediction.recommendation) {
      block("RECOMMENDATION_NOT_CONFIRMED", `Selected support ${selectedSupport} does not confirm recommendation ${prediction.recommendation}.`);
    }

    const predictionReview = prediction.predictionReview || {
      requiresHumanReview: true,
      autonomyAllowed: false,
      reasonCodes: ["LEGACY_PREDICTION_REQUIRES_REVIEW"],
    };
    const predictionReviewAcknowledged = Boolean(input.acknowledgePredictionReview);
    if (predictionReview.requiresHumanReview && !predictionReviewAcknowledged) {
      block(
        "PREDICTION_REVIEW_REQUIRED",
        "This recommendation is advisory and requires explicit human review acknowledgement.",
      );
    }

    const security = prediction.security;
    if (!security || security.proposalContentHash !== proposal.contentHash) {
      block("SECURITY_REPORT_MISSING_OR_STALE", "A matching Gavel proposal security inspection is required.");
    }
    const criticalSecurity = security?.flags.some((flag) => flag.severity === "CRITICAL") || false;
    if (criticalSecurity) block("CRITICAL_SECURITY_FINDING", "Critical proposal security findings prevent transaction preparation.");
    const requiresHumanReview = security?.summary.requiresHumanReview || false;
    const reviewAcknowledged = Boolean(input.acknowledgeSecurityReview);
    if (requiresHumanReview && !reviewAcknowledged) {
      block("SECURITY_REVIEW_REQUIRED", "Proposal security findings require explicit human review acknowledgement.");
    }

    const [network, checkedAtBlock, governanceCode, nounsTokenCode, stateRaw, canonical, actionResult, receiptRaw, votingPowerRaw, delegateeRaw] =
      await Promise.all([
        this.provider.getNetwork(),
        this.provider.getBlockNumber(),
        this.provider.getCode(GOVERNANCE_ADDRESS),
        this.provider.getCode(NOUNS_TOKEN_ADDRESS),
        this.governance.state(proposal.id),
        this.governance.proposals(proposal.id),
        this.governance.getActions(proposal.id),
        this.governance.getReceipt(proposal.id, votingAddress),
        this.nounsToken.getPriorVotes(votingAddress, proposal.startBlock),
        this.nounsToken.delegates(assetOwnerAddress),
      ]);

    let canonicalVersion = null;
    try {
      canonicalVersion = await this.freshnessVerifier(
        this.provider,
        GOVERNANCE_ADDRESS,
        proposal.id,
        proposal.createdBlock,
        checkedAtBlock,
      );
    } catch (error) {
      block("CANONICAL_VERSION_UNAVAILABLE", `Canonical proposal version could not be verified: ${safeErrorMessage(error)}`);
    }
    const descriptionMatches = canonicalVersion !== null && canonicalVersion.description === proposal.description;
    if (canonicalVersion && !descriptionMatches) {
      block("PROPOSAL_DESCRIPTION_STALE", "Canonical proposal description differs from the normalized proposal.");
    }

    const networkChainId = Number(network.chainId);
    if (networkChainId !== CHAIN_ID) block("WRONG_CHAIN", `RPC is connected to chain ${networkChainId}, not Ethereum mainnet.`);
    const governanceCodePresent = hasCode(governanceCode);
    const nounsTokenCodePresent = hasCode(nounsTokenCode);
    if (!governanceCodePresent) block("GOVERNANCE_CODE_MISSING", "Canonical Nouns governance code is missing at the expected address.");
    if (!nounsTokenCodePresent) block("TOKEN_CODE_MISSING", "Canonical Nouns token code is missing at the expected address.");

    const stateCode = Number(stateRaw);
    const active = stateCode === ACTIVE_STATE;
    if (!active) block("PROPOSAL_NOT_ACTIVE", `Canonical proposal state is ${STATE_LABELS[stateCode] || `UNKNOWN_${stateCode}`}, not ACTIVE.`);
    const canonicalId = decimal(field(canonical, "id", 0), "canonical proposal id");
    const canonicalStartBlock = decimal(field(canonical, "startBlock", 5), "canonical start block");
    const canonicalEndBlock = decimal(field(canonical, "endBlock", 6), "canonical end block");
    const proposalIdentityMatches = canonicalId === proposal.id;
    const votingWindowMatches = canonicalStartBlock === proposal.startBlock && canonicalEndBlock === proposal.endBlock;
    const executableActionsMatch = actionsMatch(proposal.actions, canonicalActions(actionResult));
    if (!proposalIdentityMatches) block("CANONICAL_PROPOSAL_MISMATCH", "Canonical proposal ID does not match the normalized proposal.");
    if (!votingWindowMatches) block("VOTING_WINDOW_MISMATCH", "Canonical voting window differs from the normalized proposal.");
    if (!executableActionsMatch) block("EXECUTABLE_ACTION_MISMATCH", "Canonical executable actions differ from the inspected proposal.");

    const hasVoted = Boolean(field(receiptRaw, "hasVoted", 0));
    const receiptSupport = Number(field(receiptRaw, "support", 1) || 0);
    const receiptVotes = decimal(field(receiptRaw, "votes", 2) || 0, "receipt votes");
    if (hasVoted) block("DUPLICATE_VOTE", `Address ${votingAddress} has already voted on proposal ${proposal.id}.`);
    const votingPower = decimal(votingPowerRaw, "snapshot voting power");
    if (BigInt(votingPower) === 0n) block("NO_SNAPSHOT_VOTING_POWER", `Address ${votingAddress} had no voting power at proposal snapshot block ${canonicalStartBlock}.`);
    const modelVoterDelegatee = getAddress(delegateeRaw);
    const delegationMatches = modelVoterDelegatee === votingAddress;
    if (!delegationMatches) {
      block("DELEGATION_MISMATCH", `Asset owner ${assetOwnerAddress} delegates to ${modelVoterDelegatee}, not execution address ${votingAddress}.`);
    }

    const data = voteInterface.encodeFunctionData("castRefundableVoteWithReason", [
      proposal.id,
      SUPPORT_CODES[selectedSupport],
      reason,
      CLIENT_ID,
    ]);
    const unsignedTransaction = {
      kind: "UNSIGNED_EVM_TRANSACTION",
      from: votingAddress,
      to: GOVERNANCE_ADDRESS,
      chainId: CHAIN_ID,
      value: "0",
      data,
      function: "castRefundableVoteWithReason(uint256,uint8,string,uint32)",
    };

    let simulation = { attempted: false, succeeded: false, estimatedGas: null };
    if (blockers.length === 0) {
      simulation.attempted = true;
      try {
        const request = { from: votingAddress, to: GOVERNANCE_ADDRESS, data, value: 0n };
        await this.provider.call(request);
        const estimatedGas = await this.provider.estimateGas(request);
        simulation = { attempted: true, succeeded: true, estimatedGas: decimal(estimatedGas, "estimated gas") };
      } catch (error) {
        block("SIMULATION_FAILED", `Canonical vote simulation failed: ${safeErrorMessage(error)}`);
      }
    }

    const status = blockers.length === 0 ? "READY_TO_SIGN" : "BLOCKED";
    return votePreparationSchema.parse({
      schemaVersion: "1.1.0",
      generatedAt: this.now().toISOString(),
      dao: "nouns",
      chainId: CHAIN_ID,
      proposalId: proposal.id,
      proposalContentHash: proposal.contentHash,
      modelVoter,
      votingAddress,
      addressRoles: {
        modelAddress: modelVoter,
        assetOwnerAddress,
        currentDelegateAddress: modelVoterDelegatee,
        executionAddress: votingAddress,
        requiredDelegateAddress: votingAddress,
      },
      recommendation: prediction.recommendation,
      selectedSupport,
      confidencePercent: prediction.confidencePercent,
      policySource: prediction.policySource,
      policySourceId: prediction.policySourceId,
      reason: { text: reason, source: explicitReason ? "USER_CONFIRMED" : "PREDICTION_DRAFT" },
      flags: prediction.flags,
      predictionReview: {
        requiresHumanReview: predictionReview.requiresHumanReview,
        reviewAcknowledged: predictionReviewAcknowledged,
        autonomyAllowed: predictionReview.autonomyAllowed,
        reasonCodes: predictionReview.reasonCodes,
      },
      security: {
        riskLevel: security?.summary.riskLevel || "CRITICAL",
        requiresHumanReview,
        reviewAcknowledged,
        flags: security?.flags || [],
      },
      verification: {
        checkedAtBlock: decimal(checkedAtBlock, "checked block"),
        governanceAddress: GOVERNANCE_ADDRESS,
        nounsTokenAddress: NOUNS_TOKEN_ADDRESS,
        governanceCodePresent,
        nounsTokenCodePresent,
        proposalState: { code: stateCode, label: STATE_LABELS[stateCode] || `UNKNOWN_${stateCode}`, active },
        proposalIdentityMatches,
        votingWindowMatches,
        executableActionsMatch,
        freshness: {
          verifiedFromCanonicalEvents: canonicalVersion !== null,
          descriptionMatches,
          version: canonicalVersion?.version ?? null,
          latestEvent: canonicalVersion?.latestEvent ?? null,
          latestBlock: canonicalVersion?.latestBlock ?? null,
          eventDigest: canonicalVersion?.eventDigest ?? null,
        },
        receipt: { hasVoted, support: receiptSupport, votes: receiptVotes },
        votingPower: { snapshotBlock: canonicalStartBlock, votes: votingPower, eligible: BigInt(votingPower) > 0n },
        delegation: {
          modelVoterDelegatee,
          assetOwnerAddress,
          currentDelegateAddress: modelVoterDelegatee,
          requiredDelegateAddress: votingAddress,
          matchesVotingAddress: delegationMatches,
        },
        simulation,
      },
      status,
      blockers,
      transaction: status === "READY_TO_SIGN" ? unsignedTransaction : null,
      attribution: { appliedInternally: true, clientId: CLIENT_ID },
    });
  }
}

module.exports = {
  CHAIN_ID,
  CLIENT_ID,
  GOVERNANCE_ADDRESS,
  NOUNS_TOKEN_ADDRESS,
  GOVERNANCE_ABI,
  NOUNS_TOKEN_ABI,
  SUPPORT_CODES,
  canonicalActions,
  actionsMatch,
  NounsVotePreparationAdapter,
};
