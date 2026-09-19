"use strict";

const { BankrGateError } = require("./errors");
const { formatUsdcWithUnit, sanitizeDisplayText, voterLabel } = require("./format");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

function decimalOrNull(value) {
  return typeof value === "string" && UINT.test(value) ? value : null;
}

/**
 * Projects one public Gate profile into an advocate-facing voter row.
 *
 * Every field comes from Gate's own public projection. This integration keeps
 * no parallel voter directory, resolves no ENS of its own, and never infers
 * that a voter is enrolled: a wallet that Gate does not list as accepting is
 * simply not selectable here.
 *
 * `attentionAmount` is INDICATIVE. The authoritative price for a payment is
 * whatever the server-issued quote says, and only that.
 */
function projectVoter(profile, { stage, chainId } = {}) {
  if (!profile || typeof profile !== "object" || typeof profile.wallet !== "string"
      || !ADDRESS.test(profile.wallet)) {
    return null;
  }
  const policies = Array.isArray(profile.policies) ? profile.policies : [];
  const policy = policies.find((entry) => entry && entry.dao === "nouns") || null;
  const acceptedStages = Array.isArray(policy?.acceptedStages)
    ? policy.acceptedStages.filter((entry) => typeof entry === "string")
    : [];
  const attentionAmount = decimalOrNull(policy?.attentionAmount);
  const gavelFeeAmount = decimalOrNull(policy?.gavelFeeAmount);
  const acceptsStage = profile.acceptingSubmissions === true
    && profile.availability === "accepting_now"
    && (stage === undefined || acceptedStages.includes(stage));
  return Object.freeze({
    wallet: profile.wallet.toLowerCase(),
    ens: typeof profile.ens === "string" ? sanitizeDisplayText(profile.ens) : null,
    label: voterLabel(profile),
    availability: profile.availability,
    acceptingSubmissions: profile.acceptingSubmissions === true,
    acceptsStage,
    acceptedStages: Object.freeze([...acceptedStages]),
    supportedStages: Object.freeze(
      Array.isArray(policy?.supportedStages) ? [...policy.supportedStages] : [],
    ),
    attentionAmount,
    gavelFeeAmount,
    indicativeTotalAmount: attentionAmount && gavelFeeAmount
      ? (BigInt(attentionAmount) + BigInt(gavelFeeAmount)).toString(10)
      : null,
    indicativePrice: attentionAmount && gavelFeeAmount
      ? `${formatUsdcWithUnit(attentionAmount, chainId)} attention + ${formatUsdcWithUnit(gavelFeeAmount, chainId)} Gavel fee`
      : null,
    tags: Object.freeze(Array.isArray(policy?.tags) ? policy.tags.filter((tag) => typeof tag === "string") : []),
    governancePower: profile.governancePower && typeof profile.governancePower === "object"
      ? Object.freeze({ ...profile.governancePower })
      : null,
    message: typeof profile.message === "string" ? sanitizeDisplayText(profile.message) : null,
  });
}

/**
 * Lists voters who have opted in through Gate AND accept the requested stage.
 *
 * A voter who has not enrolled cannot appear here, because the only input is
 * Gate's own public directory.
 */
async function discoverVoters(gateApi, { stage, dao = "nouns", minVotingPower, sort = "recent", chainId } = {}) {
  const items = await gateApi.listGates({ dao, availability: "accepting_now", minVotingPower, sort });
  return Object.freeze(
    items
      .map((profile) => projectVoter(profile, { stage, chainId }))
      .filter((voter) => voter && voter.acceptsStage),
  );
}

/** Refuses a voter who is no longer accepting, or no longer accepting this stage. */
function assertVoterAccepts(voter, stage) {
  if (!voter) throw new BankrGateError("VOTER_NOT_ACCEPTING", "That voter is not accepting Gate requests.");
  if (voter.acceptingSubmissions !== true || voter.availability !== "accepting_now") {
    throw new BankrGateError("VOTER_NOT_ACCEPTING", "That voter is not currently accepting Gate requests.");
  }
  if (stage !== undefined && !voter.acceptedStages.includes(stage)) {
    throw new BankrGateError(
      "VOTER_NOT_ACCEPTING",
      stage === "PRE_VOTE"
        ? "That voter is not accepting candidate sponsorship requests."
        : "That voter is not accepting requests about active proposals.",
    );
  }
  return voter;
}

/**
 * Re-reads one voter from Gate and confirms acceptance at selection time.
 *
 * The directory listing can be seconds stale; this read is the one the advocate
 * is shown a price from. Gate still re-checks everything at issuance, and its
 * answer overrides this one.
 */
async function selectVoter(gateApi, wallet, { stage, chainId } = {}) {
  if (typeof wallet !== "string" || !ADDRESS.test(wallet)) {
    throw new BankrGateError("INVALID_REQUEST", "Give the voter's wallet address.");
  }
  const profile = await gateApi.getGate(wallet);
  if (!profile) throw new BankrGateError("VOTER_NOT_ACCEPTING", "Gate has no enrolled voter at that address.");
  return assertVoterAccepts(projectVoter(profile, { stage, chainId }), stage);
}

module.exports = { assertVoterAccepts, discoverVoters, projectVoter, selectVoter };
