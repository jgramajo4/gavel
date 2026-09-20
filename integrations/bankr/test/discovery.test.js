"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGateApi } = require("../src/gate-api");
const { assertVoterAccepts, discoverVoters, projectVoter, selectVoter } = require("../src/discovery");
const { BASE_MAINNET, VOTER, createFetchStub, gateProfile } = require("./helpers");

function gateApiFor(routes) {
  const { fetchImpl, calls } = createFetchStub(routes);
  return { api: createGateApi({ baseUrl: "https://gate.test", fetchImpl }), calls };
}

test("discovery reads Gate's own public directory, not a parallel voter list", async () => {
  const { api, calls } = gateApiFor([
    { match: (url) => url.includes("/v1/gates?"), body: { items: [gateProfile()] } },
  ]);
  const voters = await discoverVoters(api, { stage: "PRE_VOTE", chainId: BASE_MAINNET });

  assert.equal(voters.length, 1);
  assert.equal(voters[0].wallet, VOTER.toLowerCase());
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/gate\.test\/v1\/gates\?/);
  assert.match(calls[0].url, /availability=accepting_now/);
});

test("discovery shows the attention price and the relevant policy", async () => {
  const { api } = gateApiFor([{ match: () => true, body: { items: [gateProfile()] } }]);
  const [voter] = await discoverVoters(api, { stage: "PRE_VOTE", chainId: BASE_MAINNET });

  assert.equal(voter.attentionAmount, "1000000");
  assert.equal(voter.gavelFeeAmount, "250000");
  assert.equal(voter.indicativeTotalAmount, "1250000");
  assert.equal(voter.indicativePrice, "1.00 USDC attention + 0.25 USDC Gavel fee");
  assert.deepEqual([...voter.acceptedStages], ["PRE_VOTE"]);
  assert.deepEqual([...voter.supportedStages], ["PRE_VOTE", "VOTING"]);
  assert.deepEqual([...voter.tags], ["builder-grants"]);
  assert.deepEqual(voter.governancePower, { dao: "nouns", amount: "4", asOf: "2026-09-19T00:00:00.000Z" });
});

test("a voter who does not accept the requested stage is filtered out", async () => {
  const { api } = gateApiFor([
    { match: () => true, body: { items: [gateProfile({ policies: [{ dao: "nouns", supportedStages: ["PRE_VOTE", "VOTING"], acceptedStages: ["VOTING"], attentionAmount: "1000000", gavelFeeAmount: "250000", tags: [] }] })] } },
  ]);
  assert.equal((await discoverVoters(api, { stage: "PRE_VOTE" })).length, 0);
  assert.equal((await discoverVoters(api, { stage: "VOTING" })).length, 1);
});

test("a paused or closed Gate profile is never selectable", () => {
  assert.equal(projectVoter(gateProfile({ availability: "paused", acceptingSubmissions: false }), { stage: "PRE_VOTE" }).acceptsStage, false);
  assert.throws(
    () => assertVoterAccepts(projectVoter(gateProfile({ acceptingSubmissions: false }), { stage: "PRE_VOTE" }), "PRE_VOTE"),
    (error) => error.code === "VOTER_NOT_ACCEPTING",
  );
});

test("selecting a voter re-reads that voter's Gate profile", async () => {
  const { api, calls } = gateApiFor([
    { match: (url) => url.includes(`/v1/gates/${VOTER.toLowerCase()}`), body: gateProfile() },
  ]);
  const voter = await selectVoter(api, VOTER.toLowerCase(), { stage: "PRE_VOTE", chainId: BASE_MAINNET });

  assert.equal(voter.wallet, VOTER.toLowerCase());
  const lower = VOTER.toLowerCase();
  assert.equal(voter.label, `voter.eth (${lower.slice(0, 6)}…${lower.slice(-4)})`);
  assert.equal(calls.length, 1);
});

test("selecting a wallet Gate does not know refuses instead of inventing a voter", async () => {
  const { api } = gateApiFor([{ match: () => true, status: 404, body: { error: { code: "NOT_FOUND" } } }]);
  await assert.rejects(
    selectVoter(api, VOTER.toLowerCase(), { stage: "PRE_VOTE" }),
    (error) => error.code === "VOTER_NOT_ACCEPTING",
  );
});

test("a voter who stopped accepting between listing and selection is refused", async () => {
  const { api } = gateApiFor([
    { match: () => true, body: gateProfile({ availability: "paused", acceptingSubmissions: false }) },
  ]);
  await assert.rejects(
    selectVoter(api, VOTER.toLowerCase(), { stage: "PRE_VOTE" }),
    (error) => error.code === "VOTER_NOT_ACCEPTING",
  );
});
