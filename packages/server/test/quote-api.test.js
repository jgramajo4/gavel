const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");
const { buildQuoteMessage, createQuoteTypedData, verifyQuoteSignature } = require("@gavel/gate");

const { MemoryGateStore } = require("../src/gate/store-memory");
const { createQuoteSigner } = require("../src/gate/quote-signer");
const { createSubmissionService } = require("../src/gate/submission-service");
const { createNounsIndexClient } = require("../src/gate/index-client");
const { candidateTargetId } = require("@gavel/gate");

function loadHttp() { return require("../src/gate/http"); }

const SIGNER_KEY = `0x${"7".repeat(64)}`;
const SIGNER_ADDRESS = new Wallet(SIGNER_KEY).address;
const VOTER = "0x1111111111111111111111111111111111111111";
const SPLITTER = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const GAVEL_RECIPIENT = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CODE_HASH = `0x${"ee".repeat(32)}`;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;
const CONTENT_HASH = `0x${"cc".repeat(32)}`;
const TOKEN_VALUE = "a".repeat(43);
const START = new Date("2026-01-01T00:00:00.000Z");

function body(overrides = {}) {
  return {
    dao: "nouns", proposalId: "42", stage: "VOTING", position: "FOR",
    pitch: "Fund it.", disclosures: "None.", evidenceUrls: ["https://example.com/a"],
    ...overrides,
  };
}

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}

function post(payload, token = TOKEN_VALUE) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  };
}

async function harness(options = {}) {
  const state = { now: new Date(START), healthy: true, sessionWallet: PAYER.toLowerCase() };
  const clock = () => new Date(state.now);
  const store = new MemoryGateStore({ clock });
  await store.mutateProfile({
    profile: { id: "profile-1", wallet: VOTER, walletKind: "eoa", availability: "accepting_now" },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: options.acceptPreVote ?? false, acceptVoting: true,
      attentionAmount: "1000000", tags: [] },
  });
  await store.configureDeployment({
    id: "deployment-1", chainId: "8453", splitter: SPLITTER, signer: SIGNER_ADDRESS, token: TOKEN,
    gavelRecipient: GAVEL_RECIPIENT, contractCodeHash: CODE_HASH, deploymentBlock: "0", nextBlock: "0",
    issuanceActive: true, config: { environment: "production" }, rpcAccess: {},
  });

  const submissionService = createSubmissionService({
    store,
    indexClient: options.indexClient || {
      async getProposalSnapshot(proposalId) {
        if (!state.healthy) {
          const error = new Error("unavailable");
          error.statusCode = 503;
          throw error;
        }
        return {
          dao: "nouns", proposalId: String(proposalId), nativeState: "ACTIVE", eligibility: "VOTING",
          mappingVersion: "nouns-lifecycle/1", refreshedAt: new Date(state.now.getTime() - 60_000).toISOString(),
          sourceBlock: "100", sourceBlockHash: BLOCK_HASH, contentHash: CONTENT_HASH, canonicalActions: [],
        };
      },
    },
    quoteSigner: createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }),
    deployment: { id: "deployment-1", chainId: 8453, splitter: SPLITTER, token: TOKEN, codeHash: CODE_HASH },
    basePayerCodeReader: async () => "0x",
    clock,
  });

  const authService = {
    async issueChallenge() { return {}; },
    async verifyProof() { return {}; },
    async authenticateSession(token, requirements = {}) {
      if (token !== TOKEN_VALUE) throw new Error("session unavailable");
      const role = options.role ?? "base_sender";
      if (requirements.role !== undefined && requirements.role !== role) throw new Error("session unavailable");
      return { wallet: state.sessionWallet, role, chainId: "8453", audience: "gate", expiry: "9999999999" };
    },
  };
  const profileService = {
    async updateProfile() { return {}; },
    async listPublicProfiles() { return []; },
    async getPublicProfile() { return null; },
  };

  const { createGateHttpServer } = loadHttp();
  return {
    state, store, submissionService,
    server: createGateHttpServer({ authService, profileService, submissionService, ...options.server }),
  };
}

test("real Gate submission composition preserves identity mismatch as 409 and outages as 503", async () => {
  let mode = "mismatch";
  const indexClient = createNounsIndexClient({
    clock: () => new Date(START),
    source: {
      async getHealth() {
        if (mode === "outage") throw new Error("transport unavailable");
        return { healthy: true, refreshedAt: START.toISOString(), lastError: null };
      },
      async getProposal() {
        return { dao: "nouns", chainId: 1,
          governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
          proposalId: mode === "mismatch" ? "41" : "42",
          effectiveStatus: "ACTIVE", refreshedAt: START.toISOString(),
          sourceBlock: "100", sourceBlockHash: BLOCK_HASH, contentHash: CONTENT_HASH, actions: [] };
      },
    },
  });
  const gate = await harness({ indexClient });
  await withServer(gate.server, async (baseUrl) => {
    const url = `/v1/gates/${VOTER}/submissions`;
    const mismatch = await requestJson(baseUrl, url, post(body()));
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, "PROPOSAL_IDENTITY_MISMATCH");
    assert.equal((await gate.store.counts()).submissions, 0);
    mode = "outage";
    const unavailable = await requestJson(baseUrl, url, post(body()));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, "CANONICAL_DATA_UNAVAILABLE");
    assert.equal((await gate.store.counts()).submissions, 0);
  });
});

test("real Gate candidate submission preserves mismatched target identity as non-retryable 409", async () => {
  const proposer = `0x${"aa".repeat(20)}`;
  const targetId = candidateTargetId(proposer, "expected slug");
  const indexClient = createNounsIndexClient({
    clock: () => new Date(START),
    source: {
      async getHealth() { return { healthy: true, refreshedAt: START.toISOString(), lastError: null }; },
      async getTarget() { return { dao: "nouns", targetId, kind: "candidate", proposer, slug: "wrong slug" }; },
    },
  });
  const gate = await harness({ indexClient, acceptPreVote: true });
  await withServer(gate.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body({
      targetId, stage: "PRE_VOTE", position: "SPONSOR", proposalId: undefined,
    })));
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "PROPOSAL_IDENTITY_MISMATCH");
    assert.equal((await gate.store.counts()).submissions, 0);
  });
});

test("a valid submission returns the frozen payment-required quote payload", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));

    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(Object.keys(response.body).sort(), ["publicId", "quote", "state", "updatedAt"]);
    assert.equal(response.body.state, "payment_required");
    assert.equal(response.body.updatedAt, START.toISOString());
    assert.deepEqual(response.body.quote.domain, {
      name: "GavelGateSplitter", version: "1", chainId: 8453, verifyingContract: getAddress(SPLITTER),
    });
    assert.equal(response.body.quote.totalAmount, "1250000");

    const typed = createQuoteTypedData(buildQuoteMessage(response.body.quote.message), response.body.quote.domain);
    assert.equal(verifyQuoteSignature(typed, response.body.quote.signature, SIGNER_ADDRESS), true);
  });
});

test("quote HTTP outcomes increment only aggregate issued and allowlisted rejection counters", async () => {
  const counters = [];
  const gate = await harness({ server: { observability: {
    counter(name, value, labels) { counters.push([name, value, labels]); },
  } } });
  await withServer(gate.server, async (baseUrl) => {
    assert.equal((await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()))).status, 201);
    gate.state.healthy = false;
    assert.equal((await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body({ pitch: "different" })))).status, 503);
  });
  assert.deepEqual(counters, [
    ["gate_quote_issued_total", 1, undefined],
    ["gate_quote_rejected_total", 1, { reason: "canonical_data_unavailable" }],
  ]);
});

test("malformed and oversized quote requests use stable rejection reasons", async () => {
  const counters = [];
  const gate = await harness({ server: { maxBodyBytes: 32, observability: {
    counter(name, value, labels) { if (name === "gate_quote_rejected_total") counters.push(labels.reason); },
  } } });
  await withServer(gate.server, async (baseUrl) => {
    const path = `${baseUrl}/v1/gates/${VOTER}/submissions`;
    const headers = { authorization: ["Bearer", TOKEN_VALUE].join(" "), "content-type": "application/json" };
    await fetch(path, { method: "POST", headers, body: "{" });
    await fetch(path, { method: "POST", headers, body: JSON.stringify({ pitch: "x".repeat(64) }) }).catch(() => {});
  });
  assert.deepEqual(counters, ["invalid_request", "request_too_large"]);
});

test("submission requires an exact base_sender session", async () => {
  const anonymous = await harness();
  await withServer(anonymous.server, async (baseUrl) => {
    assert.equal((await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body(), null))).status, 401);
    assert.equal((await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body(), "wrong"))).status, 401);
    assert.equal((await anonymous.store.counts()).submissions, 0);
  });

  const wrongRole = await harness({ role: "dao_profile" });
  await withServer(wrongRole.server, async (baseUrl) => {
    const response = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "UNAUTHORIZED");
    assert.equal((await wrongRole.store.counts()).submissions, 0);
  });
});

test("coarse rejections use the frozen state and error shape without private detail", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const malformed = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`,
      post(body({ pitch: "<script>alert(1)</script>" })));
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.body, {
      state: "malformed",
      error: { code: "INVALID_SUBMISSION", message: "Submission content is invalid" },
    });

    gate.state.healthy = false;
    const stale = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    assert.equal(stale.status, 503);
    assert.equal(stale.body.error.code, "CANONICAL_DATA_UNAVAILABLE");
    assert.equal(Object.hasOwn(stale.body, "publicId"), false);
    gate.state.healthy = true;

    const unknownGate = await requestJson(baseUrl, "/v1/gates/0x9999999999999999999999999999999999999999/submissions",
      post(body()));
    assert.equal(unknownGate.status, 404);
    assert.equal((await gate.store.counts()).submissions, 0);
  });
});

test("an exact resubmission returns the frozen 409 duplicate receipt with an opaque resume path", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const first = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    assert.equal(first.status, 201);

    const duplicate = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, {
      state: "duplicate",
      existing: {
        publicId: first.body.publicId,
        state: "payment_required",
        resumeUrl: `/v1/submissions/${first.body.publicId}/resume`,
      },
    });
    assert.equal(JSON.stringify(duplicate.body).includes("signature"), false);
    assert.equal((await gate.store.counts()).submissions, 1);
  });
});

test("a distinct submission blocked by the pair rule is a coarse 409 with no private count", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    assert.equal((await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()))).status, 201);
    const blocked = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`,
      post(body({ pitch: "An entirely different argument." })));

    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body, {
      state: "rejected_by_policy",
      error: { code: "ACTIVE_QUOTE_EXISTS", message: "Submission is not currently eligible" },
    });
  });
});

test("public status is coarse, unauthenticated, and leaks no private or payment material", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const created = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    const { publicId } = created.body;

    const status = await requestJson(baseUrl, `/v1/submissions/${publicId}/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.equal(status.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(status.body, { publicId, state: "payment_required", updatedAt: START.toISOString() });

    const serialized = JSON.stringify(status.body).toLowerCase();
    for (const secret of ["signature", "quoteid", "payer", "voter", "attention", "capacity", "reservation",
      "notification", "destination", "snapshot", "session", "resume", "nonce"]) {
      assert.equal(serialized.includes(secret), false, secret);
    }

    gate.state.now = new Date(START.getTime() + 60_000);
    await gate.store.markSettlementPending(publicId);
    const pending = await requestJson(baseUrl, `/v1/submissions/${publicId}/status`);
    assert.deepEqual(pending.body, {
      publicId, state: "pending_settlement", updatedAt: new Date(START.getTime() + 60_000).toISOString(),
    });

    assert.equal((await requestJson(baseUrl, "/v1/submissions/AAAAAAAAAAAAAAAAAAAAAA/status")).status, 404);
    assert.equal((await requestJson(baseUrl, "/v1/submissions/not-a-public-id/status")).status, 404);
  });
});

test("oversized content is coarsely malformed and an over-limit body never reaches the service", async () => {
  const content = await harness();
  await withServer(content.server, async (baseUrl) => {
    const oversize = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`,
      post(body({ pitch: "x".repeat(4001) })));
    assert.equal(oversize.status, 400);
    assert.deepEqual(oversize.body, {
      state: "malformed",
      error: { code: "INVALID_SUBMISSION", message: "Submission content is invalid" },
    });
    assert.equal((await content.store.counts()).submissions, 0);
  });

  // PR4's readJson destroys the socket at the transport cap, so the request is
  // refused outright rather than answered; nothing may be persisted either way.
  const transport = await harness({ server: { maxBodyBytes: 512 } });
  await withServer(transport.server, async (baseUrl) => {
    await assert.rejects(
      requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body({ pitch: "x".repeat(2000) }))),
      /fetch failed|terminated|socket/i,
    );
    assert.equal((await transport.store.counts()).submissions, 0);
  });
});

test("the submission and status routes ignore non-address Gate paths and wrong methods", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    assert.equal((await requestJson(baseUrl, "/v1/gates/not-an-address/submissions", post(body()))).status, 404);
    assert.equal((await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, { method: "GET" })).status, 404);
    assert.equal((await requestJson(baseUrl, "/v1/submissions/AAAAAAAAAAAAAAAAAAAAAA/status", { method: "POST" })).status, 404);
    assert.equal((await gate.store.counts()).submissions, 0);
  });
});

test("a Gate server configured without a submission service serves no quote route", async () => {
  const gate = await harness({ server: { submissionService: undefined } });
  await withServer(gate.server, async (baseUrl) => {
    assert.equal((await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()))).status, 404);
    assert.equal((await requestJson(baseUrl, "/v1/submissions/AAAAAAAAAAAAAAAAAAAAAA/status")).status, 404);
  });
});

// --- G5-2: GET /v1/submissions/:publicId/resume ------------------------------

function get(path, baseUrl, token = TOKEN_VALUE) {
  return requestJson(baseUrl, path, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

test("resume returns the original quote to the owning base_sender session", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const created = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    const { publicId } = created.body;

    const resumed = await get(`/v1/submissions/${publicId}/resume`, baseUrl);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.headers.get("cache-control"), "no-store");
    assert.equal(resumed.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(resumed.body, {
      publicId,
      state: "payment_required",
      updatedAt: START.toISOString(),
      quote: created.body.quote,
    });

    const typed = createQuoteTypedData(buildQuoteMessage(resumed.body.quote.message), resumed.body.quote.domain);
    assert.equal(verifyQuoteSignature(typed, resumed.body.quote.signature, SIGNER_ADDRESS), true);
  });
});

test("resume requires an owning session and never accepts a payer from the URL", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const created = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    const { publicId } = created.body;

    assert.equal((await get(`/v1/submissions/${publicId}/resume`, baseUrl, null)).status, 401);
    assert.equal((await get(`/v1/submissions/${publicId}/resume`, baseUrl, "wrong")).status, 401);

    // A payer supplied in the query string is ignored: identity comes only from
    // the authenticated session.
    const spoofed = await get(`/v1/submissions/${publicId}/resume?payer=${PAYER}`, baseUrl);
    assert.equal(spoofed.status, 200);
    assert.deepEqual(spoofed.body.quote, created.body.quote);

    assert.equal((await get("/v1/submissions/AAAAAAAAAAAAAAAAAAAAAA/resume", baseUrl)).status, 404);
    assert.equal((await get("/v1/submissions/not-a-public-id/resume", baseUrl)).status, 404);
  });
});

test("a non-owning wallet gets no existence or private detail from resume", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const created = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    gate.state.sessionWallet = "0x9999999999999999999999999999999999999999";

    const foreign = await get(`/v1/submissions/${created.body.publicId}/resume`, baseUrl);
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.body, { error: { code: "NOT_FOUND", message: "Not found" } });
    assert.equal(JSON.stringify(foreign.body).includes(created.body.quote.signature), false);
  });
});

test("an expired quote resumes to a coarse expired state with no payment payload", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const created = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    gate.state.now = new Date(START.getTime() + 10 * 60 * 1000);

    const expired = await get(`/v1/submissions/${created.body.publicId}/resume`, baseUrl);
    assert.equal(expired.status, 200);
    assert.equal(expired.body.state, "expired");
    assert.equal(Object.hasOwn(expired.body, "quote"), false);
    assert.equal(JSON.stringify(expired.body).includes(created.body.quote.signature), false);
  });
});

test("repeated resume is idempotent and creates no second quote or reservation", async () => {
  const gate = await harness();
  await withServer(gate.server, async (baseUrl) => {
    const created = await requestJson(baseUrl, `/v1/gates/${VOTER}/submissions`, post(body()));
    const first = await get(`/v1/submissions/${created.body.publicId}/resume`, baseUrl);
    gate.state.now = new Date(START.getTime() + 30_000);
    const second = await get(`/v1/submissions/${created.body.publicId}/resume`, baseUrl);

    assert.deepEqual(second.body, first.body);
    assert.deepEqual(await gate.store.counts(), {
      snapshots: 1, submissions: 1, quotes: 1, reservations: 1, inboxItems: 0, notifications: 0, monitors: 0,
    });
  });
});
