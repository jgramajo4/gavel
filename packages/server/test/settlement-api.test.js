const assert = require("node:assert/strict");
const test = require("node:test");
const { createGateHttpServer } = require("../src/gate/http");
const { SettlementRequestError } = require("../src/gate/settlement-service");

const PUBLIC_ID = "A".repeat(22);
const TX = `0x${"1".repeat(64)}`;
function pendingReceipt(newlyPending) {
  const receipt = { publicId: PUBLIC_ID, state: "pending_settlement", updatedAt: new Date(0) };
  Object.defineProperty(receipt, "newlyPending", { value: newlyPending });
  return receipt;
}
async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
function dependencies(calls) {
  return {
    authService: { issueChallenge: async () => ({}), verifyProof: async () => ({}),
      authenticateSession: async (_token, requirement) => { calls.push(["auth", requirement]); return { role: "base_sender", wallet: `0x${"2".repeat(40)}` }; } },
    profileService: { updateProfile: async () => ({}), listPublicProfiles: async () => [], getPublicProfile: async () => null },
    settlementService: { submitTxHash: async (input) => { calls.push(["settlement", input]); return pendingReceipt(true); } },
  };
}

test("settlement HTTP route authenticates base_sender and returns pending only", async () => {
  const calls = []; const server = createGateHttpServer(dependencies(calls));
  await withServer(server, async (base) => {
    const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/settlement`, { method: "POST",
      headers: { authorization: ["Bearer", "token"].join(" "), "content-type": "application/json" }, body: JSON.stringify({ txHash: TX, chainId: "8453" }) });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { publicId: PUBLIC_ID, state: "pending_settlement", updatedAt: new Date(0).toISOString() });
  });
  assert.deepEqual(calls[0], ["auth", { role: "base_sender" }]);
  assert.equal(calls[1][1].publicId, PUBLIC_ID);
});

test("settlement pending telemetry counts only the committed transition, not an idempotent replay", async () => {
  const calls = [];
  const deps = dependencies(calls);
  const counters = [];
  let first = true;
  deps.observability = { counter(name) { counters.push(name); } };
  deps.settlementService.submitTxHash = async () => pendingReceipt(first ? (first = false, true) : false);
  await withServer(createGateHttpServer(deps), async (base) => {
    const makeOptions = () => ({ method: "POST", headers: { authorization: ["Bearer", "token"].join(" "),
      "content-type": "application/json" }, body: JSON.stringify({ txHash: TX, chainId: "8453" }) });
    assert.equal((await fetch(`${base}/v1/submissions/${PUBLIC_ID}/settlement`, makeOptions())).status, 202);
    assert.equal((await fetch(`${base}/v1/submissions/${PUBLIC_ID}/settlement`, makeOptions())).status, 202);
  });
  assert.deepEqual(counters, ["gate_settlement_pending_total"]);
});

test("expired settlement hints return the frozen coarse Gone projection", async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.settlementService.submitTxHash = async () => {
    throw new SettlementRequestError("Quote expired", 410, "EXPIRED", "expired", new Date(0));
  };
  await withServer(createGateHttpServer(deps), async (base) => {
    const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/settlement`, { method: "POST",
      headers: { authorization: ["Bearer", "token"].join(" "), "content-type": "application/json" },
      body: JSON.stringify({ txHash: TX, chainId: "8453" }) });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      state: "expired", updatedAt: new Date(0).toISOString(),
      error: { code: "EXPIRED", message: "Quote expired" },
    });
  });
});

test("malformed settlement hashes and wrong chains return the frozen malformed projection", async () => {
  const calls = [];
  const deps = dependencies(calls);
  deps.settlementService.submitTxHash = async () => { throw new SettlementRequestError("transaction hash is invalid"); };
  await withServer(createGateHttpServer(deps), async (base) => {
    const response = await fetch(`${base}/v1/submissions/${PUBLIC_ID}/settlement`, { method: "POST",
      headers: { authorization: ["Bearer", "token"].join(" "), "content-type": "application/json" },
      body: JSON.stringify({ txHash: "0x12", chainId: "1" }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      state: "malformed", error: { code: "INVALID_SETTLEMENT", message: "transaction hash is invalid" },
    });
  });
});

test("resume always uses the private owner store even when a public reader is configured", async () => {
  const { createSubmissionService } = require("../src/gate/submission-service");
  const privateResume = { publicId: PUBLIC_ID, state: "accepted", acceptedAt: new Date(0) };
  const store = {
    issue() {}, getProfileByWallet() {}, getPolicy() {}, getOwnedSubmissionByHash() {},
    async getOwnedResume() { return privateResume; },
  };
  const publicReader = { async getSubmission() { return null; }, async getOwnedResume() { throw new Error("public reader used for private resume"); } };
  const service = createSubmissionService({ store, publicReader, indexClient: { getProposalSnapshot() {} },
    quoteSigner: { address: `0x${"3".repeat(40)}`, signQuote() {} }, deployment: { id: "d", chainId: "8453",
      splitter: `0x${"4".repeat(40)}`, token: `0x${"5".repeat(40)}`, codeHash: `0x${"6".repeat(64)}` },
    basePayerCodeReader() {} });
  assert.deepEqual(await service.resumeSubmission({ session: { role: "base_sender", wallet: `0x${"2".repeat(40)}` }, publicId: PUBLIC_ID }), privateResume);
});
