const { extractProposalFacts } = require("./features");

function newestFirst(a, b) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || a.id.localeCompare(b.id);
}

function hardRuleMatches(rule, facts) {
  if (!rule.enabled) return false;
  const condition = rule.condition;
  if (condition.type === "always") return true;
  if (condition.type === "category") {
    return condition.categories.some((category) => facts.categories.includes(category));
  }
  if (condition.type === "treasury-transfer-above") {
    return BigInt(facts.totalActionValueWei) > BigInt(condition.thresholdWei);
  }
  if (condition.type === "recipient") {
    const recipients = new Set(facts.recipients.map((address) => address.toLowerCase()));
    return condition.addresses.some((address) => recipients.has(address.toLowerCase()));
  }
  return false;
}

function resolveLayeredPolicy({ profile, proposal, observedRecommendation }) {
  const facts = extractProposalFacts(proposal);
  const matchingRules = profile.hardRules.filter((rule) => hardRuleMatches(rule, facts)).sort(newestFirst);
  const flags = matchingRules.flatMap((rule) => (rule.effect.flag ? [rule.effect.flag] : []));
  const blockAutonomy = matchingRules.some((rule) => rule.effect.blockAutonomy);
  const decidingRule = matchingRules.find((rule) => rule.effect.recommendation);

  if (decidingRule) {
    return {
      recommendation: decidingRule.effect.recommendation,
      source: "HARD_RULE",
      sourceId: decidingRule.id,
      matchedHardRuleIds: matchingRules.map((rule) => rule.id),
      flags,
      blockAutonomy,
    };
  }

  const preference = profile.statedPreferences
    .filter(
      (item) =>
        item.active &&
        item.recommendation &&
        (item.categories.length === 0 || item.categories.some((category) => facts.categories.includes(category))),
    )
    .sort(newestFirst)[0];

  if (preference) {
    return {
      recommendation: preference.recommendation,
      source: "STATED_PREFERENCE",
      sourceId: preference.id,
      matchedHardRuleIds: matchingRules.map((rule) => rule.id),
      flags,
      blockAutonomy,
    };
  }

  return {
    recommendation: observedRecommendation,
    source: "OBSERVED_BEHAVIOR",
    sourceId: null,
    matchedHardRuleIds: matchingRules.map((rule) => rule.id),
    flags,
    blockAutonomy,
  };
}

module.exports = { hardRuleMatches, resolveLayeredPolicy };
