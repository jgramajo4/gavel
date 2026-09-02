const { ProfileCategory } = require("../schema/profile");

const CATEGORY_PHRASES = Object.freeze({
  [ProfileCategory.TREASURY]: "treasury stewardship",
  [ProfileCategory.PUBLIC_GOODS]: "public-goods funding",
  [ProfileCategory.RECURRING_FUNDING]: "recurring funding",
  [ProfileCategory.RETROACTIVE_FUNDING]: "retroactive funding",
  [ProfileCategory.GOVERNANCE_UPGRADE]: "governance changes",
  [ProfileCategory.PROTOCOL_DEVELOPMENT]: "protocol development",
  [ProfileCategory.MARKETING]: "brand and marketing initiatives",
  [ProfileCategory.EVENTS]: "event funding",
  [ProfileCategory.EXPERIMENTAL]: "experimental initiatives",
  [ProfileCategory.AUCTION]: "auction policy",
  [ProfileCategory.OTHER]: "this type of proposal",
});

function mainCategory(categories) {
  const priority = [
    ProfileCategory.MARKETING,
    ProfileCategory.EVENTS,
    ProfileCategory.PUBLIC_GOODS,
    ProfileCategory.GOVERNANCE_UPGRADE,
    ProfileCategory.RECURRING_FUNDING,
    ProfileCategory.RETROACTIVE_FUNDING,
    ProfileCategory.AUCTION,
    ProfileCategory.EXPERIMENTAL,
    ProfileCategory.PROTOCOL_DEVELOPMENT,
    ProfileCategory.TREASURY,
    ProfileCategory.OTHER,
  ];
  return priority.find((category) => categories.includes(category)) || categories[0];
}

function generateDraftReason({ profile, recommendation, precedents, confidence, policySource, targetFacts }) {
  const voice = profile.observedBehavior.voice;
  const available = voice.reasonCount >= 3 || profile.statedPreferences.length > 0;
  if (!available) {
    return { isDraft: true, available: false, text: null, basis: "INSUFFICIENT_EVIDENCE" };
  }

  const personal = voice.firstPersonRate >= 0.35;
  const category = CATEGORY_PHRASES[mainCategory(targetFacts.categories)] || "this proposal";
  const sameVoteCount = precedents.filter((precedent) => precedent.precedent.support === recommendation).length;
  let opening;
  if (recommendation === "FOR") opening = personal ? "I support this proposal." : "Support this proposal.";
  else if (recommendation === "AGAINST") opening = personal ? "I can't support this proposal." : "Do not support this proposal.";
  else opening = personal ? "I'm abstaining on this proposal." : "Abstain on this proposal.";

  const sentences = [opening];
  if (policySource === "HARD_RULE") {
    sentences.push("It conflicts with a governance rule I have set for this situation.");
  } else if (policySource === "STATED_PREFERENCE") {
    sentences.push(`This follows my current stated preference on ${category}.`);
  } else if (precedents.length > 0) {
    sentences.push(
      `${sameVoteCount} of the ${precedents.length} strongest historical precedents point to the same decision on ${category}.`,
    );
  } else {
    sentences.push(`This is my best current judgment on ${category}, with limited direct precedent.`);
  }

  if (["DETAILED", "LONG"].includes(voice.typicalLength)) {
    if (voice.caveatRate >= 0.25 || confidence < 0.7) {
      sentences.push("The limited or conflicting precedent is the main caveat, so this deserves a manual review.");
    } else {
      sentences.push("The available evidence is consistent, but the recommendation should still be reviewed before voting.");
    }
  }

  const sentenceLimit = voice.typicalLength === "TERSE" ? 1 : voice.typicalLength === "BRIEF" ? 2 : 3;
  return {
    isDraft: true,
    available: true,
    text: sentences.slice(0, sentenceLimit).join(" "),
    basis: "PROFILE_STYLE_TEMPLATE",
  };
}

module.exports = { CATEGORY_PHRASES, generateDraftReason, mainCategory };
