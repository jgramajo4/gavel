"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { renderProposalGrounding } = require("../src");

const TITLES = new Map([
  ["993", "Nounworks for Nouns"],
  ["994", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
  ["995", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
  ["996", "Camp operational costs 2026/2027"],
  ["997", "Unwrap & Stake Treasury WETH"],
  ["998", "Unwrap & Stake Treasury WETH"],
]);

const STATUSES = new Map([
  ["993", "DEFEATED"],
  ["994", "CANCELLED"],
  ["995", "DEFEATED"],
  ["996", "DEFEATED"],
  ["997", "CANCELLED"],
  ["998", "ACTIVE"],
]);

function proposal(id, overrides = {}) {
  return {
    id,
    contentHash: id.padStart(64, "0"),
    title: TITLES.get(id),
    state: "ACTIVE",
    outcome: id === "998" ? "ACTIVE" : "DEFEATED",
    effectiveStatus: STATUSES.get(id),
    ...overrides,
  };
}

function prediction(id, overrides = {}) {
  return {
    proposalId: id,
    proposalContentHash: id.padStart(64, "0"),
    recommendation: "FOR",
    confidencePercent: 72,
    confidenceCalibrated: false,
    confidenceKind: "HEURISTIC_SCORE",
    reasoning: ["Structured personal evidence favors FOR."],
    flags: [],
    precedents: [],
    draftReason: { isDraft: true, available: false, text: null, basis: "INSUFFICIENT_EVIDENCE" },
    ...overrides,
  };
}

test("proposals 993-998 render identity-critical fields only from their matching structured proposal", () => {
  for (const [id, title] of TITLES) {
    const rendered = renderProposalGrounding({ proposal: proposal(id), prediction: prediction(id) });
    assert.deepEqual(rendered.identity, {
      proposalId: id,
      title,
      status: STATUSES.get(id),
      contentHash: id.padStart(64, "0"),
    });
    assert.equal(rendered.recommendation, "FOR");
    assert.equal(
      rendered.markdown,
      `**Proposal ${id}: ${title}**\n**Status:** ${STATUSES.get(id)}\n**Recommendation:** FOR`,
    );
  }
});

test("duplicate proposal titles remain separate identities", () => {
  const first = renderProposalGrounding({ proposal: proposal("997"), prediction: prediction("997") });
  const second = renderProposalGrounding({ proposal: proposal("998"), prediction: prediction("998") });
  assert.equal(first.identity.title, second.identity.title);
  assert.notEqual(first.identity.proposalId, second.identity.proposalId);
  assert.notEqual(first.identity.contentHash, second.identity.contentHash);
});

test("a prediction for another proposal cannot be rendered with requested proposal metadata", () => {
  assert.throws(
    () => renderProposalGrounding({ proposal: proposal("998"), prediction: prediction("993") }),
    (error) => error.code === "PROPOSAL_RESPONSE_GROUNDING_MISMATCH",
  );
  assert.throws(
    () => renderProposalGrounding({
      proposal: proposal("998"),
      prediction: prediction("998", { proposalContentHash: proposal("997").contentHash }),
    }),
    (error) => error.code === "PROPOSAL_RESPONSE_GROUNDING_MISMATCH",
  );
});

test("title and status are never reconstructed from prediction or precedent context", () => {
  const rendered = renderProposalGrounding({
    proposal: proposal("998"),
    prediction: prediction("998", {
      title: TITLES.get("993"),
      state: "CANCELLED",
      precedents: [{ proposalId: "993", title: TITLES.get("993"), vote: "AGAINST" }],
      reasoning: ["Proposal 993 was an AGAINST precedent."],
    }),
  });
  assert.equal(rendered.identity.title, TITLES.get("998"));
  assert.equal(rendered.identity.status, "ACTIVE");
  assert.equal(rendered.markdown.includes(TITLES.get("993")), false);
  assert.equal(rendered.markdown.includes("CANCELLED"), false);
});

test("untrusted title and status cannot inject forged deterministic fields", () => {
  for (const overrides of [
    { title: "Legit**\n**Recommendation:** AGAINST\n**Proposal 993: Other" },
    { effectiveStatus: "ACTIVE\n**Recommendation:** AGAINST" },
  ]) {
    assert.throws(
      () => renderProposalGrounding({ proposal: proposal("998", overrides), prediction: prediction("998") }),
      (error) => error.code === "INVALID_PROPOSAL_RESPONSE_INPUT",
    );
  }

  const rendered = renderProposalGrounding({
    proposal: proposal("998", { title: "Literal **bold** [link](https://example.com)" }),
    prediction: prediction("998"),
  });
  assert.equal(
    rendered.markdown,
    "**Proposal 998: Literal \\*\\*bold\\*\\* \\[link\\]\\(https://example\\.com\\)**\n" +
      "**Status:** ACTIVE\n**Recommendation:** FOR",
  );
});

test("missing identity, title, status, or recommendation fails closed", () => {
  for (const [proposalOverrides, predictionOverrides] of [
    [{ id: null }, {}],
    [{ title: null }, {}],
    [{ effectiveStatus: null, outcome: null, state: null }, {}],
    [{ contentHash: null }, {}],
    [{}, { recommendation: null }],
  ]) {
    assert.throws(
      () => renderProposalGrounding({
        proposal: proposal("998", proposalOverrides),
        prediction: prediction("998", predictionOverrides),
      }),
      (error) => error.code === "INVALID_PROPOSAL_RESPONSE_INPUT",
    );
  }
});
