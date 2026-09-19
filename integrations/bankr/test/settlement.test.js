"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createGateApi } = require("../src/gate-api");
const { describeStatus, isDelivered, pollUntilTerminal, submitSettlementHint } = require("../src/settlement");
const { createFetchStub } = require("./helpers");

const TOKEN = "S".repeat(43);
const PUBLIC_ID = "abcdefghijklmnopqrstuv";
const TX_HASH = `0x${"ab".repeat(32)}`;
const noSleep = async () => {};

function gateApiFor(routes) {
  const { fetchImpl, calls } = createFetchStub(routes);
  return { api: createGateApi({ baseUrl: "https://gate.test", fetchImpl }), calls };
}

test("the tx hash is submitted to Gate as a settlement HINT only", async () => {
  const { api, calls } = gateApiFor([
    {
      match: (url, options) => url.endsWith(`/v1/submissions/${PUBLIC_ID}/settlement`) && options.method === "POST",
      status: 202,
      body: { publicId: PUBLIC_ID, state: "pending_settlement", updatedAt: "2026-09-19T00:00:00.000Z" },
    },
  ]);
  const result = await submitSettlementHint({
    gateApi: api, token: TOKEN, publicId: PUBLIC_ID, txHash: TX_HASH, chainId: "84532",
  });

  assert.equal(result.hint, true);
  assert.equal(result.recorded, true);
  assert.equal(result.accepted, false);
  assert.equal(result.state, "pending_settlement");
  assert.match(result.message, /independently verifying/);

  assert.deepEqual(JSON.parse(calls[0].body), { txHash: TX_HASH, chainId: "84532" });
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
});

test("acceptance is reported only when Gate's status endpoint says accepted", async () => {
  const states = ["pending_settlement", "pending_settlement", "accepted"];
  let index = 0;
  const { api } = gateApiFor([
    {
      match: (url) => url.includes("/status"),
      body: () => {
        const state = states[Math.min(index, states.length - 1)];
        index += 1;
        return state === "accepted"
          ? { publicId: PUBLIC_ID, state, acceptedAt: "2026-09-19T00:01:00.000Z" }
          : { publicId: PUBLIC_ID, state, updatedAt: "2026-09-19T00:00:30.000Z" };
      },
    },
  ]);
  const seen = [];
  const verdict = await pollUntilTerminal({
    gateApi: api, publicId: PUBLIC_ID, sleep: noSleep, onPoll: (status) => seen.push(status.state),
  });

  assert.deepEqual(seen, ["pending_settlement", "pending_settlement", "accepted"]);
  assert.equal(verdict.state, "accepted");
  assert.equal(verdict.delivered, true);
  assert.equal(verdict.acceptedAt, "2026-09-19T00:01:00.000Z");
  assert.match(verdict.message, /private Gate inbox/);
  assert.equal(isDelivered(verdict), true);
});

test("a successful broadcast that stays pending_settlement is never reported as success", async () => {
  const { api } = gateApiFor([
    { match: (url) => url.includes("/status"), body: { publicId: PUBLIC_ID, state: "pending_settlement" } },
  ]);
  const verdict = await pollUntilTerminal({ gateApi: api, publicId: PUBLIC_ID, attempts: 3, sleep: noSleep });

  assert.equal(verdict.state, "pending_settlement");
  assert.equal(verdict.delivered, false);
  assert.equal(verdict.terminal, false);
  assert.equal(isDelivered(verdict), false);
  assert.match(verdict.message, /no new quote is needed/);
  assert.doesNotMatch(verdict.message, /\bwas delivered\b|\bis accepted\b|\bsuccess\b/i);
});

test("an eventual Gate rejection is terminal and is not delivery", async () => {
  for (const state of ["rejected_by_policy", "expired", "malformed"]) {
    const { api } = gateApiFor([
      { match: (url) => url.includes("/status"), body: { publicId: PUBLIC_ID, state } },
    ]);
    const verdict = await pollUntilTerminal({ gateApi: api, publicId: PUBLIC_ID, sleep: noSleep });
    assert.equal(verdict.state, state);
    assert.equal(verdict.terminal, true);
    assert.equal(verdict.delivered, false);
    assert.equal(isDelivered(verdict), false);
  }
});

test("polling waits before its first read", async () => {
  const waits = [];
  const { api } = gateApiFor([
    { match: (url) => url.includes("/status"), body: { publicId: PUBLIC_ID, state: "accepted", acceptedAt: "x" } },
  ]);
  await pollUntilTerminal({
    gateApi: api, publicId: PUBLIC_ID, intervalMs: 1234, sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(waits, [1234]);
});

test("an expired quote reported by the settlement endpoint surfaces as EXPIRED", async () => {
  const { api } = gateApiFor([
    {
      match: (url) => url.endsWith("/settlement"),
      status: 410,
      body: { state: "expired", error: { code: "EXPIRED", message: "Quote expired" } },
    },
  ]);
  await assert.rejects(
    submitSettlementHint({ gateApi: api, token: TOKEN, publicId: PUBLIC_ID, txHash: TX_HASH, chainId: "84532" }),
    (error) => error.code === "EXPIRED" && error.state === "expired",
  );
});

test("state copy never calls a broadcast or a pending settlement a delivery", () => {
  assert.doesNotMatch(describeStatus("pending_settlement"), /delivered/i);
  assert.doesNotMatch(describeStatus("payment_required"), /delivered/i);
  assert.match(describeStatus("accepted"), /private Gate inbox/);
});
