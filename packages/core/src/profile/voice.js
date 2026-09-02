const STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "because", "been", "being", "between",
  "could", "from", "have", "into", "just", "more", "most", "much", "only", "other",
  "over", "proposal", "should", "some", "than", "that", "their", "there", "these", "they",
  "this", "those", "through", "very", "vote", "what", "when", "where", "which", "while",
  "with", "would", "your", "nouns", "noun", "support", "supporting",
]);

function words(reason) {
  return reason.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
}

function rounded(value) {
  return Number(value.toFixed(6));
}

function voiceFeatures(votes) {
  const reasons = votes.map((vote) => vote.reason?.trim()).filter(Boolean);
  if (reasons.length === 0) {
    return {
      reasonCount: 0,
      reasonCoverage: 0,
      medianWords: 0,
      averageWords: 0,
      typicalLength: "NONE",
      firstPersonRate: 0,
      caveatRate: 0,
      questionRate: 0,
      commonTerms: [],
    };
  }

  const lengths = reasons.map((reason) => words(reason).length).sort((a, b) => a - b);
  const middle = Math.floor(lengths.length / 2);
  const median = lengths.length % 2 ? lengths[middle] : (lengths[middle - 1] + lengths[middle]) / 2;
  const average = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
  const rate = (pattern) => reasons.filter((reason) => pattern.test(reason)).length / reasons.length;
  const frequencies = new Map();

  for (const reason of reasons) {
    for (const word of words(reason)) {
      if (STOP_WORDS.has(word)) continue;
      frequencies.set(word, (frequencies.get(word) || 0) + 1);
    }
  }

  let typicalLength = "LONG";
  if (median <= 5) typicalLength = "TERSE";
  else if (median <= 20) typicalLength = "BRIEF";
  else if (median <= 60) typicalLength = "DETAILED";

  return {
    reasonCount: reasons.length,
    reasonCoverage: rounded(reasons.length / Math.max(votes.length, 1)),
    medianWords: rounded(median),
    averageWords: rounded(average),
    typicalLength,
    firstPersonRate: rounded(rate(/\b(i|i'm|i’ve|i've|my|we|we're|our)\b/i)),
    caveatRate: rounded(rate(/\b(but|however|although|though|while|caveat|concern)\b/i)),
    questionRate: rounded(rate(/\?/)),
    commonTerms: [...frequencies.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([word]) => word),
  };
}

module.exports = { voiceFeatures };
