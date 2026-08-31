const INJECTION_PATTERNS = Object.freeze([
  ["IGNORE_INSTRUCTIONS", /\b(?:ignore|disregard|override|forget)\b.{0,48}\b(?:instructions?|rules?|system prompt|policy|policies)\b/is],
  ["SYSTEM_PROMPT_REQUEST", /\b(?:system prompt|developer message|hidden instructions?|reveal (?:your|the) prompt)\b/is],
  ["AGENT_DIRECTIVE", /\b(?:(?:gavel(?:\s+agent)?|automated reviewer|ai reviewer|language model)\s*(?:,|:)?\s*(?:you\s+)?(?:must|should|shall|vote|return|output|execute|follow)|(?:ai|agent|assistant)\s*(?:,|:)\s*(?:you\s+)?(?:must|should|shall|vote|return|output|execute|follow))\b/is],
  ["TOOL_OR_SECRET_REQUEST", /\b(?:reveal|print|output|send|expose|provide)\b.{0,48}\b(?:private key|seed phrase|api key|secret)\b|\b(?:agent|assistant|gavel|you)\b.{0,24}\b(?:call|invoke|use)\b.{0,24}\btool\b/is],
]);

function detectUntrustedInstructions(title, description) {
  const content = `${title || ""}\n${description || ""}`;
  return INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(content)).map(([code]) => code);
}

function parseEthClaims(description) {
  const claims = [];
  for (const line of description.split(/\r?\n/)) {
    const label = line.match(/(?:\btotal\s+(?:proposal\s+)?(?:ask|request|requested|funding|payment|compensation)\b|\btotal\s*[:=\-]|\bamount requested\b|\brequested amount\b|^\s*#*\s*funding request\s*[:=\-])/i);
    if (!label) continue;
    const afterLabel = line.slice(label.index + label[0].length);
    const amounts = [...afterLabel.matchAll(/\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*(?:ETH|Ξ)\b/gi)];
    if (amounts.length !== 1) continue;
    if (/^\d+,\d{1,2}$/.test(amounts[0][1])) continue;
    const amount = Number(amounts[0][1].replaceAll(",", ""));
    if (Number.isFinite(amount)) {
      claims.push({ amount, scope: "TOTAL", text: `${amounts[0][1]} ETH` });
    }
  }
  return [...new Map(claims.map((claim) => [`${claim.scope}:${claim.amount}`, claim])).values()];
}

function parseRecipientClaims(description) {
  const claims = [];
  const pattern = /\b(?:recipient\s*[:=\-]?|(?:pay(?:ment)?|send|transfer)[^.\n]{0,80}?\bto)\s*(0x[0-9a-fA-F]{40})\b/gi;
  for (const match of description.matchAll(pattern)) claims.push(match[1].toLowerCase());
  return [...new Set(claims)];
}

module.exports = { detectUntrustedInstructions, parseEthClaims, parseRecipientClaims };
