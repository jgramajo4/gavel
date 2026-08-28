const { ProfileCategory } = require("../schema/profile");

const CATEGORY_PATTERNS = [
  [ProfileCategory.RECURRING_FUNDING, /\b(recurring|renewal|renew|monthly|quarterly|retainer)\b/i],
  [ProfileCategory.RETROACTIVE_FUNDING, /\b(retroactive|retro funding|retro grant|reimburse)\b/i],
  [ProfileCategory.PUBLIC_GOODS, /\b(public goods?|open source|community goods?|charit(?:y|able))\b/i],
  [ProfileCategory.GOVERNANCE_UPGRADE, /\b(governance upgrade|governor|voting period|quorum|timelock|veto)\b/i],
  [ProfileCategory.PROTOCOL_DEVELOPMENT, /\b(protocol|developer|development|engineering|infrastructure|smart contracts?)\b/i],
  [ProfileCategory.MARKETING, /\b(marketing|brand|advertis(?:e|ing)|promotion|sponsor(?:ship)?)\b/i],
  [ProfileCategory.EVENTS, /\b(event|conference|meetup|hackathon|festival)\b/i],
  [ProfileCategory.EXPERIMENTAL, /\b(experiment|pilot|trial|prototype|proof of concept)\b/i],
  [ProfileCategory.AUCTION, /\b(auction|bid|noun sale)\b/i],
];

function totalActionValueWei(proposal) {
  return proposal.actions.reduce((sum, action) => sum + BigInt(action.valueWei), 0n);
}

function extractProposalFacts(proposal) {
  // Proposal prose is untrusted. This function only extracts deterministic
  // lexical and executable-action features; it never interprets prose as instructions.
  const actionSignatures = proposal.actions.map((action) => action.signature).join(" ");
  const searchable = `${proposal.title}\n${proposal.description}\n${actionSignatures}`;
  const categories = [];
  const actionValueWei = totalActionValueWei(proposal);

  if (actionValueWei > 0n) categories.push(ProfileCategory.TREASURY);
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(searchable)) categories.push(category);
  }
  if (categories.length === 0) categories.push(ProfileCategory.OTHER);

  return {
    categories: [...new Set(categories)],
    totalActionValueWei: actionValueWei.toString(),
    recipients: [...new Set(proposal.actions.map((action) => action.target.toLowerCase()))],
  };
}

module.exports = { extractProposalFacts, totalActionValueWei };
