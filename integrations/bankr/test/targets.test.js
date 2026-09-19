"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createIndexApi } = require("../src/index-api");
const { buildCandidateTargetId, describeTarget, resolveTarget } = require("../src/targets");
const {
  CANDIDATE_PROPOSER, CANDIDATE_SLUG, candidateRow, candidateTargetIdFixture, createFetchStub, proposalRow,
} = require("./helpers");

function indexApiFor(routes) {
  const { fetchImpl, calls } = createFetchStub(routes);
  return { api: createIndexApi({ baseUrl: "https://index.test", fetchImpl }), calls };
}

test("a real Nouns Proposal Candidate resolves to PRE_VOTE / SPONSOR", async () => {
  const { api, calls } = indexApiFor([
    { match: (url) => url.includes("/targets/"), body: candidateRow() },
  ]);
  const target = await resolveTarget(api, { proposer: CANDIDATE_PROPOSER, slug: CANDIDATE_SLUG });

  assert.equal(target.kind, "candidate");
  assert.equal(target.targetId, candidateTargetIdFixture());
  assert.equal(target.stage, "PRE_VOTE");
  assert.equal(target.position, "SPONSOR");
  assert.equal(target.title, "Fund the Nouns builder grant");
  assert.deepEqual(target.submissionTarget, { targetId: candidateTargetIdFixture() });
  assert.equal(calls.length, 1);
});

test("candidate language never implies an open on-chain vote", async () => {
  const { api } = indexApiFor([{ match: () => true, body: candidateRow() }]);
  const target = await resolveTarget(api, { targetId: candidateTargetIdFixture() });

  assert.equal(target.language.headline, "Seeking sponsorship");
  assert.equal(target.language.ask, "Sponsor");
  assert.equal(target.language.stage, "PRE_VOTE");
  assert.match(target.language.summary, /no on-chain vote is open/);
  assert.doesNotMatch(target.language.summary, /\bvoting\b/i);
});

test("a candidate is never mapped to VOTING, whatever position is asked for", () => {
  assert.throws(
    () => describeTarget(candidateRow(), { position: "FOR" }),
    (error) => error.code === "INVALID_TARGET" && /SPONSOR/.test(error.message),
  );
  const target = describeTarget(candidateRow(), { position: "SPONSOR" });
  assert.equal(target.stage, "PRE_VOTE");
  assert.notEqual(target.stage, "VOTING");
});

test("a canceled or ineligible candidate is refused, not reshaped", () => {
  assert.throws(
    () => describeTarget(candidateRow({ nativeState: "CANCELED", eligibility: "CLOSED" })),
    (error) => error.code === "TARGET_NOT_ELIGIBLE",
  );
  assert.throws(
    () => describeTarget(candidateRow({ eligibility: "CLOSED" })),
    (error) => error.code === "TARGET_NOT_ELIGIBLE",
  );
});

test("an active Nouns proposal still resolves to VOTING", async () => {
  const { api } = indexApiFor([{ match: (url) => url.includes("/proposals/812"), body: proposalRow() }]);
  const target = await resolveTarget(api, { proposalId: "812", position: "FOR" });

  assert.equal(target.kind, "proposal");
  assert.equal(target.stage, "VOTING");
  assert.equal(target.position, "FOR");
  assert.deepEqual(target.submissionTarget, { proposalId: "812" });
});

test("a proposal that is not ACTIVE is refused", async () => {
  const { api } = indexApiFor([{ match: () => true, body: proposalRow({ effectiveStatus: "EXECUTED" }) }]);
  await assert.rejects(
    resolveTarget(api, { proposalId: "812", position: "FOR" }),
    (error) => error.code === "TARGET_NOT_ELIGIBLE",
  );
});

test("a target the index does not serve is never invented", async () => {
  const { api } = indexApiFor([{ match: () => true, status: 404, body: { error: "target_not_found" } }]);
  await assert.rejects(
    resolveTarget(api, { targetId: candidateTargetIdFixture() }),
    (error) => error.code === "TARGET_NOT_ELIGIBLE",
  );
});

test("a mismatched target identity from the index is refused", async () => {
  const { api } = indexApiFor([
    { match: () => true, body: candidateRow({ targetId: `candidate:0x${"9".repeat(40)}:0x${"8".repeat(64)}` }) },
  ]);
  await assert.rejects(
    resolveTarget(api, { targetId: candidateTargetIdFixture() }),
    (error) => error.code === "TARGET_NOT_ELIGIBLE",
  );
});

test("candidate target ids are derived canonically from proposer and slug", () => {
  assert.equal(buildCandidateTargetId(CANDIDATE_PROPOSER, CANDIDATE_SLUG), candidateTargetIdFixture());
  assert.throws(() => buildCandidateTargetId("not-an-address", CANDIDATE_SLUG), (error) => error.code === "INVALID_TARGET");
});
