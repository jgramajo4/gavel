const { createHash } = require("node:crypto");

const { Contract, Interface, getAddress } = require("ethers");

const { normalizedProposalSchema, Support } = require("../../core/src/schema/governance");
const { predictionDocumentSchema } = require("../../core/src/schema/prediction");
const { inspectNounsProposal } = require("../../nouns-adapter/src/security");

const CHAIN_ID = 1;
const RAILGUN_VOTING_ADDRESS = getAddress("0xc480F68A3dcC3EdD82134FAB45C14A0FcF1dA3CC");
const RAILGUN_STAKING_ADDRESS = getAddress("0xEE6A649Aa3766bD117e12C161726b693A1B2Ee20");
const RAILGUN_DELEGATOR_ADDRESS = getAddress("0xB6d513f6222Ee92Fff975E901bd792E2513fB53B");
const RAILGUN_TOKEN_ADDRESS = getAddress("0xe76C6c83af64e4C60245D8C7dE953DF673a7A33D");

const VOTING_START_OFFSET = 2 * 24 * 60 * 60;
const VOTING_YAY_END_OFFSET = 5 * 24 * 60 * 60;
const VOTING_NAY_END_OFFSET = 6 * 24 * 60 * 60;
const SPONSOR_WINDOW = 30 * 24 * 60 * 60;
const QUORUM = 2_000_000n * 10n ** 18n;

const RAILGUN_VOTING_ABI = [
  "function proposalsLength() view returns (uint256)",
  "function proposals(uint256 id) view returns (bool executed,address proposer,string proposalDocument,uint256 publishTime,uint256 voteCallTime,uint256 sponsorship,uint256 yayVotes,uint256 nayVotes,uint256 sponsorInterval,uint256 votingInterval)",
  "function getActions(uint256 id) view returns ((address callContract,bytes data,uint256 value)[])",
  "function getVotes(uint256 id,address account) view returns (uint256)",
  "function votingKey(address account) view returns (address)",
  "function vote(uint256 id,uint256 amount,bool affirmative,address account,uint256 hint)",
];
const RAILGUN_STAKING_ABI = [
  "function votingPower(address account) view returns (uint256)",
  "function accountSnapshotLength(address account) view returns (uint256)",
  "function accountSnapshot(address account,uint256 index) view returns (uint256 interval,uint256 votingPower)",
  "function accountSnapshotAt(address account,uint256 interval,uint256 hint) view returns (uint256 snapshotInterval,uint256 votingPower)",
];
const votingInterface = new Interface(RAILGUN_VOTING_ABI);

function field(value, name, index) {
  return value?.[name] ?? value?.[index];
}

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

function canonicalActions(actionResult) {
  return Array.from(actionResult || []).map((action, index) => ({
    index,
    target: getAddress(field(action, "callContract", 0)),
    valueWei: decimal(field(action, "value", 2), `action ${index} value`),
    signature: "",
    calldata: String(field(action, "data", 1)).toLowerCase(),
  }));
}

function actionsMatch(local, canonical) {
  if (local.length !== canonical.length) return false;
  return local.every((action, index) => {
    const expected = canonical[index];
    return action.index === expected.index && getAddress(action.target) === expected.target &&
      action.valueWei === expected.valueWei && action.signature === "" &&
      action.calldata.toLowerCase() === expected.calldata;
  });
}

function railgunProposalContentHash(proposalResult, actions) {
  const material = JSON.stringify({
    proposalDocument: String(field(proposalResult, "proposalDocument", 2)),
    actions: actions.map(({ target, valueWei, calldata }) => ({ target, valueWei, calldata })),
  });
  return createHash("sha256").update(material).digest("hex");
}

function stateAt(proposalResult, nowSeconds, support) {
  const executed = Boolean(field(proposalResult, "executed", 0));
  const publishTime = Number(field(proposalResult, "publishTime", 3));
  const voteCallTime = Number(field(proposalResult, "voteCallTime", 4));
  const yayVotes = BigInt(field(proposalResult, "yayVotes", 6));
  const nayVotes = BigInt(field(proposalResult, "nayVotes", 7));
  if (executed) return { code: 7, label: "EXECUTED", active: false };
  if (voteCallTime === 0) {
    return nowSeconds < publishTime + SPONSOR_WINDOW
      ? { code: 0, label: "SPONSORING", active: false }
      : { code: 3, label: "SPONSORSHIP_EXPIRED", active: false };
  }
  if (nowSeconds <= voteCallTime + VOTING_START_OFFSET) return { code: 0, label: "REVIEW", active: false };
  const end = support === Support.FOR ? VOTING_YAY_END_OFFSET : VOTING_NAY_END_OFFSET;
  if (nowSeconds < voteCallTime + end) {
    return { code: 1, label: nowSeconds < voteCallTime + VOTING_YAY_END_OFFSET ? "ACTIVE" : "ACTIVE_NAY_ONLY", active: true };
  }
  const passed = yayVotes >= QUORUM && yayVotes > nayVotes;
  return { code: passed ? 4 : 3, label: passed ? "SUCCEEDED" : "DEFEATED", active: false };
}

async function findAccountSnapshotHint(staking, account, interval) {
  const length = Number(await staking.accountSnapshotLength(account));
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const snapshot = await staking.accountSnapshot(account, middle);
    if (BigInt(field(snapshot, "interval", 0)) >= BigInt(interval)) high = middle;
    else low = middle + 1;
  }
  return low;
}

class RailgunDaoAdapter {
  constructor(options) {
    if (!options?.provider) throw new TypeError("A JSON-RPC provider is required");
    this.id = "railgun-eth";
    this.chainId = CHAIN_ID;
    this.governanceContracts = Object.freeze({
      governor: RAILGUN_VOTING_ADDRESS,
      voting: RAILGUN_VOTING_ADDRESS,
      staking: RAILGUN_STAKING_ADDRESS,
      delegator: RAILGUN_DELEGATOR_ADDRESS,
      token: RAILGUN_TOKEN_ADDRESS,
    });
    this.capabilities = Object.freeze({
      analyze: true,
      predict: true,
      prepareVote: true,
      safeSupervised: false,
      waapAutonomous: false,
    });
    this.supportedActions = Object.freeze(["CAST_VOTE"]);
    this.provider = options.provider;
    this.voting = options.voting || new Contract(RAILGUN_VOTING_ADDRESS, RAILGUN_VOTING_ABI, options.provider);
    this.staking = options.staking || new Contract(RAILGUN_STAKING_ADDRESS, RAILGUN_STAKING_ABI, options.provider);
    this.now = options.now || (() => new Date());
  }

  validateProposal(proposal) {
    return inspectNounsProposal(proposal);
  }

  async getVotingPower(address) {
    return this.staking.votingPower(address);
  }

  async getCurrentDelegate(address) {
    return getAddress(address);
  }

  async hasVoted(proposalId, address) {
    return BigInt(await this.voting.getVotes(proposalId, address)) > 0n;
  }

  async fetchProposal(proposalId) {
    const id = decimal(proposalId, "proposal id");
    const [proposalResult, actionResult, latestBlock] = await Promise.all([
      this.voting.proposals(id),
      this.voting.getActions(id),
      this.provider.getBlock("latest"),
    ]);
    const actions = canonicalActions(actionResult);
    const publishTime = Number(field(proposalResult, "publishTime", 3));
    const voteCallTime = Number(field(proposalResult, "voteCallTime", 4));
    const state = stateAt(proposalResult, Number(latestBlock.timestamp), Support.AGAINST);
    const yayVotes = decimal(field(proposalResult, "yayVotes", 6), "yay votes");
    const nayVotes = decimal(field(proposalResult, "nayVotes", 7), "nay votes");
    const proposalDocument = String(field(proposalResult, "proposalDocument", 2));
    return normalizedProposalSchema.parse({
      id,
      contentHash: railgunProposalContentHash(proposalResult, actions),
      title: `Railgun proposal ${id}`,
      description: proposalDocument.startsWith("ipfs://") ? proposalDocument : `ipfs://${proposalDocument}`,
      proposer: getAddress(field(proposalResult, "proposer", 1)),
      state: state.label,
      outcome: state.label,
      createdBlock: "0",
      createdAt: new Date(publishTime * 1000).toISOString(),
      startBlock: "0",
      endBlock: "0",
      quorumVotes: QUORUM.toString(),
      forVotes: yayVotes,
      againstVotes: nayVotes,
      abstainVotes: "0",
      actions,
      dao: this.id,
      chainId: CHAIN_ID,
      venue: "railgun-voting",
      timing: "timestamp",
      startTime: voteCallTime ? new Date((voteCallTime + VOTING_START_OFFSET) * 1000).toISOString() : null,
      endTime: voteCallTime ? new Date((voteCallTime + VOTING_NAY_END_OFFSET) * 1000).toISOString() : null,
      metadataUrl: proposalDocument.startsWith("ipfs://") ? proposalDocument : `ipfs://${proposalDocument}`,
      choices: [Support.AGAINST, Support.FOR],
    });
  }

  async prepareVote(input) {
    const selectedSupport = String(input.selectedSupport || "").toUpperCase();
    if (selectedSupport === Support.ABSTAIN) throw new Error("Railgun governance does not support ABSTAIN");
    if (![Support.AGAINST, Support.FOR].includes(selectedSupport)) throw new Error("selectedSupport must be AGAINST or FOR");
    const prediction = predictionDocumentSchema.parse(input.prediction);
    const proposal = normalizedProposalSchema.parse(input.proposal);
    if (input.reason?.trim()) throw new Error("Railgun votes do not support an on-chain reason");
    const modelVoter = getAddress(prediction.voter);
    const account = getAddress(input.assetOwnerAddress || prediction.voter);
    const votingAddress = getAddress(input.executionAddress || input.votingAddress || prediction.voter);
    const blockers = [];
    const block = (code, message) => blockers.push({ code, message });
    if (prediction.dao !== this.id || prediction.chainId !== CHAIN_ID) block("PREDICTION_NETWORK_MISMATCH", "Prediction is not for Railgun Ethereum governance.");
    if (prediction.proposalId !== proposal.id || prediction.proposalContentHash !== proposal.contentHash) block("PREDICTION_PROPOSAL_MISMATCH", "Prediction does not match the supplied normalized proposal.");
    if (selectedSupport !== prediction.recommendation) block("RECOMMENDATION_NOT_CONFIRMED", `Selected support ${selectedSupport} does not confirm recommendation ${prediction.recommendation}.`);
    const predictionReview = prediction.predictionReview || { requiresHumanReview: true, autonomyAllowed: false, reasonCodes: ["LEGACY_PREDICTION_REQUIRES_REVIEW"] };
    const predictionReviewAcknowledged = Boolean(input.acknowledgePredictionReview);
    if (predictionReview.requiresHumanReview && !predictionReviewAcknowledged) block("PREDICTION_REVIEW_REQUIRED", "This recommendation requires explicit human review acknowledgement.");
    const security = prediction.security;
    if (!security || security.proposalContentHash !== proposal.contentHash) block("SECURITY_REPORT_MISSING_OR_STALE", "A matching structural proposal inspection is required.");
    if (security?.flags.some((flag) => flag.severity === "CRITICAL")) block("CRITICAL_SECURITY_FINDING", "Critical structural findings prevent transaction preparation.");
    const securityReviewAcknowledged = Boolean(input.acknowledgeSecurityReview);
    if (security?.summary.requiresHumanReview && !securityReviewAcknowledged) block("SECURITY_REVIEW_REQUIRED", "Structural findings require explicit human review acknowledgement.");

    const [network, checkedAtBlock, latestBlock, votingCode, stakingCode, proposalResult, actionResult, alreadyUsedRaw, configuredVotingKey] = await Promise.all([
      this.provider.getNetwork(),
      this.provider.getBlockNumber(),
      this.provider.getBlock("latest"),
      this.provider.getCode(RAILGUN_VOTING_ADDRESS),
      this.provider.getCode(RAILGUN_STAKING_ADDRESS),
      this.voting.proposals(proposal.id),
      this.voting.getActions(proposal.id),
      this.voting.getVotes(proposal.id, account),
      this.voting.votingKey(account),
    ]);
    if (Number(network.chainId) !== CHAIN_ID) block("WRONG_CHAIN", "RPC is not Ethereum mainnet.");
    if (!hasCode(votingCode)) block("GOVERNANCE_CODE_MISSING", "Railgun Voting code is missing at the canonical address.");
    if (!hasCode(stakingCode)) block("STAKING_CODE_MISSING", "Railgun Staking code is missing at the canonical address.");
    const state = stateAt(proposalResult, Number(latestBlock.timestamp), selectedSupport);
    if (!state.active) block("PROPOSAL_NOT_ACTIVE", `Railgun proposal state is ${state.label} for ${selectedSupport}.`);
    const chainActions = canonicalActions(actionResult);
    const executableActionsMatch = actionsMatch(proposal.actions, chainActions);
    if (!executableActionsMatch) block("EXECUTABLE_ACTION_MISMATCH", "Canonical Railgun actions differ from the normalized proposal.");
    const canonicalContentHash = railgunProposalContentHash(proposalResult, chainActions);
    const proposalIdentityMatches = canonicalContentHash === proposal.contentHash;
    if (!proposalIdentityMatches) block("CANONICAL_PROPOSAL_MISMATCH", "Canonical Railgun document or actions differ from the normalized proposal.");
    const votingInterval = decimal(field(proposalResult, "votingInterval", 9), "voting interval");
    let hint;
    try {
      hint = input.hint == null ? await findAccountSnapshotHint(this.staking, account, votingInterval) : Number(decimal(input.hint, "snapshot hint"));
    } catch (error) {
      block("SNAPSHOT_HINT_UNAVAILABLE", `Railgun snapshot hint could not be computed: ${safeErrorMessage(error)}`);
      hint = 0;
    }
    let snapshotPower = 0n;
    try {
      const snapshot = await this.staking.accountSnapshotAt(account, votingInterval, hint);
      snapshotPower = BigInt(field(snapshot, "votingPower", 1));
    } catch (error) {
      block("SNAPSHOT_UNAVAILABLE", `Railgun voting-power snapshot could not be read: ${safeErrorMessage(error)}`);
    }
    const alreadyUsed = BigInt(alreadyUsedRaw);
    const remaining = snapshotPower > alreadyUsed ? snapshotPower - alreadyUsed : 0n;
    const amount = input.amount == null ? remaining : BigInt(decimal(input.amount, "vote amount"));
    if (amount === 0n) block("NO_REMAINING_VOTING_POWER", `${account} has no remaining Railgun voting power for proposal ${proposal.id}.`);
    if (amount > remaining) block("VOTE_AMOUNT_EXCEEDS_POWER", `Requested ${amount} votes but only ${remaining} remain.`);
    const votingKey = getAddress(configuredVotingKey);
    const authorized = votingAddress === account || votingKey === votingAddress;
    if (!authorized) block("VOTING_KEY_MISMATCH", `${votingAddress} is not the account or configured voting key for ${account}.`);

    const data = votingInterface.encodeFunctionData("vote", [proposal.id, amount, selectedSupport === Support.FOR, account, hint]);
    let simulation = { attempted: false, succeeded: false, estimatedGas: null };
    if (blockers.length === 0) {
      simulation.attempted = true;
      try {
        const request = { from: votingAddress, to: RAILGUN_VOTING_ADDRESS, data, value: 0n };
        await this.provider.call(request);
        simulation = { attempted: true, succeeded: true, estimatedGas: decimal(await this.provider.estimateGas(request), "estimated gas") };
      } catch (error) {
        block("SIMULATION_FAILED", `Railgun vote simulation failed: ${safeErrorMessage(error)}`);
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
      addressRoles: { modelAddress: modelVoter, assetOwnerAddress: account, currentDelegateAddress: account, executionAddress: votingAddress, requiredDelegateAddress: votingAddress },
      recommendation: prediction.recommendation,
      selectedSupport,
      confidencePercent: prediction.confidencePercent,
      policySource: prediction.policySource,
      policySourceId: prediction.policySourceId,
      reason: { text: null, source: "UNSUPPORTED" },
      flags: prediction.flags,
      predictionReview: { ...predictionReview, reviewAcknowledged: predictionReviewAcknowledged },
      security: { riskLevel: security?.summary.riskLevel || "CRITICAL", requiresHumanReview: security?.summary.requiresHumanReview || false, reviewAcknowledged: securityReviewAcknowledged, flags: security?.flags || [] },
      verification: {
        checkedAtBlock: decimal(checkedAtBlock, "checked block"),
        governanceAddress: RAILGUN_VOTING_ADDRESS,
        stakingAddress: RAILGUN_STAKING_ADDRESS,
        governanceCodePresent: hasCode(votingCode),
        stakingCodePresent: hasCode(stakingCode),
        proposalState: state,
        proposalIdentityMatches,
        votingWindowMatches: state.active,
        executableActionsMatch,
        receipt: { hasVoted: alreadyUsed > 0n, votes: alreadyUsed.toString() },
        votingPower: { snapshotInterval: votingInterval, snapshotHint: hint, votes: snapshotPower.toString(), used: alreadyUsed.toString(), remaining: remaining.toString(), selectedAmount: amount.toString(), eligible: amount > 0n && amount <= remaining },
        votingKey: { account, configuredVotingKey: votingKey, authorized },
        simulation,
      },
      status,
      blockers,
      transaction: status === "READY_TO_SIGN" ? { kind: "UNSIGNED_EVM_TRANSACTION", from: votingAddress, to: RAILGUN_VOTING_ADDRESS, chainId: CHAIN_ID, value: "0", data, function: "vote(uint256,uint256,bool,address,uint256)" } : null,
      attribution: { appliedInternally: false, clientId: null },
    };
  }
}

module.exports = {
  CHAIN_ID,
  RAILGUN_VOTING_ADDRESS,
  RAILGUN_STAKING_ADDRESS,
  RAILGUN_DELEGATOR_ADDRESS,
  RAILGUN_TOKEN_ADDRESS,
  RAILGUN_VOTING_ABI,
  RAILGUN_STAKING_ABI,
  QUORUM,
  canonicalActions,
  actionsMatch,
  railgunProposalContentHash,
  stateAt,
  findAccountSnapshotHint,
  RailgunDaoAdapter,
};
