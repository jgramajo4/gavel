const assert = require("node:assert/strict");
const test = require("node:test");
const util = require("node:util");
const { Wallet, getAddress, keccak256, toUtf8Bytes } = require("ethers");
const {
  buildQuoteMessage, createQuoteDomain, createQuoteTypedData, deriveUsdcAuthorization,
  hashSubmission, quoteTotalAmount, verifyQuoteSignature,
} = require("@gavel/gate");

const { MemoryGateStore } = require("../src/gate/store-memory");

function loadSigner() { return require("../src/gate/quote-signer"); }
function loadService() { return require("../src/gate/submission-service"); }

const SIGNER_KEY = `0x${"7".repeat(64)}`;
const SIGNER_ADDRESS = new Wallet(SIGNER_KEY).address;
const VOTER = "0x1111111111111111111111111111111111111111";
const SPLITTER = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const GAVEL_RECIPIENT = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEPLOYMENT_CODE_HASH = `0x${"ee".repeat(32)}`;
const BLOCK_HASH = `0x${"dd".repeat(32)}`;
const CONTENT_HASH = `0x${"cc".repeat(32)}`;
const START = new Date("2026-01-01T00:00:00.000Z");

function payerAt(index) { return `0x${index.toString(16).padStart(40, "0")}`; }

function submissionBody(overrides = {}) {
  return {
    dao: "nouns",
    proposalId: "42",
    stage: "VOTING",
    position: "FOR",
    pitch: "Fund it. The treasury **can** afford this.",
    disclosures: "I hold no position.",
    evidenceUrls: ["https://example.com/a"],
    ...overrides,
  };
}

function session(wallet = PAYER) {
  return { wallet: wallet.toLowerCase(), role: "base_sender", chainId: "8453", audience: "gate", expiry: "9999999999" };
}

async function harness(options = {}) {
  const state = { now: new Date(START), fetchCalls: 0, issued: [], payerCode: "0x", rateLimited: false };
  const clock = () => new Date(state.now);
  const store = new MemoryGateStore({ clock });
  await store.mutateProfile({
    profile: { id: "profile-1", wallet: VOTER, walletKind: "eoa", availability: "accepting_now" },
    policy: {
      dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: [], ...(options.policy || {}),
    },
  });
  await store.configureDeployment({
    id: "deployment-1", chainId: "8453", splitter: SPLITTER, signer: SIGNER_ADDRESS, token: TOKEN,
    gavelRecipient: GAVEL_RECIPIENT, contractCodeHash: DEPLOYMENT_CODE_HASH,
    deploymentBlock: "0", nextBlock: "0", issuanceActive: true,
    config: { environment: "production" }, rpcAccess: {},
  });

  const recordingStore = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== "issue") return typeof value === "function" ? value.bind(target) : value;
      return async (input) => {
        const { signer, ...material } = input;
        state.issued.push({ ...structuredClone(material), signerAddress: signer?.address });
        return target.issue(input);
      };
    },
  });

  const indexSource = {
    healthy: true,
    nativeState: "ACTIVE",
    refreshedAt: () => new Date(state.now.getTime() - 60_000).toISOString(),
  };
  const indexClient = {
    async getProposalSnapshot(proposalId) {
      if (!indexSource.healthy) {
        const error = new Error("Nouns governance index is unavailable");
        error.name = "IndexUnavailableError";
        error.code = "INDEX_UNAVAILABLE";
        error.statusCode = 503;
        throw error;
      }
      return {
        dao: "nouns", proposalId: String(proposalId), nativeState: indexSource.nativeState,
        eligibility: indexSource.nativeState === "ACTIVE" ? "VOTING" : "CLOSED",
        mappingVersion: "nouns-lifecycle/1", refreshedAt: indexSource.refreshedAt(),
        sourceBlock: "100", sourceBlockHash: BLOCK_HASH, contentHash: CONTENT_HASH,
        canonicalActions: [{ actionIndex: 0, target: VOTER, valueWei: "1000000000000000000", calldata: "0x", signature: "" }],
      };
    },
  };

  const { createQuoteSigner } = loadSigner();
  const { createSubmissionService } = loadService();
  const service = createSubmissionService({
    store: recordingStore,
    indexClient,
    quoteSigner: createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }),
    deployment: { id: "deployment-1", chainId: 8453, splitter: SPLITTER, token: TOKEN, codeHash: DEPLOYMENT_CODE_HASH },
    basePayerCodeReader: async () => state.payerCode,
    senderPolicy: { async assertAllowed() {
      if (!state.rateLimited) return;
      const error = new Error("Too many submission requests");
      error.state = "rejected_by_policy"; error.code = "RATE_LIMITED"; error.statusCode = 429;
      throw error;
    } },
    clock,
    fetch: () => { state.fetchCalls += 1; throw new Error("evidence URLs must never be fetched"); },
    ...options.service,
  });

  return {
    state, store, service, indexSource,
    setNow: (value) => { state.now = new Date(value); },
    advance: (ms) => { state.now = new Date(state.now.getTime() + ms); },
    submit: (body = submissionBody(), wallet = PAYER, extra = {}) =>
      service.createSubmission({ session: session(wallet), voterWallet: VOTER, request: body, ...extra }),
  };
}

function rejection(promise) {
  return promise.then(() => null, (error) => error);
}

test("a quote carries the exact signed fields, splitter domain, and locally verifiable signature", async () => {
  const gate = await harness();
  const result = await gate.submit();

  assert.equal(result.state, "payment_required");
  assert.match(result.publicId, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(Object.keys(result).sort(), ["publicId", "quote", "state", "updatedAt"]);
  assert.deepEqual(Object.keys(result.quote).sort(), ["domain", "message", "signature", "totalAmount"]);
  assert.deepEqual(result.quote.domain, {
    name: "GavelGateSplitter", version: "1", chainId: 8453, verifyingContract: getAddress(SPLITTER),
  });
  assert.deepEqual(Object.keys(result.quote.message), [
    "quoteId", "payer", "voter", "attentionAmount", "gavelFeeAmount", "submissionHash", "token", "expiry", "quoteVersion",
  ]);
  assert.equal(result.quote.message.attentionAmount, "1000000");
  assert.equal(result.quote.message.gavelFeeAmount, "250000");
  assert.equal(result.quote.message.quoteVersion, "1");
  assert.equal(result.quote.message.token, getAddress(TOKEN));
  assert.equal(result.quote.message.payer, getAddress(PAYER));
  assert.equal(result.quote.message.voter, getAddress(VOTER));
  assert.equal(result.quote.totalAmount, "1250000");
  assert.equal(result.quote.message.expiry, String(START.getTime() / 1000 + 600));

  const typed = createQuoteTypedData(buildQuoteMessage(result.quote.message), result.quote.domain);
  assert.equal(verifyQuoteSignature(typed, result.quote.signature, SIGNER_ADDRESS), true);
  assert.equal(verifyQuoteSignature(typed, result.quote.signature, PAYER), false);
  assert.equal(quoteTotalAmount(typed.message), result.quote.totalAmount);
  assert.deepEqual(deriveUsdcAuthorization(typed.message, SPLITTER), {
    from: getAddress(PAYER), to: getAddress(SPLITTER), value: "1250000",
    validAfter: "0", validBefore: result.quote.message.expiry, nonce: result.quote.message.quoteId,
  });
});

test("the quote binds the immutable submission hash and the persisted issuance snapshot", async () => {
  const gate = await harness();
  const body = submissionBody();
  const result = await gate.submit(body);

  const expectedHash = hashSubmission({
    payer: PAYER, signedSender: PAYER, voter: VOTER, dao: "nouns", proposalId: "42", stage: "VOTING",
    position: body.position, pitch: body.pitch, disclosures: body.disclosures, evidenceUrls: body.evidenceUrls,
  });
  assert.equal(result.quote.message.submissionHash, expectedHash);

  const [issued] = gate.state.issued;
  assert.equal(issued.submission.submissionHash, expectedHash);
  assert.equal(issued.snapshot.contentHash, CONTENT_HASH);
  assert.equal(issued.snapshot.sourceBlockHash, BLOCK_HASH);
  assert.equal(issued.snapshot.nativeState, "ACTIVE");
  assert.equal(issued.snapshot.eligibility, "VOTING");
  assert.equal(issued.snapshot.mappingVersion, "nouns-lifecycle/1");
  assert.equal(issued.submission.issuanceSnapshotId ?? issued.snapshot.id, issued.snapshot.id);
  assert.equal(issued.quote.deploymentId, "deployment-1");
  assert.equal(issued.context.deploymentCodeHash, DEPLOYMENT_CODE_HASH);
  assert.equal(issued.context.expectedProfileVersion, "1");
  assert.equal(issued.reservation.amount, "1000000");
  assert.deepEqual(issued.snapshot.decodedFacts.actions.map((fact) => fact.kind), ["native_eth_transfer"]);
  assert.equal(issued.snapshot.decodedFacts.actions[0].source, "decoded");

  // The quoteId is random 32 bytes, never derived from submission content.
  const second = await gate.submit(submissionBody({ position: "AGAINST" }), payerAt(0x51));
  assert.notEqual(second.quote.message.quoteId, result.quote.message.quoteId);
  assert.notEqual(result.quote.message.quoteId, expectedHash);
});

test("a stale or unhealthy canonical index fails closed with no submission, snapshot, quote, or reservation", async () => {
  const gate = await harness();
  gate.indexSource.healthy = false;

  const error = await rejection(gate.submit());
  assert.equal(error.statusCode, 503);
  assert.equal(error.code, "CANONICAL_DATA_UNAVAILABLE");
  assert.equal(error.state, "rejected_by_policy");
  assert.deepEqual(await gate.store.counts(), {
    snapshots: 0, submissions: 0, quotes: 0, reservations: 0, inboxItems: 0, notifications: 0, monitors: 0,
  });
  assert.equal(gate.state.issued.length, 0);
});

test("an ineligible lifecycle, unavailable Gate, or unsupported stage issues no quote and persists nothing", async () => {
  const closed = await harness();
  closed.indexSource.nativeState = "SUCCEEDED";
  assert.equal((await rejection(closed.submit())).code, "NOT_ACCEPTING");
  assert.equal((await closed.store.counts()).quotes, 0);

  const paused = await harness();
  await paused.store.mutateProfile({ profile: { id: "profile-1", wallet: VOTER, availability: "paused" } });
  assert.equal((await rejection(paused.submit())).code, "NOT_ACCEPTING");
  assert.equal((await paused.store.counts()).quotes, 0);

  const staged = await harness();
  assert.equal((await rejection(staged.submit(submissionBody({ stage: "PRE_VOTE" })))).code, "NOT_ACCEPTING");
  assert.equal((await rejection(staged.submit(submissionBody({ stage: "CLOSED" })))).code, "NOT_ACCEPTING");
  assert.equal((await staged.store.counts()).submissions, 0);

  const unknown = await harness();
  const missing = await rejection(unknown.service.createSubmission({
    session: session(), voterWallet: payerAt(0x99), request: submissionBody(),
  }));
  assert.equal(missing.statusCode, 404);
  assert.equal((await unknown.store.counts()).submissions, 0);
});

test("malformed content is rejected before hashing and never reaches persistence", async () => {
  const gate = await harness();
  for (const body of [
    submissionBody({ pitch: "<script>alert(1)</script>" }),
    submissionBody({ pitch: "a".repeat(4001) }),
    submissionBody({ evidenceUrls: ["http://example.com"] }),
    submissionBody({ evidenceUrls: ["https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"] }),
    submissionBody({ dao: "ens" }),
  ]) {
    const error = await rejection(gate.submit(body));
    assert.equal(error.state, "malformed");
    assert.equal(error.statusCode, 400);
  }
  assert.equal(gate.state.issued.length, 0);
  assert.deepEqual(await gate.store.counts(), {
    snapshots: 0, submissions: 0, quotes: 0, reservations: 0, inboxItems: 0, notifications: 0, monitors: 0,
  });
});

test("a session that is not an exact base_sender payer cannot buy a quote", async () => {
  const gate = await harness();

  const noSession = await rejection(gate.service.createSubmission({
    session: null, voterWallet: VOTER, request: submissionBody(),
  }));
  assert.equal(noSession.statusCode, 401);

  const wrongRole = await rejection(gate.service.createSubmission({
    session: { ...session(), role: "dao_profile" }, voterWallet: VOTER, request: submissionBody(),
  }));
  assert.equal(wrongRole.statusCode, 401);

  const contractPayer = await harness({ service: { basePayerCodeReader: async () => "0x60006000" } });
  assert.equal((await rejection(contractPayer.submit())).code, "NOT_ACCEPTING");

  const unavailableRpc = await harness({
    service: { basePayerCodeReader: async () => { throw new Error("rpc down"); } },
  });
  assert.equal((await rejection(unavailableRpc.submit())).statusCode, 503);
  assert.equal((await unavailableRpc.store.counts()).submissions, 0);
});

test("a valid EIP-7702 designator is still rejected as a non-empty-code payer", async () => {
  const delegate = "11".repeat(20);
  const delegatedPayer = await harness({
    service: { basePayerCodeReader: async () => `0xef0100${delegate}` },
  });

  const error = await rejection(delegatedPayer.submit());
  assert.equal(error.code, "NOT_ACCEPTING");
  assert.deepEqual(await delegatedPayer.store.counts(), {
    snapshots: 0, submissions: 0, quotes: 0, reservations: 0, inboxItems: 0, notifications: 0, monitors: 0,
  });
});

test("blocked senders and exhausted quote rate limits issue no quote", async () => {
  const blocked = await harness({
    service: { senderPolicy: { async assertAllowed({ sender }) {
      if (sender === PAYER.toLowerCase()) {
        const error = new Error("Submission is not currently eligible");
        error.state = "rejected_by_policy"; error.code = "SENDER_BLOCKED"; error.statusCode = 403;
        throw error;
      }
    } } },
  });
  assert.equal((await rejection(blocked.submit())).code, "SENDER_BLOCKED");
  assert.equal((await blocked.store.counts()).submissions, 0);

  const limited = await harness({ service: { senderPolicy: { async assertAllowed() {
    const error = new Error("Too many submissions");
    error.state = "rejected_by_policy"; error.code = "RATE_LIMITED"; error.statusCode = 429;
    throw error;
  } } } });
  assert.equal((await rejection(limited.submit())).statusCode, 429);
  assert.equal((await limited.store.counts()).submissions, 0);
});

test("an exact resubmission by the original sender is a duplicate that reuses the original receipt", async () => {
  const gate = await harness();
  const first = await gate.submit();

  const duplicate = await gate.submit();
  assert.deepEqual(duplicate, {
    state: "duplicate",
    existing: {
      publicId: first.publicId,
      state: "payment_required",
      resumeUrl: `/v1/submissions/${first.publicId}/resume`,
    },
  });
  assert.equal((await gate.store.counts()).submissions, 1);
  assert.equal((await gate.store.counts()).quotes, 1);
});

test("one sender cannot hold two active quotes for the same voter, and new content does not evade it", async () => {
  const gate = await harness();
  await gate.submit();

  const changed = await rejection(gate.submit(submissionBody({ pitch: "A completely different pitch." })));
  assert.equal(changed.code, "ACTIVE_QUOTE_EXISTS");
  assert.equal(changed.state, "rejected_by_policy");
  assert.equal(changed.statusCode, 409);
  assert.equal((await gate.store.counts()).submissions, 1);

  // A different sender for the same voter is unaffected by that pair rule.
  const other = await gate.submit(submissionBody({ pitch: "Another advocate entirely." }), payerAt(0x77));
  assert.equal(other.state, "payment_required");
});

test("pending reservation liability is capped and wall-clock expiry alone never frees a slot", async () => {
  const gate = await harness();
  const policy = await gate.store.getPolicy("profile-1", "nouns");
  assert.equal(policy.settledCapacity, 25);
  assert.equal(policy.pendingReservationCapacity, 12);

  for (let index = 1; index <= 12; index += 1) {
    const result = await gate.submit(submissionBody({ position: `FOR-${index}` }), payerAt(0x100 + index));
    assert.equal(result.state, "payment_required");
  }
  const denied = await rejection(gate.submit(submissionBody({ position: "FOR-13" }), payerAt(0x200)));
  assert.equal(denied.state, "rejected_by_policy");
  assert.equal(denied.code, "NOT_ACCEPTING");
  assert.equal((await gate.store.counts()).quotes, 12);

  // Wall-clock expiry moves reservations to reconciliation but keeps the liability.
  gate.advance(11 * 60 * 1000);
  await gate.store.markExpired();
  const stillDenied = await rejection(gate.submit(submissionBody({ position: "FOR-14" }), payerAt(0x201)));
  assert.equal(stillDenied.code, "NOT_ACCEPTING");
  assert.equal((await gate.store.counts()).quotes, 12);
});

test("scanner-proven release frees eligible reservation slots", async () => {
  const gate = await harness();
  const quoteIds = [];
  for (let index = 1; index <= 12; index += 1) {
    const result = await gate.submit(submissionBody({ position: `FOR-${index}` }), payerAt(0x300 + index));
    quoteIds.push(result.quote.message.quoteId);
  }
  assert.equal((await rejection(gate.submit(submissionBody({ position: "X" }), payerAt(0x400)))).code, "NOT_ACCEPTING");

  gate.advance(11 * 60 * 1000);
  await gate.store.markExpired();
  const canonicalBlocks = Array.from({ length: 11 }, (_, blockNumber) => ({
    blockNumber: String(blockNumber),
    blockHash: `0x${(blockNumber + 1).toString(16).padStart(64, "0")}`,
    parentHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    blockTimestamp: gate.state.now,
  }));
  assert.deepEqual(await gate.store.recordScannerRange({
    deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "10",
    canonicalBlockHash: canonicalBlocks.at(-1).blockHash, canonicalBlockTimestamp: gate.state.now,
    canonicalBlocks, observations: [],
  }), { released: 12, reorged: 0 });

  const allowed = await gate.submit(submissionBody({ position: "AFTER-RELEASE" }), payerAt(0x401));
  assert.equal(allowed.state, "payment_required");
});

test("settled capacity denies new quotes once the rolling window is full", async () => {
  const gate = await harness({ policy: { settledCapacity: 2, pendingReservationCapacity: 1 } });
  const settle = async (index) => {
    const result = await gate.submit(submissionBody({ position: `S-${index}` }), payerAt(0x500 + index));
    const quoteId = result.quote.message.quoteId;
    await gate.store.settle({
      quoteId,
      settlement: {
        txHash: `0x${index.toString(16).padStart(64, "0")}`, receiptBlockHash: BLOCK_HASH, receiptBlock: String(index),
        receiptBlockTimestamp: new Date(gate.state.now.getTime() + 1000), settledAt: new Date(gate.state.now.getTime() + 2000),
        logIndex: 0,
        event: {
          quoteId, payer: payerAt(0x500 + index), voter: VOTER, attentionAmount: "1000000",
          gavelRecipient: GAVEL_RECIPIENT, gavelFeeAmount: "250000", token: TOKEN,
          submissionHash: result.quote.message.submissionHash,
        },
        evidence: { oneConfirmation: true, confirmations: 1, canonical: true, scannerVerified: true, chainId: "8453", splitter: SPLITTER },
      },
      inbox: {
        id: `inbox-${index}`, issuanceLifecycle: "VOTING", currentLifecycle: "VOTING",
        lifecycleChanged: false, currentLifecycleUnavailable: false,
      },
      notification: { id: `notification-${index}`, channel: "email", status: "pending" },
      monitor: { id: `monitor-${index}`, nextCheckBlock: String(index + 64) },
    });
  };

  await settle(1);
  await settle(2);
  const denied = await rejection(gate.submit(submissionBody({ position: "S-3" }), payerAt(0x600)));
  assert.equal(denied.state, "rejected_by_policy");
  assert.equal(denied.code, "NOT_ACCEPTING");
  assert.equal((await gate.store.counts()).quotes, 2);
  assert.equal((await gate.store.counts()).inboxItems, 2);
});

test("a settled sender, voter, and proposal pair is capped at two in the rolling window", async () => {
  const gate = await harness({ policy: { settledCapacity: 6, pendingReservationCapacity: 3 } });
  const settleFor = async (index, position) => {
    const result = await gate.submit(submissionBody({ position }), PAYER);
    const quoteId = result.quote.message.quoteId;
    await gate.store.settle({
      quoteId,
      settlement: {
        txHash: `0x${(0xa0 + index).toString(16).padStart(64, "0")}`, receiptBlockHash: BLOCK_HASH,
        receiptBlock: String(index), receiptBlockTimestamp: new Date(gate.state.now.getTime() + 1000),
        settledAt: new Date(gate.state.now.getTime() + 2000), logIndex: 0,
        event: {
          quoteId, payer: PAYER, voter: VOTER, attentionAmount: "1000000", gavelRecipient: GAVEL_RECIPIENT,
          gavelFeeAmount: "250000", token: TOKEN, submissionHash: result.quote.message.submissionHash,
        },
        evidence: { oneConfirmation: true, confirmations: 1, canonical: true, scannerVerified: true, chainId: "8453", splitter: SPLITTER },
      },
      inbox: { id: `inbox-p-${index}`, issuanceLifecycle: "VOTING", currentLifecycle: "VOTING",
        lifecycleChanged: false, currentLifecycleUnavailable: false },
      notification: { id: `notification-p-${index}`, channel: "email", status: "pending" },
      monitor: { id: `monitor-p-${index}`, nextCheckBlock: String(index + 64) },
    });
  };

  await settleFor(1, "P-1");
  await settleFor(2, "P-2");
  const denied = await rejection(gate.submit(submissionBody({ position: "P-3" }), PAYER));
  assert.equal(denied.code, "SENDER_PROPOSAL_LIMIT");
  assert.equal(denied.statusCode, 409);
  assert.equal((await gate.store.counts()).quotes, 2);
});

test("a price, policy, or availability change after issuance leaves the old quote valid and binds new issuance", async () => {
  const gate = await harness();
  const first = await gate.submit();
  const firstTyped = createQuoteTypedData(buildQuoteMessage(first.quote.message), first.quote.domain);

  await gate.store.mutateProfile({
    profile: { id: "profile-1", wallet: VOTER, availability: "accepting_now" },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "5000000", tags: [] },
  });

  // The already-issued quote is untouched and still verifies against the signer.
  assert.equal(verifyQuoteSignature(firstTyped, first.quote.signature, SIGNER_ADDRESS), true);
  assert.equal(first.quote.message.attentionAmount, "1000000");
  assert.equal((await gate.store.getSubmission(first.publicId)).state, "payment_required");

  const second = await gate.submit(submissionBody({ position: "SECOND" }), payerAt(0x701));
  assert.equal(second.quote.message.attentionAmount, "5000000");
  assert.equal(second.quote.totalAmount, "5250000");

  await gate.store.mutateProfile({ profile: { id: "profile-1", wallet: VOTER, availability: "closed" } });
  assert.equal((await rejection(gate.submit(submissionBody({ position: "THIRD" }), payerAt(0x702)))).code, "NOT_ACCEPTING");
  assert.equal(verifyQuoteSignature(firstTyped, first.quote.signature, SIGNER_ADDRESS), true);
});

test("no part of the submission flow ever fetches an advocate evidence URL", async () => {
  const originalFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = () => { globalCalls += 1; throw new Error("global fetch must not be reachable"); };
  try {
    const gate = await harness();
    const result = await gate.submit(submissionBody({
      evidenceUrls: ["https://example.com/a", "https://example.org/b"],
      pitch: "See [evidence](https://example.net/c).",
    }));
    assert.equal(result.state, "payment_required");
    assert.equal(gate.state.fetchCalls, 0);
    assert.equal(globalCalls, 0);
    const [issued] = gate.state.issued;
    assert.deepEqual(issued.submission.material.evidenceUrls, ["https://example.com/a", "https://example.org/b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the public status projection exposes only the coarse receipt state", async () => {
  const gate = await harness();
  const result = await gate.submit();

  assert.deepEqual(await gate.service.getPublicStatus(result.publicId), {
    publicId: result.publicId, state: "payment_required", updatedAt: new Date(START),
  });
  assert.equal(await gate.service.getPublicStatus("AAAAAAAAAAAAAAAAAAAAAA"), null);

  const serialized = JSON.stringify(await gate.service.getPublicStatus(result.publicId));
  for (const secret of ["signature", "quoteId", "payer", "attention", "capacity", "notification", "destination", "snapshot"]) {
    assert.equal(serialized.toLowerCase().includes(secret.toLowerCase()), false, secret);
  }
});

test("the quote signer never exposes its key through inspection, serialization, or errors", async () => {
  const { createQuoteSigner, redactSignerMaterial } = loadSigner();
  const signer = createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER });

  assert.equal(signer.address, SIGNER_ADDRESS);
  const exposed = [
    JSON.stringify(signer), util.inspect(signer, { depth: 10 }), String(signer),
    Object.keys(signer).join(","), Object.values(signer).map(String).join(","),
    util.inspect(Object.getOwnPropertyDescriptors(signer), { depth: 10 }),
  ].join(" ");
  assert.equal(exposed.includes(SIGNER_KEY.slice(2)), false);
  assert.equal(exposed.toLowerCase().includes("privatekey"), false);

  const message = buildQuoteMessage({
    quoteId: `0x${"ab".repeat(32)}`, payer: PAYER, voter: VOTER, attentionAmount: "1000000",
    gavelFeeAmount: "250000", submissionHash: `0x${"cd".repeat(32)}`, token: TOKEN,
    expiry: "1789344600", quoteVersion: "1",
  });
  const signature = await signer.signQuote(message);
  assert.equal(verifyQuoteSignature(
    createQuoteTypedData(message, createQuoteDomain({ chainId: 8453, splitter: SPLITTER, verifyingContract: SPLITTER })),
    signature, SIGNER_ADDRESS), true);

  const failure = await rejection(signer.signQuote({ ...message, quoteVersion: "2" }));
  assert.equal(`${failure.message}${failure.stack}`.includes(SIGNER_KEY.slice(2)), false);

  assert.equal(redactSignerMaterial(`key=${SIGNER_KEY} sig=${signature}`).includes(SIGNER_KEY.slice(2)), false);
  assert.equal(redactSignerMaterial(`key=${SIGNER_KEY} sig=${signature}`).includes(signature.slice(2)), false);
});

test("the quote signer is loaded from a service-only secret and verified against its public address", async () => {
  const { createQuoteSignerFromEnv } = loadSigner();
  const configured = createQuoteSignerFromEnv({
    GAVEL_GATE_QUOTE_SIGNER: SIGNER_KEY,
    GAVEL_GATE_QUOTE_SIGNER_ADDRESS: SIGNER_ADDRESS,
  }, { chainId: 8453, splitter: SPLITTER });
  assert.equal(configured.address, SIGNER_ADDRESS);

  assert.throws(() => createQuoteSignerFromEnv({}, { chainId: 8453, splitter: SPLITTER }),
    /GAVEL_GATE_QUOTE_SIGNER/);
  const mismatch = (() => {
    try {
      createQuoteSignerFromEnv({
        GAVEL_GATE_QUOTE_SIGNER: SIGNER_KEY,
        GAVEL_GATE_QUOTE_SIGNER_ADDRESS: PAYER,
      }, { chainId: 8453, splitter: SPLITTER });
      return null;
    } catch (error) { return error; }
  })();
  assert.ok(mismatch);
  assert.equal(`${mismatch.message}${mismatch.stack}`.includes(SIGNER_KEY.slice(2)), false);
});

test("an injected signing interface keeps key custody outside the Gate service", async () => {
  const { createQuoteSigner } = loadSigner();
  const wallet = new Wallet(`0x${"9".repeat(64)}`);
  let calls = 0;
  const signer = createQuoteSigner({
    signer: {
      address: wallet.address,
      async signTypedData(domain, types, message) {
        calls += 1;
        assert.equal(domain.name, "GavelGateSplitter");
        assert.deepEqual(Object.keys(types), ["Quote"]);
        return wallet.signTypedData(domain, types, message);
      },
    },
    chainId: 8453,
    splitter: SPLITTER,
  });

  const message = buildQuoteMessage({
    quoteId: `0x${"11".repeat(32)}`, payer: PAYER, voter: VOTER, attentionAmount: "1000000",
    gavelFeeAmount: "250000", submissionHash: `0x${"22".repeat(32)}`, token: TOKEN,
    expiry: "1789344600", quoteVersion: "1",
  });
  const signature = await signer.signQuote(message);
  assert.equal(calls, 1);
  assert.equal(signer.address, wallet.address);
  assert.equal(verifyQuoteSignature(
    createQuoteTypedData(message, { chainId: 8453, verifyingContract: SPLITTER }), signature, wallet.address), true);
  assert.equal(keccak256(toUtf8Bytes(JSON.stringify(signer))).length, 66);
});

test("the public receipt is read through the public projection reader, never the private store", async () => {
  const gate = await harness();
  const reads = [];

  // The Postgres store deliberately exposes no getSubmission: the coarse public
  // projection is served by the least-privilege gate_public reader instead.
  const privateOnlyStore = new Proxy(gate.store, {
    get(target, property) {
      if (property === "getSubmission") return undefined;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, property) { return property !== "getSubmission" && Reflect.has(target, property); },
  });
  const publicReader = {
    async getSubmission(publicId) {
      reads.push(publicId);
      return gate.store.getSubmission(publicId);
    },
    getOwnedResume: (input) => gate.store.getOwnedResume(input),
  };

  const { createQuoteSigner } = loadSigner();
  const { createSubmissionService } = loadService();
  const service = createSubmissionService({
    store: privateOnlyStore,
    publicReader,
    indexClient: { async getProposalSnapshot(proposalId) {
      return {
        dao: "nouns", proposalId: String(proposalId), nativeState: "ACTIVE", eligibility: "VOTING",
        mappingVersion: "nouns-lifecycle/1", refreshedAt: new Date(gate.state.now.getTime() - 60_000).toISOString(),
        sourceBlock: "100", sourceBlockHash: BLOCK_HASH, contentHash: CONTENT_HASH, canonicalActions: [],
      };
    } },
    quoteSigner: createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }),
    deployment: { id: "deployment-1", chainId: 8453, splitter: SPLITTER, token: TOKEN, codeHash: DEPLOYMENT_CODE_HASH },
    basePayerCodeReader: async () => "0x",
    clock: () => new Date(gate.state.now),
  });

  const result = await service.createSubmission({
    session: session(), voterWallet: VOTER, request: submissionBody(),
  });
  assert.equal(result.state, "payment_required");
  assert.deepEqual(await service.getPublicStatus(result.publicId), {
    publicId: result.publicId, state: "payment_required", updatedAt: new Date(START),
  });
  assert.deepEqual(reads, [result.publicId, result.publicId]);
});

test("an unexpected store failure is never dressed up as a public receipt state", async () => {
  const gate = await harness();
  const { createQuoteSigner } = loadSigner();
  const { createSubmissionService } = loadService();
  const service = createSubmissionService({
    store: {
      getProfileByWallet: (wallet) => gate.store.getProfileByWallet(wallet),
      getPolicy: (id, dao) => gate.store.getPolicy(id, dao),
      getSubmission: (publicId) => gate.store.getSubmission(publicId),
      getOwnedResume: (input) => gate.store.getOwnedResume(input),
      async getOwnedSubmissionByHash() { return null; },
      async issue() { throw new Error("relation gate.quotes does not exist"); },
    },
    indexClient: { async getProposalSnapshot(proposalId) {
      return {
        dao: "nouns", proposalId: String(proposalId), nativeState: "ACTIVE", eligibility: "VOTING",
        mappingVersion: "nouns-lifecycle/1", refreshedAt: new Date(gate.state.now.getTime() - 60_000).toISOString(),
        sourceBlock: "100", sourceBlockHash: BLOCK_HASH, contentHash: CONTENT_HASH, canonicalActions: [],
      };
    } },
    quoteSigner: createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }),
    deployment: { id: "deployment-1", chainId: 8453, splitter: SPLITTER, token: TOKEN, codeHash: DEPLOYMENT_CODE_HASH },
    basePayerCodeReader: async () => "0x",
    clock: () => new Date(gate.state.now),
  });

  const error = await rejection(service.createSubmission({
    session: session(), voterWallet: VOTER, request: submissionBody(),
  }));
  assert.equal(error.state, undefined, "an internal failure is not a public receipt state");
  assert.equal(error.statusCode, undefined);
});

// --- G5-1: owner-bound duplicate recovery precedes every mutable check -------

test("an identical retry recovers the frozen duplicate receipt after the Gate is paused", async () => {
  const gate = await harness();
  const first = await gate.submit();

  await gate.store.mutateProfile({ profile: { id: "profile-1", wallet: VOTER, availability: "paused" } });

  const retry = await gate.submit();
  assert.deepEqual(retry, {
    state: "duplicate",
    existing: {
      publicId: first.publicId,
      state: "payment_required",
      resumeUrl: `/v1/submissions/${first.publicId}/resume`,
    },
  });
  assert.equal((await gate.store.counts()).submissions, 1);
  assert.equal((await gate.store.counts()).quotes, 1);
  assert.equal((await gate.store.counts()).reservations, 1);
});

test("an identical retry recovers the duplicate receipt without a healthy canonical index", async () => {
  const gate = await harness();
  const first = await gate.submit();
  gate.indexSource.healthy = false;

  const retry = await gate.submit();
  assert.equal(retry.state, "duplicate");
  assert.equal(retry.existing.publicId, first.publicId);
  assert.equal(gate.state.issued.length, 1, "a recovered duplicate never re-enters store issuance");
});

test("a duplicate retry is recovered before the payer EOA proof and the sender rate limit", async () => {
  const contractLater = await harness();
  const first = await contractLater.submit();
  contractLater.state.payerCode = "0x60006000";
  const afterCode = await contractLater.submit();
  assert.equal(afterCode.state, "duplicate");
  assert.equal(afterCode.existing.publicId, first.publicId);

  const limited = await harness();
  const original = await limited.submit();
  limited.state.rateLimited = true;
  const afterLimit = await limited.submit();
  assert.equal(afterLimit.state, "duplicate");
  assert.equal(afterLimit.existing.publicId, original.publicId);
});

test("a duplicate retry refreshes nothing: same quote, same signature, same expiry, one reservation", async () => {
  const gate = await harness();
  const first = await gate.submit();
  const before = await gate.store.getOwnedResume({ publicId: first.publicId, payer: PAYER });

  gate.advance(60_000);
  const retry = await gate.submit();
  assert.equal(retry.state, "duplicate");

  const after = await gate.store.getOwnedResume({ publicId: first.publicId, payer: PAYER });
  assert.deepEqual(after, before);
  assert.equal(after.quote.signature, first.quote.signature);
  assert.deepEqual(after.quote.message, first.quote.message);
  assert.equal(await gate.store.countLiabilities("profile-1"), 1000000n);
  assert.deepEqual(await gate.store.counts(), {
    snapshots: 1, submissions: 1, quotes: 1, reservations: 1, inboxItems: 0, notifications: 0, monitors: 0,
  });
});

test("a different sender cannot discover or recover another sender's submission by hash", async () => {
  const gate = await harness();
  const first = await gate.submit();
  const [issued] = gate.state.issued;

  // The payer is inside the frozen hash preimage, so another wallet cannot
  // naturally reach this hash; a deliberate direct-store probe fails closed.
  await assert.rejects(
    gate.store.getOwnedSubmissionByHash({ submissionHash: issued.submission.submissionHash, payer: payerAt(0x99) }),
    /unavailable/i,
  );
  assert.equal(
    await gate.store.getOwnedSubmissionByHash({ submissionHash: `0x${"09".repeat(32)}`, payer: PAYER }),
    null,
  );
  assert.deepEqual(
    await gate.store.getOwnedSubmissionByHash({ submissionHash: issued.submission.submissionHash, payer: PAYER }),
    { publicId: first.publicId, state: "payment_required" },
  );

  // The coarse service response for a collision reveals neither owner nor state.
  const { createQuoteSigner } = loadSigner();
  const { createSubmissionService } = loadService();
  const colliding = createSubmissionService({
    store: {
      getProfileByWallet: (wallet) => gate.store.getProfileByWallet(wallet),
      getPolicy: (id, dao) => gate.store.getPolicy(id, dao),
      getSubmission: (id) => gate.store.getSubmission(id),
      getOwnedResume: (input) => gate.store.getOwnedResume(input),
      async getOwnedSubmissionByHash() { throw new Error("submission is unavailable"); },
      async issue() { throw new Error("issue must never be reached after a collision"); },
    },
    indexClient: { async getProposalSnapshot() { throw new Error("index must never be reached"); } },
    quoteSigner: createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }),
    deployment: { id: "deployment-1", chainId: 8453, splitter: SPLITTER, token: TOKEN, codeHash: DEPLOYMENT_CODE_HASH },
    basePayerCodeReader: async () => { throw new Error("payer code must never be read after a collision"); },
    clock: () => new Date(gate.state.now),
  });
  const collided = await rejection(colliding.createSubmission({
    session: session(payerAt(0x99)), voterWallet: VOTER, request: submissionBody(),
  }));
  assert.equal(collided.state, "rejected_by_policy");
  assert.equal(collided.code, "NOT_ACCEPTING");
  assert.equal(`${collided.message}`.includes(first.publicId), false);
});

// --- G5-2: the frozen owner-bound resume endpoint ----------------------------

test("resume returns the original persisted quote byte-for-byte, never a refreshed one", async () => {
  const gate = await harness();
  const first = await gate.submit();

  gate.advance(120_000);
  const resumed = await gate.service.resumeSubmission({ session: session(), publicId: first.publicId });

  assert.deepEqual(Object.keys(resumed).sort(), ["publicId", "quote", "state", "updatedAt"]);
  assert.equal(resumed.state, "payment_required");
  assert.equal(resumed.publicId, first.publicId);
  assert.deepEqual(resumed.quote, first.quote);
  assert.equal(resumed.quote.signature, first.quote.signature);
  assert.equal(resumed.quote.message.expiry, first.quote.message.expiry);

  // Repeated resume is idempotent and still creates nothing.
  const again = await gate.service.resumeSubmission({ session: session(), publicId: first.publicId });
  assert.deepEqual(again, resumed);
  assert.deepEqual(await gate.store.counts(), {
    snapshots: 1, submissions: 1, quotes: 1, reservations: 1, inboxItems: 0, notifications: 0, monitors: 0,
  });
});

test("resume is the recovery path for a lost 201 response", async () => {
  const gate = await harness();
  const created = await gate.submit();

  // The advocate never saw the response; an identical retry hands back the
  // opaque resume path, and resume returns the original payment payload.
  const duplicate = await gate.submit();
  assert.equal(duplicate.existing.resumeUrl, `/v1/submissions/${created.publicId}/resume`);

  const recovered = await gate.service.resumeSubmission({
    session: session(), publicId: duplicate.existing.publicId,
  });
  assert.deepEqual(recovered.quote, created.quote);
  assert.equal(gate.state.issued.length, 1);
});

test("resume discloses nothing to a wallet that does not own the submission", async () => {
  const gate = await harness();
  const first = await gate.submit();

  assert.equal(await gate.service.resumeSubmission({
    session: session(payerAt(0x88)), publicId: first.publicId,
  }), null);
  assert.equal(await gate.service.resumeSubmission({ session: session(), publicId: "AAAAAAAAAAAAAAAAAAAAAA" }), null);
  assert.equal(await gate.service.resumeSubmission({ session: session(), publicId: "not-a-public-id" }), null);

  const wrongRole = await rejection(gate.service.resumeSubmission({
    session: { ...session(), role: "dao_profile" }, publicId: first.publicId,
  }));
  assert.equal(wrongRole.statusCode, 401);
  const noSession = await rejection(gate.service.resumeSubmission({ session: null, publicId: first.publicId }));
  assert.equal(noSession.statusCode, 401);
});

test("resume stops returning a payment payload once the quote expires", async () => {
  const gate = await harness();
  const first = await gate.submit();

  gate.advance(10 * 60 * 1000);
  const expired = await gate.service.resumeSubmission({ session: session(), publicId: first.publicId });
  assert.equal(expired.state, "expired");
  assert.equal(Object.hasOwn(expired, "quote"), false);

  // Wall-clock expiry alone must not release the reservation.
  assert.equal(await gate.store.countLiabilities("profile-1"), 1000000n);
  await gate.store.markExpired();
  const swept = await gate.service.resumeSubmission({ session: session(), publicId: first.publicId });
  assert.equal(swept.state, "expired");
  assert.equal(Object.hasOwn(swept, "quote"), false);
});

test("a resumed pending or accepted submission returns only its coarse state", async () => {
  const gate = await harness();
  const first = await gate.submit();

  gate.advance(60_000);
  await gate.store.markSettlementPending(first.publicId);
  const pending = await gate.service.resumeSubmission({ session: session(), publicId: first.publicId });
  assert.deepEqual(pending, {
    publicId: first.publicId, state: "pending_settlement", updatedAt: new Date(START.getTime() + 60_000),
  });

  const serialized = JSON.stringify(pending).toLowerCase();
  for (const secret of ["signature", "quoteid", "capacity", "reservation", "notification", "destination",
    "snapshot", "nonce", "voter", "attention"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
