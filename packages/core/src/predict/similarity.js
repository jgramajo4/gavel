const { ProfileCategory } = require("../schema/profile");
const { extractProposalFacts } = require("../profile/features");

const TITLE_STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "been", "being", "from", "have", "into",
  "nouns", "noun", "proposal", "that", "their", "there", "these", "this", "those", "with",
]);

function rounded(value) {
  return Number(value.toFixed(12));
}

function tokenSet(value) {
  return new Set(
    (value.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || []).filter(
      (token) => !TITLE_STOP_WORDS.has(token),
    ),
  );
}

function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

function log10IntegerString(value) {
  const normalized = value.replace(/^0+/, "") || "0";
  if (normalized === "0") return 0;
  const leading = Number(normalized.slice(0, 15));
  return normalized.length - 1 + Math.log10(leading / 10 ** (normalized.slice(0, 15).length - 1));
}

function amountSimilarity(left, right) {
  if (left === "0" && right === "0") return 1;
  if (left === "0" || right === "0") return 0;
  const distance = Math.abs(log10IntegerString(left) - log10IntegerString(right));
  return 1 / (1 + distance);
}

function categorySimilarity(leftCategories, rightCategories) {
  const withoutOther = (categories) =>
    new Set(categories.filter((category) => category !== ProfileCategory.OTHER));
  return jaccard(withoutOther(leftCategories), withoutOther(rightCategories));
}

function precedentSimilarity(precedent, targetProposal) {
  const targetFacts = extractProposalFacts(targetProposal);
  const category = categorySimilarity(precedent.categories, targetFacts.categories);
  const amount = amountSimilarity(precedent.totalActionValueWei, targetFacts.totalActionValueWei);
  const title = jaccard(tokenSet(precedent.title), tokenSet(targetProposal.title));
  const precedentRecipients = new Set(precedent.recipients.map((address) => address.toLowerCase()));
  const targetRecipients = new Set(targetFacts.recipients.map((address) => address.toLowerCase()));
  const hasRecipients = precedentRecipients.size > 0 || targetRecipients.size > 0;
  const recipient = hasRecipients ? jaccard(precedentRecipients, targetRecipients) : null;

  const weightedSignals = [
    [category, 0.45],
    [amount, 0.25],
    [title, 0.1],
  ];
  if (recipient !== null) weightedSignals.push([recipient, 0.2]);
  const weightTotal = weightedSignals.reduce((sum, [, weight]) => sum + weight, 0);
  const similarity = weightedSignals.reduce((sum, [score, weight]) => sum + score * weight, 0) / weightTotal;

  return {
    similarity: rounded(similarity),
    signals: {
      category: rounded(category),
      amount: rounded(amount),
      recipient: recipient === null ? null : rounded(recipient),
      title: rounded(title),
    },
    targetFacts,
  };
}

function retrievePrecedents(profile, targetProposal, options = {}) {
  const threshold = options.threshold ?? 0.15;
  const limit = options.limit ?? 8;
  const asOf = new Date(options.asOf || new Date());
  const profileAsOf = new Date(profile.asOf);
  if (Number.isNaN(asOf.getTime())) throw new TypeError("asOf must be a valid timestamp");
  if (asOf.getTime() < profileAsOf.getTime()) {
    throw new RangeError("prediction asOf cannot be earlier than profile asOf");
  }
  const ageDays = (asOf.getTime() - profileAsOf.getTime()) / (24 * 60 * 60 * 1000);
  const stalenessFactor = 0.5 ** (ageDays / profile.recency.halfLifeDays);

  return profile.observedBehavior.precedentIndex
    .filter(
      (precedent) =>
        precedent.proposalContentHash !== targetProposal.contentHash &&
        precedent.proposalId !== targetProposal.id,
    )
    .map((precedent) => {
      const result = precedentSimilarity(precedent, targetProposal);
      const recency = Math.min(1, precedent.recencyWeight * stalenessFactor);
      const evidenceWeight = result.similarity * (0.35 + 0.65 * recency);
      return {
        precedent,
        similarity: result.similarity,
        evidenceWeight: rounded(evidenceWeight),
        signals: { ...result.signals, recency: rounded(recency) },
      };
    })
    .filter((result) => result.similarity >= threshold)
    .sort((a, b) => {
      const evidenceOrder = b.evidenceWeight - a.evidenceWeight;
      if (evidenceOrder !== 0) return evidenceOrder;
      const similarityOrder = b.similarity - a.similarity;
      if (similarityOrder !== 0) return similarityOrder;
      const recencyOrder = b.precedent.recencyWeight - a.precedent.recencyWeight;
      if (recencyOrder !== 0) return recencyOrder;
      const leftId = BigInt(a.precedent.proposalId);
      const rightId = BigInt(b.precedent.proposalId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    })
    .slice(0, limit);
}

module.exports = {
  amountSimilarity,
  categorySimilarity,
  jaccard,
  precedentSimilarity,
  retrievePrecedents,
  tokenSet,
};
