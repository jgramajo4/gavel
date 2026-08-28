const crypto = require("node:crypto");

const { historyDocumentSchema, Support } = require("../schema/governance");
const {
  hardRuleSchema,
  profileDocumentSchema,
  statedPreferenceSchema,
} = require("../schema/profile");
const { recencyWeight } = require("./recency");
const { extractProposalFacts } = require("./features");
const { voiceFeatures } = require("./voice");

const SUPPORT_VALUES = Object.values(Support);

function emptyCounts() {
  return { AGAINST: 0, FOR: 0, ABSTAIN: 0 };
}

function rounded(value) {
  return Number(value.toFixed(12));
}

function ensureUniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error(`Duplicate ${label} id: ${item.id}`);
    seen.add(item.id);
  }
}

function evidenceDigest(votes) {
  const evidence = votes.map((vote) => ({
    proposalId: vote.proposalId,
    proposalContentHash: vote.proposalContentHash,
    support: vote.support,
    timestamp: vote.timestamp,
    blockNumber: vote.blockNumber,
    reason: vote.reason,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

function dominantSupport(weightedSupport) {
  const ordered = SUPPORT_VALUES.map((support) => [support, weightedSupport[support]]).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const total = ordered.reduce((sum, [, weight]) => sum + weight, 0);
  if (total === 0 || (ordered[1] && ordered[0][1] === ordered[1][1])) {
    return { support: null, dominance: total === 0 ? 0 : rounded(ordered[0][1] / total) };
  }
  return { support: ordered[0][0], dominance: rounded(ordered[0][1] / total) };
}

function buildVoterProfile(historyInput, options = {}) {
  const history = historyDocumentSchema.parse(historyInput);
  const generatedDate = new Date(options.generatedAt || new Date());
  if (Number.isNaN(generatedDate.getTime())) throw new TypeError("generatedAt must be a valid timestamp");
  const generatedAt = generatedDate.toISOString();
  const asOf = new Date(options.asOf || generatedAt);
  if (Number.isNaN(asOf.getTime())) throw new TypeError("asOf must be a valid timestamp");
  const asOfIso = asOf.toISOString();
  const halfLifeDays = options.halfLifeDays ?? 365;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError("halfLifeDays must be a positive finite number");
  }

  const eligibleVotes = history.votes
    .filter((vote) => new Date(vote.timestamp).getTime() <= asOf.getTime())
    .sort((a, b) => {
      const timestampOrder = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      if (timestampOrder !== 0) return timestampOrder;
      const leftId = BigInt(a.proposalId);
      const rightId = BigInt(b.proposalId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });

  const preferences = (options.statedPreferences || [])
    .map((preference) => statedPreferenceSchema.parse(preference))
    .filter((preference) => new Date(preference.createdAt).getTime() <= asOf.getTime());
  const hardRules = (options.hardRules || [])
    .map((rule) => hardRuleSchema.parse(rule))
    .filter((rule) => new Date(rule.createdAt).getTime() <= asOf.getTime());
  ensureUniqueIds(preferences, "stated preference");
  ensureUniqueIds(hardRules, "hard rule");

  const supportCounts = emptyCounts();
  const weightedSupport = emptyCounts();
  const categories = new Map();
  const precedentIndex = [];
  let weightedVoteCount = 0;

  for (const vote of eligibleVotes) {
    const weight = recencyWeight(vote.timestamp, asOfIso, halfLifeDays);
    const facts = extractProposalFacts(vote.proposal);
    supportCounts[vote.support] += 1;
    weightedSupport[vote.support] += weight;
    weightedVoteCount += weight;

    for (const category of facts.categories) {
      const behavior = categories.get(category) || {
        category,
        voteCount: 0,
        weightedVoteCount: 0,
        supportCounts: emptyCounts(),
        weightedSupport: emptyCounts(),
      };
      behavior.voteCount += 1;
      behavior.weightedVoteCount += weight;
      behavior.supportCounts[vote.support] += 1;
      behavior.weightedSupport[vote.support] += weight;
      categories.set(category, behavior);
    }

    precedentIndex.push({
      proposalId: vote.proposalId,
      proposalContentHash: vote.proposalContentHash,
      title: vote.proposal.title,
      support: vote.support,
      timestamp: vote.timestamp,
      recencyWeight: rounded(weight),
      categories: facts.categories,
      totalActionValueWei: facts.totalActionValueWei,
      recipients: facts.recipients,
      hasReason: Boolean(vote.reason?.trim()),
    });
  }

  const categoryBehavior = [...categories.values()]
    .map((behavior) => {
      const summary = dominantSupport(behavior.weightedSupport);
      return {
        ...behavior,
        weightedVoteCount: rounded(behavior.weightedVoteCount),
        weightedSupport: Object.fromEntries(
          SUPPORT_VALUES.map((support) => [support, rounded(behavior.weightedSupport[support])]),
        ),
        dominantSupport: summary.support,
        dominance: summary.dominance,
      };
    })
    .sort((a, b) => b.weightedVoteCount - a.weightedVoteCount || a.category.localeCompare(b.category));

  const tendencies = categoryBehavior
    .filter((behavior) => behavior.voteCount >= 2 && behavior.dominantSupport && behavior.dominance >= 0.6)
    .map((behavior) => ({
      kind: "CATEGORY_SUPPORT",
      category: behavior.category,
      support: behavior.dominantSupport,
      evidenceCount: behavior.voteCount,
      weightedEvidence: behavior.weightedSupport[behavior.dominantSupport],
      strength: behavior.dominance,
    }));

  return profileDocumentSchema.parse({
    schemaVersion: "1.0.0",
    dao: history.dao,
    chainId: history.chainId,
    voter: history.voter,
    generatedAt,
    asOf: asOfIso,
    sourceHistory: {
      schemaVersion: history.schemaVersion,
      generatedAt: history.generatedAt,
      voteCount: history.voteCount,
      includedVoteCount: eligibleVotes.length,
      excludedFutureVoteCount: history.voteCount - eligibleVotes.length,
      evidenceDigest: evidenceDigest(eligibleVotes),
    },
    recency: {
      method: "exponential-half-life",
      halfLifeDays,
      formula: "weight = 0.5 ^ (ageDays / halfLifeDays)",
    },
    observedBehavior: {
      voteCount: eligibleVotes.length,
      weightedVoteCount: rounded(weightedVoteCount),
      supportCounts,
      weightedSupport: Object.fromEntries(
        SUPPORT_VALUES.map((support) => [support, rounded(weightedSupport[support])]),
      ),
      categories: categoryBehavior,
      tendencies,
      precedentIndex,
      voice: voiceFeatures(eligibleVotes),
    },
    statedPreferences: preferences,
    hardRules,
  });
}

module.exports = { buildVoterProfile, dominantSupport, evidenceDigest };
