function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

function rounded(value) {
  return Number(clamp(value).toFixed(12));
}

function weightedAverage(items, valueSelector) {
  const totalWeight = items.reduce((sum, item) => sum + item.evidenceWeight, 0);
  if (totalWeight === 0) return 0;
  return items.reduce((sum, item) => sum + valueSelector(item) * item.evidenceWeight, 0) / totalWeight;
}

function heuristicConfidence({ supportScores, precedents, profileVoteCount, policySource }) {
  const orderedScores = Object.values(supportScores).sort((a, b) => b - a);
  const margin = orderedScores[0] - orderedScores[1];
  const weightedEvidence = precedents.reduce((sum, precedent) => sum + precedent.evidenceWeight, 0);
  const similarity = weightedAverage(precedents.slice(0, 3), (precedent) => precedent.similarity);
  const sufficiency = 1 - Math.exp(-weightedEvidence / 3);
  const recency = weightedAverage(precedents, (precedent) => precedent.signals.recency);
  const historyDepth = Math.min(1, profileVoteCount / 50);
  const policyOverride = policySource === "HARD_RULE" ? 1 : policySource === "STATED_PREFERENCE" ? 0.75 : 0;

  let confidence =
    0.34 +
    0.22 * margin +
    0.16 * similarity +
    0.14 * sufficiency +
    0.1 * recency +
    0.04 * historyDepth;
  if (policySource === "HARD_RULE") confidence = 1;
  else if (policySource === "STATED_PREFERENCE") confidence = Math.max(confidence, 0.85);

  return {
    confidence: rounded(confidence),
    breakdown: {
      margin: rounded(margin),
      similarity: rounded(similarity),
      sufficiency: rounded(sufficiency),
      recency: rounded(recency),
      historyDepth: rounded(historyDepth),
      policyOverride,
    },
  };
}

module.exports = { heuristicConfidence };
