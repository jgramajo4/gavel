"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGateApi } = require("../src/gate-api");
const {
  assertVoterAccepts, discoverVoters, projectVoter, selectTargetVoter, selectVoter,
} = require("../src/discovery");
const { BASE_MAINNET, VOTER, createFetchStub, gateProfile } = require("./helpers");

const TARGET_VOTER = "0xc180000000000000000000000000000000005425";

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

test("human display prefers Gate's label while machine identity stays the canonical wallet", async () => {
  const labeled = gateProfile({ label: "delegate.gramajo.eth" });
  const { api, calls } = gateApiFor([
    { match: (url) => url.includes(`/v1/gates/${VOTER.toLowerCase()}`), body: labeled },
  ]);
  const voter = await selectVoter(api, VOTER.toLowerCase(), { stage: "PRE_VOTE", chainId: BASE_MAINNET });

  assert.equal(voter.wallet, VOTER.toLowerCase());
  const lower = VOTER.toLowerCase();
  assert.equal(voter.label, `delegate.gramajo.eth (${lower.slice(0, 6)}…${lower.slice(-4)})`);
  assert.equal(calls.length, 1);
});

test("human display falls back cleanly to the shortened canonical wallet", () => {
  const voter = projectVoter(gateProfile({ label: null }), { stage: "PRE_VOTE" });
  const lower = VOTER.toLowerCase();
  assert.equal(voter.wallet, lower);
  assert.equal(voter.label, `${lower.slice(0, 6)}…${lower.slice(-4)}`);
});

test("an explicit Gate label wins over the Bankr profile wallet and resolves only through live Gate data", async () => {
  const targetProfile = gateProfile({
    wallet: TARGET_VOTER,
    label: "delegate.gramajo.eth",
  });
  const { api, calls } = gateApiFor([
    { match: (url) => url.includes("/v1/gates/matches?"), body: { items: [targetProfile] } },
    { match: (url) => url.endsWith(`/v1/gates/${TARGET_VOTER}`), body: targetProfile },
  ]);

  const voter = await selectTargetVoter(api, {
    explicitTarget: "delegate.gramajo.eth",
    profileWallet: VOTER,
    stage: "PRE_VOTE",
    chainId: BASE_MAINNET,
  });

  assert.equal(voter.wallet, TARGET_VOTER);
  assert.equal(voter.label, "delegate.gramajo.eth (0xc180…5425)");
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), ["/v1/gates/matches", `/v1/gates/${TARGET_VOTER}`]);
  assert.equal(new URL(calls[0].url).searchParams.get("label"), "delegate.gramajo.eth");
  assert.equal(new URL(calls[0].url).searchParams.get("stage"), "PRE_VOTE");
});

test("an explicit wallet wins over the Bankr profile wallet without directory inference", async () => {
  const targetProfile = gateProfile({ wallet: TARGET_VOTER, label: "delegate.gramajo.eth" });
  const { api, calls } = gateApiFor([
    { match: (url) => url.endsWith(`/v1/gates/${TARGET_VOTER}`), body: targetProfile },
  ]);

  const voter = await selectTargetVoter(api, {
    explicitTarget: TARGET_VOTER,
    profileWallet: VOTER,
    stage: "PRE_VOTE",
  });

  assert.equal(voter.wallet, TARGET_VOTER);
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [`/v1/gates/${TARGET_VOTER}`]);
});

test("an ambiguous explicit Gate label fails closed instead of choosing by directory order", async () => {
  const duplicate = gateProfile({ wallet: TARGET_VOTER, label: "delegate.gramajo.eth" });
  const other = gateProfile({ wallet: VOTER, label: "delegate.gramajo.eth" });
  const { api, calls } = gateApiFor([
    { match: (url) => url.includes("/v1/gates/matches?"), body: { items: [duplicate, other] } },
  ]);

  await assert.rejects(
    selectTargetVoter(api, {
      explicitTarget: "delegate.gramajo.eth",
      profileWallet: VOTER,
      stage: "PRE_VOTE",
      chainId: BASE_MAINNET,
    }),
    (error) => error.code === "AMBIGUOUS_VOTER",
  );
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), ["/v1/gates/matches"]);
});

test("explicit label selection uses Gate's complete exact-label lookup, not the bounded discovery page", async () => {
  const targetProfile = gateProfile({ wallet: TARGET_VOTER, label: "page-two.delegate" });
  const { api, calls } = gateApiFor([
    { match: (url) => url.includes("/v1/gates/matches?"), body: { items: [targetProfile] } },
    { match: (url) => url.endsWith(`/v1/gates/${TARGET_VOTER}`), body: targetProfile },
  ]);

  const voter = await selectTargetVoter(api, {
    explicitTarget: "page-two.delegate", profileWallet: VOTER, stage: "PRE_VOTE",
  });

  assert.equal(voter.wallet, TARGET_VOTER);
  assert.equal(calls.some(({ url }) => new URL(url).pathname === "/v1/gates"), false);
});

test("an unknown explicit label fails without falling back or gaining an ENS resolver capability", async () => {
  const calls = [];
  const gateApi = new Proxy({
    async findGatesByLabel() { calls.push("findGatesByLabel"); return []; },
    async getGate() { calls.push("getGate"); return gateProfile(); },
  }, {
    get(target, property, receiver) {
      assert.ok(property === "findGatesByLabel" || property === "getGate",
        `unexpected voter-resolution capability: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });

  await assert.rejects(
    selectTargetVoter(gateApi, {
      explicitTarget: "unknown.delegate.eth",
      profileWallet: VOTER,
      stage: "PRE_VOTE",
    }),
    (error) => error.code === "VOTER_NOT_ACCEPTING",
  );
  assert.deepEqual(calls, ["findGatesByLabel"]);
});

test("an invalid explicit target fails instead of falling back to the Bankr profile wallet", async () => {
  const { api, calls } = gateApiFor([
    { match: (url) => url.endsWith(`/v1/gates/${VOTER}`), body: gateProfile() },
  ]);

  await assert.rejects(
    selectTargetVoter(api, { explicitTarget: "   ", profileWallet: VOTER, stage: "PRE_VOTE" }),
    (error) => error.code === "INVALID_REQUEST",
  );
  assert.equal(calls.length, 0);
});

test("the Bankr profile wallet is used only when no explicit target is present", async () => {
  const { api, calls } = gateApiFor([
    { match: (url) => url.endsWith(`/v1/gates/${VOTER}`), body: gateProfile() },
  ]);

  const voter = await selectTargetVoter(api, { profileWallet: VOTER, stage: "PRE_VOTE" });

  assert.equal(voter.wallet, VOTER.toLowerCase());
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [`/v1/gates/${VOTER}`]);
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
