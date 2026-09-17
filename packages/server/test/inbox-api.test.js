const assert = require("node:assert/strict");
const test = require("node:test");

const { MemoryGateStore } = require("../src/gate/store-memory");
const { createQuoteSigner } = require("../src/gate/quote-signer");
const { createInboxService } = require("../src/gate/inbox-service");
const { createGateHttpServer } = require("../src/gate/http");

const ADDR = {
  wallet1: "0x1111111111111111111111111111111111111111",
  wallet2: "0x2222222222222222222222222222222222222222",
  payer1: "0x3333333333333333333333333333333333333333",
  payer2: "0x4444444444444444444444444444444444444444",
  splitter: "0x5555555555555555555555555555555555555555",
  signer: "0x6666666666666666666666666666666666666666",
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const hash = (digit) => `0x${digit.repeat(64)}`;
const SIGNER_KEY = `0x${"7".repeat(64)}`;
const OWNER_TOKEN = "owner-session";
const OTHER_TOKEN = "other-session";
const FORBIDDEN = /notification|destination|capacity|signature|session|nonce|ciphertext|provider|ip address|quoteSigner|retry/i;

function gateSigner() {
  return createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: ADDR.splitter });
}

async function setupStore() {
  const store = new MemoryGateStore({ clock: () => new Date("2026-01-01T00:00:00.000Z") });
  await store.mutateProfile({
    profile: { id: "profile-1", wallet: ADDR.wallet1, availability: "accepting_now" },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: [] },
  });
  await store.mutateProfile({
    profile: { id: "profile-2", wallet: ADDR.wallet2, availability: "accepting_now" },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: [] },
  });
  await store.configureDeployment({
    id: "deployment-1", chainId: "8453", splitter: ADDR.splitter, signer: ADDR.signer,
    token: ADDR.token, gavelRecipient: ADDR.payer2, contractCodeHash: hash("e"),
    deploymentBlock: "0", nextBlock: "0", config: { environment: "production" }, rpcAccess: {}, issuanceActive: true,
  });
  return store;
}

function issuance(suffix, { profileId = "profile-1", voter = ADDR.wallet1, payer = ADDR.payer1,
  submissionHash = hash("a"), quoteId = hash("b") } = {}) {
  return {
    context: {
      authPassed: true, parsePassed: true, expectedProfileVersion: "1", walletKind: "eoa",
      authenticatedSender: payer, payerIsEoa: true, payerWalletKind: "eoa",
      basePayoutCodeHash: null, stage: "VOTING", deploymentCodeHash: hash("e"),
    },
    snapshot: {
      id: `snapshot-${suffix}`, dao: "nouns", proposalId: "7", contentHash: hash("c"),
      nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1",
      sourceBlock: "100", sourceBlockHash: hash("d"), refreshedAt: new Date("2026-01-01T00:00:00.000Z"),
      canonicalFacts: { dao: "nouns", proposalId: "7", nativeState: "ACTIVE" },
      decodedFacts: { decoderVersion: "1", actions: [] },
      canonicalActions: [{ target: ADDR.token, valueWei: "0", calldata: "0xdead" }],
    },
    submission: {
      id: `submission-${suffix}`, submissionHash, profileId, payer, signedSender: payer,
      material: { pitch: "Fund it.", disclosures: "None.", evidenceUrls: ["https://example.com/a"] },
    },
    quote: {
      id: `quote-${suffix}`, quoteId, payer, voter, attentionAmount: "1000000",
      feeAmount: "250000", token: ADDR.token, baseChainId: "8453", splitter: ADDR.splitter,
      deploymentId: "deployment-1", quoteVersion: 1,
    },
    reservation: { id: `reservation-${suffix}`, profileId, amount: "1000000" },
    signer: gateSigner(),
  };
}

function settlementCommand(suffix, quoteId, overrides = {}) {
  const voter = overrides.voter || ADDR.wallet1;
  const payer = overrides.payer || ADDR.payer1;
  const submissionHash = overrides.submissionHash || hash("a");
  return {
    quoteId,
    settlement: {
      txHash: hash("8"), logIndex: 0, receiptBlock: "150", receiptBlockHash: hash("9"),
      receiptBlockTimestamp: new Date("2026-01-01T00:05:00.000Z"),
      settledAt: new Date("2026-01-01T00:06:00.000Z"),
      event: {
        quoteId, payer, voter, attentionAmount: "1000000",
        gavelRecipient: ADDR.payer2, gavelFeeAmount: "250000", token: ADDR.token, submissionHash,
      },
      evidence: {
        oneConfirmation: true, confirmations: 1, canonical: true, scannerVerified: true,
        chainId: "8453", splitter: ADDR.splitter,
      },
    },
    inbox: {
      id: `inbox-${suffix}`, issuanceLifecycle: "VOTING", currentLifecycle: "VOTING",
      lifecycleChanged: false, currentLifecycleUnavailable: false,
    },
    notification: {
      id: `notification-${suffix}`, channel: "email", destinationRef: "vault:ciphertext",
      summary: { subject: "Paid pitch ready", text: "Open your private Gate inbox." }, status: "pending",
    },
    monitor: { id: `monitor-${suffix}`, nextCheckBlock: "151" },
  };
}

async function seedInbox(store, suffix, options = {}) {
  const quoteId = options.quoteId || hash(suffix[0] || "b");
  await store.issue(issuance(suffix, { ...options, quoteId }));
  await store.settle(settlementCommand(suffix, quoteId, options));
  return `inbox-${suffix}`;
}

function authService() {
  return {
    async issueChallenge() { return {}; },
    async verifyProof() { return {}; },
    async authenticateSession(token, requirements = {}) {
      if (token === OWNER_TOKEN) {
        if (requirements.role && requirements.role !== "dao_inbox") throw new Error("session unavailable");
        return { wallet: ADDR.wallet1, role: "dao_inbox", chainId: "1", audience: "gate" };
      }
      if (token === OTHER_TOKEN) {
        if (requirements.role && requirements.role !== "dao_inbox") throw new Error("session unavailable");
        return { wallet: ADDR.wallet2, role: "dao_inbox", chainId: "1", audience: "gate" };
      }
      throw new Error("session unavailable");
    },
  };
}

function profileService() {
  return {
    async updateProfile() { return {}; },
    async listPublicProfiles() { return []; },
    async getPublicProfile(wallet) {
      if (wallet.toLowerCase() !== ADDR.wallet1) return null;
      return { wallet: ADDR.wallet1, availability: "accepting_now", acceptingSubmissions: true };
    },
  };
}

async function withServer(store, callback) {
  const inboxService = createInboxService({ store });
  const server = createGateHttpServer({
    authService: authService(), profileService: profileService(), inboxService,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function requestJson(baseUrl, path, { method = "GET", token, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
}

test("owner can list private inbox items", async () => {
  const store = await setupStore();
  await seedInbox(store, "a", { quoteId: hash("1") });
  await withServer(store, async (base) => {
    const listed = await requestJson(base, "/v1/gate/me/inbox", { token: OWNER_TOKEN });
    assert.equal(listed.status, 200);
    assert.equal(listed.items === undefined, true);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].id, "inbox-a");
    assert.equal(listed.body.items[0].pitch, "Fund it.");
    assert.equal(listed.body.items[0].archived, false);
    assert.equal(JSON.stringify(listed.body).search(FORBIDDEN), -1);
  });
});

test("non-owner cannot list another inbox", async () => {
  const store = await setupStore();
  await seedInbox(store, "a", { quoteId: hash("1") });
  await withServer(store, async (base) => {
    const listed = await requestJson(base, "/v1/gate/me/inbox", { token: OTHER_TOKEN });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items, []);
    assert.equal((await requestJson(base, "/v1/gate/me/inbox")).status, 401);
  });
});

test("owner can show one item with fact provenance and raw unknown actions", async () => {
  const store = await setupStore();
  await seedInbox(store, "a", { quoteId: hash("1") });
  await withServer(store, async (base) => {
    const shown = await requestJson(base, "/v1/gate/me/inbox/inbox-a", { token: OWNER_TOKEN });
    assert.equal(shown.status, 200);
    assert.equal(shown.body.pitch, "Fund it.");
    assert.equal(shown.body.disclosures, "None.");
    assert.deepEqual(shown.body.evidenceUrls, ["https://example.com/a"]);
    assert.equal(shown.body.canonicalFacts.proposalId, "7");
    assert.deepEqual(shown.body.decodedFacts.actions, []);
    assert.equal(shown.body.enrichedFacts.length, 0);
    assert.equal(shown.body.rawUnknownActions.length, 1);
    assert.equal(shown.body.issuanceLifecycle, "VOTING");
    assert.equal(shown.body.currentLifecycle, "VOTING");
    assert.equal(shown.body.stateChangedAfterQuote, false);
    assert.equal(JSON.stringify(shown.body).search(FORBIDDEN), -1);
  });
});

test("guessed or foreign item does not disclose existence or details", async () => {
  const store = await setupStore();
  await seedInbox(store, "a", { quoteId: hash("1") });
  await withServer(store, async (base) => {
    const missing = await requestJson(base, "/v1/gate/me/inbox/inbox-nope", { token: OWNER_TOKEN });
    const foreign = await requestJson(base, "/v1/gate/me/inbox/inbox-a", { token: OTHER_TOKEN });
    assert.equal(missing.status, 404);
    assert.equal(foreign.status, 404);
    assert.deepEqual(missing.body, foreign.body);
    assert.equal(JSON.stringify(missing.body).includes("Fund it."), false);
  });
});

test("archive is owner-bound, idempotent, and does not alter settlement", async () => {
  const store = await setupStore();
  await seedInbox(store, "a", { quoteId: hash("1") });
  const before = await store.counts();
  await withServer(store, async (base) => {
    assert.equal((await requestJson(base, "/v1/gate/me/inbox/inbox-a/archive", {
      method: "POST", token: OTHER_TOKEN,
    })).status, 404);
    const first = await requestJson(base, "/v1/gate/me/inbox/inbox-a/archive", {
      method: "POST", token: OWNER_TOKEN,
    });
    const second = await requestJson(base, "/v1/gate/me/inbox/inbox-a/archive", {
      method: "POST", token: OWNER_TOKEN,
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.body, { id: "inbox-a", archived: true });
    assert.deepEqual(second.body, first.body);
    const shown = await requestJson(base, "/v1/gate/me/inbox/inbox-a", { token: OWNER_TOKEN });
    assert.equal(shown.body.archived, true);
  });
  assert.deepEqual(await store.counts(), before);
});

test("authenticated profile uses the public projection and inbox has no follow-up route", async () => {
  const store = await setupStore();
  await withServer(store, async (base) => {
    const profile = await requestJson(base, "/v1/gate/me/profile", { token: OWNER_TOKEN });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.wallet, ADDR.wallet1);
    assert.equal(JSON.stringify(profile.body).search(FORBIDDEN), -1);
    assert.equal((await requestJson(base, "/v1/gate/me/inbox/inbox-a/followup", {
      method: "POST", token: OWNER_TOKEN, body: { text: "hi" },
    })).status, 404);
    assert.equal((await requestJson(base, "/v1/gate/me/inbox/inbox-a/reply", {
      method: "POST", token: OWNER_TOKEN, body: { text: "hi" },
    })).status, 404);
  });
});
