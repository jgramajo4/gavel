const { normalizedProposalSchema, Support } = require("../schema/governance");
const { predictionDocumentSchema } = require("../schema/prediction");
const { profileDocumentSchema } = require("../schema/profile");
const { extractProposalFacts } = require("../profile/features");
const { resolveLayeredPolicy } = require("../profile/policy");
const { heuristicConfidence } = require("./confidence");
const { generateDraftReason } = require("./reason");
const { retrievePrecedents } = require("./similarity");

const SUPPORT_ORDER = [Support.FOR, Support.AGAINST, Support.ABSTAIN];
const DEFAULT_THRESHOLD = 0.15;
const DEFAULT_MAX_PRECEDENTS = 8;

function rounded(value) {
  return Number(value.toFixed(12));
}

function addDistribution(scores, distribution, strength) {
  const total = Object.values(distribution).reduce((sum, value) => sum + value, 0);
  if (total === 0) return;
  for (const support of SUPPORT_ORDER) scores[support] += (distribution[support] / total) * strength;
}

function normalizeScores(scores) {
  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(SUPPORT_ORDER.map((support) => [support, rounded(scores[support] / total)]));
}

function observedScores(profile, targetFacts, precedents) {
  // A small non-abstain-biased prior breaks an evidence-free tie without using
  // ABSTAIN as a synonym for uncertainty.
  const scores = { FOR: 0.34, AGAINST: 0.33, ABSTAIN: 0.2 };
  addDistribution(scores, profile.observedBehavior.weightedSupport, 0.5);

  const matchingCategories = profile.observedBehavior.categories.filter((behavior) =>
    targetFacts.categories.includes(behavior.category),
  );
  const categoryStrength = matchingCategories.length === 0 ? 0 : 0.75 / matchingCategories.length;
  for (const behavior of matchingCategories) {
    addDistribution(scores, behavior.weightedSupport, categoryStrength);
  }
  for (const precedent of precedents) {
    scores[precedent.precedent.support] += precedent.evidenceWeight;
  }

  const precedentWeight = precedents.reduce((sum, precedent) => sum + precedent.evidenceWeight, 0);
  const abstainPrecedentWeight = precedents
    .filter((precedent) => precedent.precedent.support === Support.ABSTAIN)
    .reduce((sum, precedent) => sum + precedent.evidenceWeight, 0);
  const explicitAbstainPattern =
    (precedentWeight > 0 && abstainPrecedentWeight / precedentWeight >= 0.5) ||
    matchingCategories.some((behavior) => behavior.dominantSupport === Support.ABSTAIN);
  if (!explicitAbstainPattern) scores.ABSTAIN *= 0.65;

  return normalizeScores(scores);
}

function selectRecommendation(scores) {
  return [...SUPPORT_ORDER].sort((a, b) => scores[b] - scores[a] || SUPPORT_ORDER.indexOf(a) - SUPPORT_ORDER.indexOf(b))[0];
}

function buildReasoning({ profile, recommendation, policy, precedents, scores }) {
  const reasoning = [];
  if (policy.source === "HARD_RULE") {
    reasoning.push(`Hard rule ${policy.sourceId} deterministically overrides inferred behavior.`);
  } else if (policy.source === "STATED_PREFERENCE") {
    reasoning.push(`Stated preference ${policy.sourceId} overrides older observed behavior.`);
  } else if (profile.observedBehavior.voteCount === 0) {
    reasoning.push("No historical votes are available; this is a low-confidence prior, not a personalized result.");
  } else {
    reasoning.push(
      `Observed evidence assigns ${Math.round(scores[recommendation] * 100)}% of the heuristic decision score to ${recommendation}.`,
    );
  }

  if (precedents.length > 0) {
    const matching = precedents.filter((precedent) => precedent.precedent.support === recommendation).length;
    reasoning.push(`${matching} of the ${precedents.length} strongest scored precedents match ${recommendation}.`);
    const closest = [...precedents].sort((a, b) => b.similarity - a.similarity)[0];
    reasoning.push(
      `Closest structural precedent: proposal ${closest.precedent.proposalId} at ${Math.round(closest.similarity * 100)}% similarity.`,
    );
  } else {
    reasoning.push("No historical proposal crossed the minimum structural-similarity threshold.");
  }
  return reasoning;
}

function buildFlags({ profile, policy, precedents, supportScores, asOf }) {
  const flags = ["Confidence is heuristic and has not yet been calibrated by chronological backtesting."];
  if (profile.observedBehavior.voteCount === 0) flags.push("No historical voting evidence is available.");
  else if (profile.observedBehavior.voteCount < 5) flags.push("Fewer than five historical votes are available.");
  if (precedents.length === 0) flags.push("No sufficiently similar historical precedent was found.");
  else if (precedents[0].similarity < 0.3) flags.push("The closest historical precedent is weakly similar.");

  const ordered = Object.values(supportScores).sort((a, b) => b - a);
  if (profile.observedBehavior.voteCount > 0 && ordered[0] - ordered[1] < 0.1) {
    flags.push("Historical evidence is conflicting.");
  }
  const profileAgeDays = (new Date(asOf).getTime() - new Date(profile.asOf).getTime()) / (24 * 60 * 60 * 1000);
  if (profileAgeDays > profile.recency.halfLifeDays) flags.push("The voter profile is older than one recency half-life.");
  if (policy.source !== "OBSERVED_BEHAVIOR") flags.push(`${policy.source} overrides the inferred recommendation.`);
  flags.push(...policy.flags);
  return [...new Set(flags)];
}

function predictVote(profileInput, proposalInput, options = {}) {
  const profile = profileDocumentSchema.parse(profileInput);
  const proposal = normalizedProposalSchema.parse(proposalInput);
  const targetAlreadyObserved = profile.observedBehavior.precedentIndex.some(
    (precedent) =>
      precedent.proposalId === proposal.id || precedent.proposalContentHash === proposal.contentHash,
  );
  if (targetAlreadyObserved) {
    throw new Error(
      "Target proposal is already present in profile evidence; rebuild the profile with an asOf cutoff before that vote",
    );
  }
  const generatedDate = new Date(options.generatedAt || new Date());
  if (Number.isNaN(generatedDate.getTime())) throw new TypeError("generatedAt must be a valid timestamp");
  const generatedAt = generatedDate.toISOString();
  const asOfDate = new Date(options.asOf || generatedAt);
  if (Number.isNaN(asOfDate.getTime())) throw new TypeError("asOf must be a valid timestamp");
  const asOf = asOfDate.toISOString();
  const threshold = options.relevantSimilarityThreshold ?? DEFAULT_THRESHOLD;
  const maxPrecedents = options.maxPrecedents ?? DEFAULT_MAX_PRECEDENTS;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError("relevantSimilarityThreshold must be between 0 and 1");
  }
  if (!Number.isInteger(maxPrecedents) || maxPrecedents <= 0) {
    throw new RangeError("maxPrecedents must be a positive integer");
  }

  const targetFacts = extractProposalFacts(proposal);
  const precedents = retrievePrecedents(profile, proposal, {
    asOf,
    threshold,
    limit: maxPrecedents,
  });
  const supportScores = observedScores(profile, targetFacts, precedents);
  const observedRecommendation = selectRecommendation(supportScores);
  const policy = resolveLayeredPolicy({ profile, proposal, observedRecommendation });
  const recommendation = policy.recommendation;
  const confidenceResult = heuristicConfidence({
    supportScores,
    precedents,
    profileVoteCount: profile.observedBehavior.voteCount,
    policySource: policy.source,
  });
  const flags = buildFlags({ profile, policy, precedents, supportScores, asOf });
  const draftReason = generateDraftReason({
    profile,
    recommendation,
    precedents: precedents.slice(0, 5),
    confidence: confidenceResult.confidence,
    policySource: policy.source,
    targetFacts,
  });
  if (!draftReason.available) flags.push("Insufficient writing evidence to draft a reason in this voter's style.");

  const mappedPrecedents = precedents.slice(0, 5).map((entry) => ({
    proposalId: entry.precedent.proposalId,
    title: entry.precedent.title,
    vote: entry.precedent.support,
    timestamp: entry.precedent.timestamp,
    similarity: entry.similarity,
    evidenceWeight: entry.evidenceWeight,
    signals: entry.signals,
  }));

  return predictionDocumentSchema.parse({
    schemaVersion: "1.0.0",
    generatedAt,
    asOf,
    dao: profile.dao,
    chainId: profile.chainId,
    voter: profile.voter,
    proposalId: proposal.id,
    proposalContentHash: proposal.contentHash,
    recommendation,
    confidence: confidenceResult.confidence,
    confidencePercent: Math.round(confidenceResult.confidence * 100),
    confidenceCalibrated: false,
    policySource: policy.source,
    policySourceId: policy.sourceId,
    precedents: mappedPrecedents,
    reasoning: buildReasoning({
      profile,
      recommendation,
      policy,
      precedents: precedents.slice(0, 5),
      scores: supportScores,
    }),
    flags,
    draftReason,
    evidence: {
      profileVoteCount: profile.observedBehavior.voteCount,
      candidatePrecedentCount: profile.observedBehavior.precedentIndex.length,
      relevantPrecedentCount: precedents.length,
      supportScores,
      confidenceBreakdown: confidenceResult.breakdown,
    },
    method: {
      name: "gavel-evidence-heuristic",
      version: "1.0.0",
      calibrated: false,
      relevantSimilarityThreshold: threshold,
      maxScoredPrecedents: maxPrecedents,
    },
  });
}

module.exports = {
  buildFlags,
  normalizeScores,
  observedScores,
  predictVote,
  selectRecommendation,
};
