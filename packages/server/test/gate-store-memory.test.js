const assert = require("node:assert/strict");
const test = require("node:test");

const { Wallet } = require("ethers");
const { MemoryGateStore } = require("../src/gate/store-memory");
const { createQuoteSigner } = require("../src/gate/quote-signer");
const { defineGateStoreConformance } = require("./support/gate-store-conformance");

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
const hex32 = (number) => `0x${number.toString(16).padStart(64, "0")}`;
const addr = (number) => `0x${number.toString(16).padStart(40, "0")}`;
const bytes = (hex) => Buffer.from(hex, "hex");
const SIGNER_KEY = `0x${"7".repeat(64)}`;
const SIGNER_ADDRESS = new Wallet(SIGNER_KEY).address;
const gateSigner = () => createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: ADDR.splitter });

async function setupStore(options = {}) {
  const store = new MemoryGateStore({ clock: () => new Date("2026-01-01T00:00:00.000Z"), ...options });
  await Promise.all([
    store.mutateProfile({ profile: { id: "profile-1", wallet: ADDR.wallet1, availability: "accepting_now" }, policy: {
      dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: [],
    } }),
    store.mutateProfile({ profile: { id: "profile-2", wallet: ADDR.wallet2, availability: "accepting_now" }, policy: {
      dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: [],
    } }),
  ]);
  await store.configureDeployment({
    id: "deployment-1", chainId: "8453", splitter: ADDR.splitter, signer: ADDR.signer,
    token: ADDR.token, gavelRecipient: ADDR.payer2, contractCodeHash: hash("e"), deploymentBlock: "0", nextBlock: "0", config: {}, rpcAccess: {}, issuanceActive: true,
  });
  return store;
}

function issuance(suffix, { profileId = "profile-1", voter = ADDR.wallet1, payer = ADDR.payer1,
  submissionHash = hash("a"), quoteId = hash("b"), internalQuoteId = `quote-internal-${suffix}` } = {}) {
  return {
    context: {
      authPassed: true, parsePassed: true, expectedProfileVersion: "1", walletKind: "eoa",
      authenticatedSender: payer, payerIsEoa: true, payerWalletKind: "eoa",
      basePayoutCodeHash: null, stage: "VOTING", deploymentCodeHash: hash("e"),
    },
    snapshot: {
      id: `snapshot-${suffix}`, dao: "nouns", proposalId: "7", contentHash: hash("c"),
      nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1", sourceBlock: "100",
      sourceBlockHash: hash("d"), refreshedAt: new Date("2026-01-01T00:00:00.000Z"),
      canonicalFacts: { title: "Vote" }, decodedFacts: {}, canonicalActions: [],
    },
    submission: {
      id: `submission-${suffix}`, submissionHash, profileId, payer, signedSender: payer,
      material: { vote: "for" },
    },
    quote: {
      id: internalQuoteId, quoteId, payer, voter, attentionAmount: "1000000",
      feeAmount: "250000", token: ADDR.token, baseChainId: "8453", splitter: ADDR.splitter,
      deploymentId: "deployment-1", quoteVersion: 1,
    },
    reservation: { id: `reservation-${suffix}`, profileId, amount: "1000000" },
    signer: gateSigner(),
  };
}

test("issuance requires authenticated parsed EOA context and rejects stale profile context", async () => {
  const store = await setupStore();
  const missing = issuance("missing-context", { quoteId: hash("0") });
  delete missing.context;
  await assert.rejects(store.issue(missing), /authenticated and parsed issuance context/);

  const contractPayer = issuance("contract-payer", { quoteId: hash("1") });
  contractPayer.context.payerIsEoa = false;
  contractPayer.context.payerWalletKind = "contract";
  await assert.rejects(store.issue(contractPayer), /EOA payer/);

  const wrongSession = issuance("wrong-session", { quoteId: hash("3") });
  wrongSession.context.authenticatedSender = ADDR.payer2;
  await assert.rejects(store.issue(wrongSession), /authenticated signed sender/);

  const stale = issuance("stale-context", { quoteId: hash("2") });
  stale.context.expectedProfileVersion = "2";
  await assert.rejects(store.issue(stale), /issuance context changed/);
  assert.equal((await store.counts()).submissions, 0);
});

test("contract voters require persisted Base payout evidence before accepting or issuance", async () => {
  const store = new MemoryGateStore({ clock: () => new Date("2026-01-01T00:00:00.000Z") });
  await assert.rejects(store.mutateProfile({
    profile: { id: "contract", wallet: ADDR.wallet1, walletKind: "contract", availability: "accepting_now" },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: [] },
  }), /Base payout evidence/);
  assert.equal(await store.getProfile("contract"), null);
});

test("contract wallet kind cannot be omitted to bypass fresh payout evidence on an accepting transition", async () => {
  const store = new MemoryGateStore({ clock: () => new Date("2026-01-01T00:00:00.000Z") });
  await store.mutateProfile({
    profile: {
      id: "contract", wallet: ADDR.wallet1, walletKind: "contract", availability: "paused",
      basePayoutCodeHash: hash("f"), basePayoutVerifiedAt: new Date("2025-12-31T23:59:00.000Z"),
    },
  });

  await assert.rejects(store.mutateProfile({
    profile: { id: "contract", wallet: ADDR.wallet1, availability: "accepting_now" },
  }), /fresh Base payout evidence/);
  assert.equal((await store.getProfile("contract")).walletKind, "contract");
});

test("public IDs retry collisions and every API result is detached from internal state", async () => {
  const outputs = [
    bytes("00000000000000000000000000000000"),
    bytes("00000000000000000000000000000000"),
    bytes("ffffffffffffffffffffffffffffffff"),
  ];
  const idStore = new MemoryGateStore({ randomBytes: (size) => {
    assert.equal(size, 16);
    return outputs.shift();
  }});
  const [first, second] = await Promise.all([idStore.allocatePublicId(), idStore.allocatePublicId()]);
  assert.deepEqual([first, second], ["AAAAAAAAAAAAAAAAAAAAAA", "_____________________w"]);

  const exhausted = new MemoryGateStore({ randomBytes: () => bytes("00000000000000000000000000000000") });
  await exhausted.allocatePublicId();
  await assert.rejects(exhausted.allocatePublicId(), /public id allocation unavailable/);

  const store = await setupStore();
  const input = issuance("detached", { quoteId: hash("A"), submissionHash: hash("B") });
  input.snapshot.contentHash = hash("C");
  const issued = await store.issue(input);
  input.submission.material.vote = "against";
  issued.quote.payer = ADDR.wallet2;
  assert.deepEqual(issued.submission, {
    id: "submission-detached", publicId: issued.publicId, status: "QUOTED",
  });
  const profile = await store.getProfile("profile-1");
  profile.display.changed = true;
  assert.deepEqual((await store.getProfile("profile-1")).display, {});
  assert.deepEqual(await store.getSubmission(issued.publicId), {
    publicId: issued.publicId, state: "payment_required", updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  await store.settle(settlementCommand("detached", hash("A"), {
    settlement: { event: { quoteId: hash("A"), submissionHash: hash("B") } },
  }));
});

test("issuance serializes global submission-hash uniqueness across profile locks", async () => {
  const store = await setupStore();
  const sameHash = hash("e");
  const results = await Promise.allSettled([
    store.issue(issuance("one", { profileId: "profile-1", voter: ADDR.wallet1, submissionHash: sameHash, quoteId: hash("1") })),
    store.issue(issuance("two", { profileId: "profile-2", voter: ADDR.wallet2, payer: ADDR.payer2, submissionHash: sameHash, quoteId: hash("2") })),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.match(results.find(({ status }) => status === "rejected").reason.message, /submission is unavailable/);
  assert.equal((await store.counts()).submissions, 1);
});

function settlementCommand(suffix, quoteId, overrides = {}) {
  const base = {
    quoteId,
    settlement: {
      txHash: hash("8"), logIndex: 0, receiptBlock: "150", receiptBlockHash: hash("9"),
      receiptBlockTimestamp: new Date("2026-01-01T00:05:00.000Z"), settledAt: new Date("2026-01-01T00:06:00.000Z"),
      event: {
        quoteId, payer: ADDR.payer1, voter: ADDR.wallet1, attentionAmount: "1000000",
        gavelRecipient: ADDR.payer2, gavelFeeAmount: "250000", token: ADDR.token, submissionHash: hash("a"),
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
  for (const [section, patch] of Object.entries(overrides)) {
    if (section === "settlement") {
      const event = patch.event ? { ...base.settlement.event, ...patch.event } : base.settlement.event;
      const evidence = patch.evidence ? { ...base.settlement.evidence, ...patch.evidence } : base.settlement.evidence;
      Object.assign(base.settlement, patch, { event, evidence });
    } else Object.assign(base[section], patch);
  }
  return base;
}

test("a failed settlement cannot roll global maps back over another quote's concurrent commit", async () => {
  let hookCalls = 0;
  let letFirstFail;
  const firstCanFail = new Promise((resolve) => { letFirstFail = resolve; });
  const store = await setupStore({ beforeSettlementCommit: async () => {
    hookCalls += 1;
    if (hookCalls === 1) {
      await firstCanFail;
      throw new Error("injected first-quote failure");
    }
    letFirstFail();
  }});
  const quoteA = hash("3");
  const quoteB = hash("4");
  await store.issue(issuance("rollback-a", { quoteId: quoteA, internalQuoteId: quoteA, submissionHash: hash("5") }));
  await store.issue(issuance("commit-b", { payer: ADDR.payer2, quoteId: quoteB, internalQuoteId: quoteB, submissionHash: hash("6") }));

  const first = store.settle(settlementCommand("a", quoteA, {
    settlement: { txHash: hash("a"), event: { quoteId: quoteA, submissionHash: hash("5") } },
  }));
  const second = store.settle(settlementCommand("b", quoteB, {
    settlement: { txHash: hash("b"), event: { quoteId: quoteB, payer: ADDR.payer2, submissionHash: hash("6") } },
  }));
  const results = await Promise.allSettled([first, second]);

  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal((await store.counts()).inboxItems, 1);
  assert.equal((await store.counts()).monitors, 1);
});

test("profiles, policies, deployments, and issuance enforce canonical protocol identity", async (t) => {
  await t.test("uses exact addresses, stable DAO slugs, enabled policy, and active availability", async () => {
    const store = new MemoryGateStore();
    await assert.rejects(
      store.mutateProfile({ profile: { id: "bad", wallet: "0x123", availability: "accepting_now" } }),
      /wallet.*20-byte Ethereum address/,
    );
    await assert.rejects(store.mutateProfile({
      profile: { id: "bad-dao", wallet: ADDR.wallet1, availability: "accepting_now" },
      policy: { dao: "Nouns!", chainId: "1", enabled: true, acceptVoting: true, attentionAmount: "1000000" },
    }), /DAO slug/);

    const paused = await setupStore();
    await paused.mutateProfile({ profile: { id: "profile-1", wallet: ADDR.wallet1, availability: "paused" } });
    await assert.rejects(paused.issue(issuance("paused", { quoteId: hash("1") })), /issuance unavailable/);
    await paused.mutateProfile({
      profile: { id: "profile-1", wallet: ADDR.wallet1, availability: "accepting_now" },
      policy: { dao: "nouns", chainId: "1", enabled: false, acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000" },
    });
    const disabled = issuance("disabled", { quoteId: hash("2") });
    disabled.context.expectedProfileVersion = "3";
    await assert.rejects(paused.issue(disabled), /issuance unavailable/);
  });

  await t.test("allows inactive deployment history but only one active immutable identity per chain", async () => {
    const store = new MemoryGateStore();
    const deployment = {
      id: "old", chainId: "8453", splitter: ADDR.splitter, signer: ADDR.signer, token: ADDR.token,
      gavelRecipient: ADDR.payer2,
      contractCodeHash: hash("e"), deploymentBlock: "0", nextBlock: "0", config: {}, rpcAccess: {}, issuanceActive: false,
    };
    await store.configureDeployment(deployment);
    const historical = await store.configureDeployment({
      ...deployment, id: "older", splitter: ADDR.payer1, deploymentBlock: "1", nextBlock: "1",
    });
    historical.config.mutated = true;
    assert.deepEqual((await store.configureDeployment({ ...deployment, nextBlock: "2", config: { overlap: 64 } })).config, { overlap: 64 });
    await assert.rejects(store.configureDeployment({ ...deployment, splitter: ADDR.payer2 }), /immutable deployment identity/);
    await store.configureDeployment({ ...deployment, id: "active", splitter: ADDR.wallet2, issuanceActive: true });
    await assert.rejects(store.configureDeployment({ ...deployment, id: "active-2", splitter: ADDR.wallet1, issuanceActive: true }), /one active/);
  });

  await t.test("requires exact quote constants, bindings, lifecycle values, wallet voter, and bytes32 IDs", async (validationT) => {
    const cases = [
      ["quote version", { quote: { quoteVersion: 2 } }, /quote version.*1/],
      ["minimum attention", { quote: { attentionAmount: "999999" }, reservation: { amount: "999999" } }, /at least 1000000/],
      ["fixed fee", { quote: { feeAmount: "250001" } }, /fee.*250000/],
      ["wallet voter", { quote: { voter: ADDR.wallet2 } }, /issuance unavailable/],
      ["submission bytes32", { submission: { submissionHash: "not-a-hash" } }, /submissionHash.*bytes32/],
      ["quote bytes32", { quote: { quoteId: "not-a-hash" } }, /quoteId.*bytes32/],
      ["caller expiry", { reservation: { expiresAt: new Date("2026-01-01T00:09:59.000Z") } }, /store owns issuance time/],
      ["caller signature", { quote: { signature: "0xcaller-supplied" } }, /store owns signing/],
      ["snapshot lifecycle", { snapshot: { eligibility: "MAYBE" } }, /lifecycle mapping/],
    ];
    for (const [name, overrides, pattern] of cases) {
      await validationT.test(name, async () => {
        const store = await setupStore();
        const input = issuance(name.replaceAll(" ", "-"), { quoteId: hash("1") });
        for (const [section, patch] of Object.entries(overrides)) Object.assign(input[section], patch);
        await assert.rejects(store.issue(input), pattern);
        assert.equal((await store.counts()).submissions, 0);
      });
    }
  });
});

test("all issuance identities remain globally unique across different profiles", async () => {
  for (const kind of ["snapshot", "submission", "quoteInternal", "quotePublic", "reservation"]) {
    const store = await setupStore();
    const one = issuance(`${kind}-one`, { profileId: "profile-1", voter: ADDR.wallet1, submissionHash: hash("1"), quoteId: hash("2") });
    const two = issuance(`${kind}-two`, { profileId: "profile-2", voter: ADDR.wallet2, payer: ADDR.payer2, submissionHash: hash("3"), quoteId: hash("4") });
    if (kind === "snapshot") two.snapshot.id = one.snapshot.id;
    if (kind === "submission") two.submission.id = one.submission.id;
    if (kind === "quoteInternal") two.quote.id = one.quote.id;
    if (kind === "quotePublic") two.quote.quoteId = one.quote.quoteId;
    if (kind === "reservation") two.reservation.id = one.reservation.id;
    const results = await Promise.allSettled([store.issue(one), store.issue(two)]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1, kind);
    assert.equal(results.filter(({ status }) => status === "rejected").length, 1, kind);
  }
});

test("settlement resolves public quoteId, verifies every event binding and scanner proof, and is strictly idempotent", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const publicQuoteId = hash("2");
  await store.issue(issuance("public-lookup", { quoteId: publicQuoteId }));
  now = new Date("2026-01-01T00:06:00.000Z");
  const command = settlementCommand("public", publicQuoteId);
  const variants = [
    ["quoteId", hash("1")], ["payer", ADDR.payer2], ["voter", ADDR.wallet2],
    ["attentionAmount", "1000001"], ["gavelFeeAmount", "249999"], ["token", ADDR.wallet2],
    ["submissionHash", hash("1")],
  ];
  for (const [field, value] of variants) {
    const bad = structuredClone(command);
    bad.settlement.event[field] = value;
    await assert.rejects(store.settle(bad), new RegExp(field));
  }
  for (const field of ["oneConfirmation", "canonical", "scannerVerified"]) {
    const bad = structuredClone(command);
    bad.settlement.evidence[field] = false;
    await assert.rejects(store.settle(bad), /scanner evidence/);
  }
  const badDepth = structuredClone(command);
  badDepth.settlement.evidence.confirmations = 2;
  await assert.rejects(store.settle(badDepth), /scanner evidence/);
  const atExpiry = structuredClone(command);
  atExpiry.settlement.receiptBlockTimestamp = new Date("2026-01-01T00:10:00.000Z");
  await assert.rejects(store.settle(atExpiry), /strictly before quote expiry/);

  const accepted = await store.settle(command);
  assert.deepEqual(accepted, { settled: true, inboxCreatedAt: new Date("2026-01-01T00:06:00.000Z") });
  accepted.inboxCreatedAt.setUTCFullYear(1999);
  assert.equal(await store.settle(structuredClone(command)), false);
  const dynamicReplay = structuredClone(command);
  dynamicReplay.settlement.settledAt = new Date("2026-01-01T00:07:00.000Z");
  dynamicReplay.inbox.currentLifecycle = "CLOSED";
  dynamicReplay.inbox.lifecycleChanged = true;
  assert.equal(await store.settle(dynamicReplay), false);
  const conflict = structuredClone(command);
  conflict.settlement.txHash = hash("f");
  await assert.rejects(store.settle(conflict), /conflicting settlement evidence/);
});

test("PR6 memory store persists owner-bound settlement hints and exposes only private settlement material", async () => {
  let now = new Date("2026-01-01T00:01:00.000Z");
  const store = await setupStore({ clock: () => now });
  const quoteId = hash("2");
  const issued = await store.issue(issuance("pr6-hint", { quoteId, submissionHash: hash("3") }));
  assert.equal(await store.recordSettlementHint({ publicId: issued.publicId, payer: ADDR.payer2,
    txHash: hash("8"), chainId: "8453", splitter: ADDR.splitter }), null);
  const hint = await store.recordSettlementHint({ publicId: issued.publicId, payer: ADDR.payer1,
    txHash: hash("8"), chainId: "8453", splitter: ADDR.splitter });
  assert.deepEqual(hint, { publicId: issued.publicId, state: "pending_settlement", updatedAt: now });
  assert.deepEqual(await store.listPendingSettlementHints({ limit: 10 }), [{
    publicId: issued.publicId, quoteId, txHash: hash("8"), expiresAt: issued.quote.expiresAt,
  }]);
  const privateQuote = await store.findSettlementQuote(quoteId);
  assert.deepEqual(Object.keys(privateQuote).sort(), ["attentionAmount", "baseChainId", "dao", "destinationRef",
    "expiresAt", "feeAmount", "gavelRecipient", "issuanceLifecycle", "payer", "proposalId", "quoteId",
    "quoteVersion", "splitter", "submissionHash", "token", "trustedSummary", "voter"].sort());
  assert.deepEqual(privateQuote.trustedSummary,
    { subject: "Paid pitch ready", text: "Open your private Gate inbox." });
  assert.equal(privateQuote.destinationRef, "profile:profile-1");
  now = new Date("2026-01-01T00:02:00.000Z");
  assert.equal(await store.resolveSettlementHint({ publicId: issued.publicId, txHash: hash("8"), state: "payment_required" }), true);
  assert.deepEqual(await store.listPendingSettlementHints({ limit: 10 }), []);
  assert.equal((await store.getSubmission(issued.publicId)).state, "payment_required");
  now = issued.quote.expiresAt;
  const expired = await store.recordSettlementHint({ publicId: issued.publicId, payer: ADDR.payer1,
    txHash: hash("9"), chainId: "8453", splitter: ADDR.splitter });
  assert.equal(expired.state, "expired");
  assert.equal(expired.updatedAt.toISOString(), issued.quote.expiresAt.toISOString());
  assert.equal((await store.getSubmission(issued.publicId)).state, "expired");
  assert.equal(await store.countLiabilities("profile-1"), 1000000n);
});

test("PR6 memory store recovers durable latest exact observations and owns overlap config", async () => {
  const store = await setupStore();
  const quoteId = hash("2");
  await store.issue(issuance("pr6-recovery", { quoteId }));
  const state = await store.getScannerState({ chainId: "8453", splitter: ADDR.splitter });
  assert.equal(state.overlap, 64);
  const settlement = settlementCommand("recovery", quoteId).settlement;
  settlement.receiptBlock = "0"; settlement.receiptBlockHash = hash("9");
  settlement.receiptBlockTimestamp = new Date("2026-01-01T00:00:00.000Z");
  settlement.settledAt = settlement.receiptBlockTimestamp;
  await store.recordScannerRange({ deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "0",
    canonicalBlockHash: hash("9"), canonicalBlockTimestamp: settlement.receiptBlockTimestamp,
    canonicalBlocks: [{ blockNumber: "0", blockHash: hash("9"), parentHash: hash("8"), blockTimestamp: settlement.receiptBlockTimestamp }],
    observations: [{ kind: "exact_log", quoteId, txHash: settlement.txHash, logIndex: 0, blockNumber: "0",
      blockHash: hash("9"), blockTimestamp: settlement.receiptBlockTimestamp, exactMatch: true, details: { settlement } }] });
  assert.deepEqual(await store.listUnsettledSettlementObservations({ chainId: "8453", splitter: ADDR.splitter }),
    [{ quoteId, settlement }]);
});

test("Memory deployment ignores a caller-provided later cursor and starts exactly at deployment block", async () => {
  const store = new MemoryGateStore();
  await store.configureDeployment({ id: "cursor-pin", chainId: "8453", splitter: ADDR.splitter, signer: ADDR.signer,
    token: ADDR.token, gavelRecipient: ADDR.payer2, contractCodeHash: hash("e"), deploymentBlock: "10", nextBlock: "1000",
    config: { overlap: 64 }, rpcAccess: {}, issuanceActive: true });
  assert.deepEqual(await store.getScannerState({ chainId: "8453", splitter: ADDR.splitter }), {
    deploymentId: "cursor-pin", deploymentBlock: "10", nextRangeFrom: "10", generation: "0", overlap: 64,
  });
});

test("PR6 memory scanner atomically releases expiry-pending reservations after complete no-match coverage", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const quoteId = hash("d");
  await store.issue(issuance("memory-release", { quoteId, expiresAt: new Date("2026-01-01T00:10:00.000Z") }));
  now = new Date("2026-01-01T00:11:00.000Z");
  await store.markExpired();
  const result = await store.recordScannerRange({ deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "0",
    canonicalBlockHash: hash("9"), canonicalBlockTimestamp: now,
    canonicalBlocks: [{ blockNumber: "0", blockHash: hash("9"), parentHash: hash("8"), blockTimestamp: now }],
    observations: [] });
  assert.deepEqual(result, { released: 1, reorged: 0 });
  assert.equal(await store.countLiabilities("profile-1"), 0n);
});

test("concurrent scanner generation replays ignore observer settledAt while preserving chain evidence", async () => {
  const store = await setupStore();
  const quoteId = hash("2");
  await store.issue(issuance("scanner-replay", { quoteId }));
  const settlement = settlementCommand("scanner-replay", quoteId).settlement;
  settlement.receiptBlock = "0";
  settlement.receiptBlockHash = hash("9");
  settlement.receiptBlockTimestamp = new Date("2026-01-01T00:00:00.000Z");
  const range = {
    deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "0",
    canonicalBlockHash: hash("9"), canonicalBlockTimestamp: settlement.receiptBlockTimestamp,
    canonicalBlocks: [{ blockNumber: "0", blockHash: hash("9"), parentHash: hash("8"), blockTimestamp: settlement.receiptBlockTimestamp }],
    observations: [{ kind: "exact_log", quoteId, txHash: settlement.txHash, logIndex: 0, blockNumber: "0",
      blockHash: hash("9"), blockTimestamp: settlement.receiptBlockTimestamp, exactMatch: true, details: { settlement } }],
  };
  const replay = structuredClone(range);
  replay.observations[0].details.settlement.settledAt = new Date("2026-01-01T00:09:00.000Z");

  assert.deepEqual(await Promise.all([store.recordScannerRange(range), store.recordScannerRange(replay)]),
    [{ released: 0, reorged: 0 }, { released: 0, reorged: 0 }]);
  const [durable] = await store.listUnsettledSettlementObservations({ chainId: "8453", splitter: ADDR.splitter });
  assert.deepEqual(durable.settlement.settledAt, settlement.receiptBlockTimestamp);
});

test("PR6 memory scanner rejects inconsistent canonical parent evidence", async () => {
  const store = await setupStore();
  await assert.rejects(store.recordScannerRange({
    deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "1",
    canonicalBlockHash: hash("9"), canonicalBlockTimestamp: new Date("2026-01-01T00:00:00.000Z"),
    canonicalBlocks: [
      { blockNumber: "0", blockHash: hash("8"), parentHash: hash("7"), blockTimestamp: new Date("2026-01-01T00:00:00.000Z") },
      { blockNumber: "1", blockHash: hash("9"), parentHash: hash("6"), blockTimestamp: new Date("2026-01-01T00:00:00.000Z") },
    ],
    observations: [],
  }), /parent.*canonical|ancestry/i);
});

test("PR6 memory worker claims only due monitors, advances schedule durably, and fences stale owners", async () => {
  let now = new Date("2026-01-01T00:06:00.000Z");
  const store = await setupStore({ clock: () => now });
  const quoteId = hash("4");
  await store.issue(issuance("pr6-worker", { quoteId, submissionHash: hash("5") }));
  const command = settlementCommand("pr6-worker", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("5") } },
  });
  await store.settle(command);
  assert.deepEqual(await store.claimSettlementMonitors({ chainId: "8453", splitter: ADDR.splitter, headBlock: "150", limit: 5 }), []);
  const monitors = await store.claimSettlementMonitors({ chainId: "8453", splitter: ADDR.splitter, headBlock: "151", limit: 5 });
  assert.equal(monitors.length, 1);
  assert.equal(monitors[0].id, "monitor-pr6-worker");
  assert.equal(monitors[0].claimToken, "1");
  now = new Date(now.valueOf() + 31_000);
  assert.equal(await store.advanceSettlementMonitor({ id: monitors[0].id, claimToken: "9", progressBlock: "151",
    nextCheckBlock: "152", completed: false, reorged: false }), false);
  assert.equal(await store.advanceSettlementMonitor({ id: monitors[0].id, claimToken: monitors[0].claimToken, progressBlock: "151",
    nextCheckBlock: "152", completed: false, reorged: false }), true);
  assert.deepEqual(await store.claimSettlementMonitors({ chainId: "8453", splitter: ADDR.splitter, headBlock: "151", limit: 5 }), []);
  const final = await store.claimSettlementMonitors({ chainId: "8453", splitter: ADDR.splitter, headBlock: "152", limit: 5 });
  assert.equal(await store.advanceSettlementMonitor({ id: final[0].id, claimToken: final[0].claimToken, progressBlock: "152",
    nextCheckBlock: null, completed: true, reorged: false }), true);
  assert.deepEqual(await store.claimSettlementMonitors({ chainId: "8453", splitter: ADDR.splitter, headBlock: "999", limit: 5 }), []);
  const jobs = await store.claimNotificationAttempts({ limit: 5, now });
  assert.deepEqual(jobs, [{ id: "notification-pr6-worker", claimToken: "1", retryCount: 0, destinationRef: "vault:ciphertext",
    summary: { subject: "Paid pitch ready", text: "Open your private Gate inbox." } }]);
  assert.deepEqual(await store.claimNotificationAttempts({ limit: 5, now }), []);
  const retryAt = new Date("2026-01-01T00:07:00.000Z");
  await store.failNotification({ id: jobs[0].id, claimToken: jobs[0].claimToken, errorCode: "TEMP", nextAttemptAt: retryAt });
  assert.deepEqual(await store.claimNotificationAttempts({ limit: 5, now }), []);
  now = retryAt;
  const retry = await store.claimNotificationAttempts({ limit: 5, now });
  assert.equal(retry[0].retryCount, 1);
  assert.equal(retry[0].claimToken, "2");
  await store.completeNotification({ id: retry[0].id, claimToken: retry[0].claimToken, providerOpaqueId: "provider-1" });
  assert.deepEqual(await store.claimNotificationAttempts({ limit: 5, now }), []);
  assert.equal((await store.counts()).notifications, 1);
});

test("notification completions require the current unexpired claim and retries return to pending", async () => {
  let now = new Date("2026-01-01T00:06:00.000Z");
  const store = await setupStore({ clock: () => now });
  const quoteId = hash("6");
  await store.issue(issuance("claim-owner", { quoteId, submissionHash: hash("7") }));
  await store.settle(settlementCommand("claim-owner", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("7") } },
  }));
  const first = (await store.claimNotificationAttempts({ now }))[0];
  now = new Date("2026-01-01T00:06:31.000Z");
  const second = (await store.claimNotificationAttempts({ now }))[0];
  assert.notEqual(second.claimToken, first.claimToken);
  assert.equal(await store.completeNotification({ id: first.id, claimToken: first.claimToken, providerOpaqueId: "stale" }), false);
  assert.equal(await store.failNotification({ id: first.id, claimToken: first.claimToken, errorCode: "STALE",
    nextAttemptAt: new Date("2026-01-01T00:07:00.000Z") }), false);
  assert.equal(await store.failNotification({ id: second.id, claimToken: second.claimToken, errorCode: "TEMP",
    nextAttemptAt: new Date("2026-01-01T00:07:00.000Z") }), true);
  now = new Date("2026-01-01T00:07:00.000Z");
  const retry = (await store.claimNotificationAttempts({ now }))[0];
  assert.equal(await store.completeNotification({ id: retry.id, claimToken: retry.claimToken, providerOpaqueId: "sent" }), true);
});

test("expiry updates public submission state and release requires cursor-authorized complete canonical coverage", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const publicQuoteId = hash("7");
  const issued = await store.issue(issuance("expiry", { quoteId: publicQuoteId, expiresAt: new Date("2026-01-01T00:10:00.000Z") }));
  await store.configureDeployment({
    id: "deployment-1", chainId: "8453", splitter: ADDR.splitter, signer: ADDR.signer,
    token: ADDR.token, gavelRecipient: ADDR.payer2, contractCodeHash: hash("e"), deploymentBlock: "0", nextBlock: "2", config: { overlap: 64 }, rpcAccess: {}, issuanceActive: true,
  });
  now = new Date("2026-01-01T00:10:01.000Z");
  assert.equal(await store.markExpired(now), 1);
  assert.equal((await store.getSubmission(issued.publicId)).state, "expired");
  assert.equal(await store.countLiabilities("profile-1"), 1000000n, "expiry alone must retain the pending liability");

  const evidence = {
    deploymentId: "deployment-1", chainId: "8453", splitter: ADDR.splitter,
    cursor: { fromBlock: "0", throughBlock: "0", nextBlock: "1" },
    coverage: { rangeFrom: "0", rangeTo: "0", lastEligibleBlock: "0", canonical: true, canonicalBlockHash: hash("8") },
  };
  await assert.rejects(store.releaseReservation(publicQuoteId, "0"), /owned by recordScannerRange/);
  await assert.rejects(store.releaseReservation(publicQuoteId, evidence), /owned by recordScannerRange/);
  const releaseResult = await store.recordScannerRange({
    deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "0",
    canonicalBlockHash: hash("8"), canonicalBlockTimestamp: now,
    canonicalBlocks: [{ blockNumber: "0", blockHash: hash("8"), parentHash: hash("9"), blockTimestamp: now }],
    observations: [],
  });
  assert.deepEqual(releaseResult, { released: 1, reorged: 0 });
  assert.equal(await store.releaseReservation(publicQuoteId, evidence), false);
  assert.equal(await store.countLiabilities("profile-1"), 0n);
  assert.deepEqual(await store.settle(settlementCommand("released", publicQuoteId)), {
    settled: true, inboxCreatedAt: new Date("2026-01-01T00:10:01.000Z"),
  });
});

test("notification patches preserve omitted values and terminal states cannot regress", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const quoteId = hash("9");
  await store.issue(issuance("notification", { quoteId }));
  now = new Date("2026-01-01T00:06:00.000Z");
  await store.settle(settlementCommand("notification", quoteId));
  const provider = await store.updateNotification("notification-notification", { providerOpaqueId: "provider-1" });
  assert.equal(provider.status, "pending");
  assert.equal(provider.errorCode, undefined);
  const sent = await store.updateNotification("notification-notification", { status: "sent" });
  sent.providerOpaqueId = "mutated";
  await assert.rejects(store.updateNotification("notification-notification", { status: "pending" }), /terminal/);
  const unchanged = await store.updateNotification("notification-notification", { errorCode: "late-note" });
  assert.equal(unchanged.status, "sent");
  assert.equal(unchanged.providerOpaqueId, "provider-1");
  await assert.rejects(store.updateNotification("notification-notification", { inboxId: "other" }), /immutable field/);
});

test("profile versions change exactly once per effective profile or policy mutation", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const initial = await store.getProfile("profile-1");
  assert.equal(initial.profileVersion, 1);
  now = new Date("2026-01-01T00:01:00.000Z");
  await store.mutateProfile({ profile: { id: "profile-1", wallet: ADDR.wallet1, availability: "accepting_now" } });
  assert.equal((await store.getProfile("profile-1")).profileVersion, 1);
  assert.deepEqual((await store.getProfile("profile-1")).updatedAt, initial.updatedAt);
  await store.mutateProfile({ profile: { id: "profile-1", wallet: ADDR.wallet1 }, policy: {
    tags: [], attentionAmount: "1000000", acceptVoting: true, acceptPreVote: false,
    enabled: true, chainId: "1", dao: "nouns",
  } });
  assert.equal((await store.getProfile("profile-1")).profileVersion, 1);
  assert.deepEqual((await store.getProfile("profile-1")).updatedAt, initial.updatedAt);
  await store.mutateProfile({ profile: { id: "profile-1", wallet: ADDR.wallet1, display: { ens: "voter.eth" } } });
  assert.equal((await store.getProfile("profile-1")).profileVersion, 2);
  await assert.rejects(store.mutateProfile({ profile: { id: "profile-1", wallet: ADDR.wallet1 }, policy: {
    dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: false,
    attentionAmount: "1000000", tags: [],
  } }), /VOTING/);
  assert.equal((await store.getProfile("profile-1")).profileVersion, 2);
});

test("owned exact-hash retries resume before mutable checks while cross-payer collisions fail closed", async () => {
  const store = await setupStore();
  const original = issuance("owned", { quoteId: hash("1"), submissionHash: hash("2") });
  const issued = await store.issue(original);
  await store.mutateProfile({ profile: { id: "profile-1", wallet: ADDR.wallet1, availability: "paused" } });
  const retry = issuance("retry", { quoteId: hash("3"), submissionHash: hash("2") });
  retry.context.expectedProfileVersion = "999";
  assert.deepEqual(await store.issue(retry), {
    resumed: true, publicId: issued.publicId, state: "payment_required",
  });
  const collision = issuance("collision", { payer: ADDR.payer2, quoteId: hash("4"), submissionHash: hash("2") });
  await assert.rejects(store.issue(collision), /submission is unavailable/);
  assert.equal((await store.counts()).submissions, 1);
});

test("public receipt projections have only the state-specific timestamp", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const quoteId = hash("3");
  const issued = await store.issue(issuance("projection", { quoteId, submissionHash: hash("4") }));
  assert.deepEqual(Object.keys(await store.getSubmission(issued.publicId)), ["publicId", "state", "updatedAt"]);
  now = new Date("2026-01-01T00:01:00.000Z");
  await store.markSettlementPending(issued.publicId);
  assert.deepEqual(await store.getSubmission(issued.publicId), {
    publicId: issued.publicId, state: "pending_settlement", updatedAt: now,
  });
  now = new Date("2026-01-01T00:02:00.000Z");
  const command = settlementCommand("projection", quoteId, {
    settlement: { txHash: hash("5"), event: { quoteId, submissionHash: hash("4") } },
  });
  await store.settle(command);
  assert.deepEqual(await store.getSubmission(issued.publicId), {
    publicId: issued.publicId, state: "accepted", acceptedAt: now,
  });
});

test("settlement accepts only the frozen QuoteSettled event and enqueues pending notification", async () => {
  const store = await setupStore();
  const quoteId = hash("5");
  await store.issue(issuance("event-shape", { quoteId, submissionHash: hash("6") }));
  const extra = settlementCommand("extra", quoteId, { settlement: { event: { quoteId, submissionHash: hash("6"), quoteVersion: 1 } } });
  await assert.rejects(store.settle(extra), /event must contain exactly/);
  const wrongRecipient = settlementCommand("recipient", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("6"), gavelRecipient: ADDR.wallet2 } },
  });
  await assert.rejects(store.settle(wrongRecipient), /gavelRecipient/);
  const failedJob = settlementCommand("failed-job", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("6") } }, notification: { status: "failed" },
  });
  await assert.rejects(store.settle(failedJob), /initially be pending/);
  assert.equal((await store.counts()).inboxItems, 0);
});

test("settlement lifecycle fields use one vocabulary and exact availability semantics", async () => {
  const store = await setupStore();
  const quoteId = hash("6");
  await store.issue(issuance("lifecycle", { quoteId, submissionHash: hash("7") }));
  const nativeLeak = settlementCommand("native-leak", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("7") } },
    inbox: { issuanceLifecycle: "ACTIVE", currentLifecycle: "ACTIVE" },
  });
  await assert.rejects(store.settle(nativeLeak), /invalid inbox lifecycle/);
  const falseChange = settlementCommand("false-change", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("7") } },
    inbox: { currentLifecycle: "CLOSED", lifecycleChanged: false },
  });
  await assert.rejects(store.settle(falseChange), /lifecycle change flag/);
  const falseUnavailable = settlementCommand("false-unavailable", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("7") } },
    inbox: { currentLifecycle: "UNKNOWN", currentLifecycleUnavailable: false },
  });
  await assert.rejects(store.settle(falseUnavailable), /UNKNOWN lifecycle/);

  const terminalLeak = settlementCommand("terminal-leak", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("7") } },
    inbox: { currentLifecycle: "SUCCEEDED", lifecycleChanged: true },
  });
  await assert.rejects(store.settle(terminalLeak), /invalid inbox lifecycle/);
});

test("quote expiry is exactly ten minutes from the authoritative store clock", async () => {
  let now = new Date("2026-01-01T00:00:00.123Z");
  const store = await setupStore({ clock: () => now });

  // The store reads its own clock and truncates to the whole second the signed
  // EIP-712 expiry uses. A caller supplies no instant at all, so wall-clock
  // movement between service entry and issuance cannot be rejected as drift.
  const first = await store.issue(issuance("exact-expiry", { quoteId: hash("d"), submissionHash: hash("e") }));
  assert.deepEqual(first.quote.expiresAt, new Date("2026-01-01T00:10:00.000Z"));
  assert.equal(first.quote.message.expiry, "1767226200");

  now = new Date("2026-01-01T00:00:37.999Z");
  const later = await store.issue(issuance("later-expiry", {
    payer: ADDR.payer2, quoteId: hash("f"), submissionHash: hash("0"),
  }));
  assert.deepEqual(later.quote.expiresAt, new Date("2026-01-01T00:10:37.000Z"));
  assert.equal(later.quote.message.expiry, "1767226237");
  assert.equal((await store.counts()).submissions, 2);
});

test("pending settlement is a reversible public hint while a quote remains valid", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const input = issuance("pending-reversible", { quoteId: hash("c"), submissionHash: hash("d") });
  const issued = await store.issue(input);

  now = new Date("2026-01-01T00:01:00.000Z");
  assert.equal(await store.markSettlementPending(issued.publicId), true);
  assert.equal((await store.getSubmission(issued.publicId)).state, "pending_settlement");
  assert.equal(await store.markSettlementPending(issued.publicId), false);

  now = new Date("2026-01-01T00:02:00.000Z");
  assert.equal(await store.markSettlementPending(issued.publicId, false), true);
  assert.deepEqual(await store.getSubmission(issued.publicId), {
    publicId: issued.publicId, state: "payment_required", updatedAt: now,
  });
  assert.equal(await store.markSettlementPending(issued.publicId, false), false);

  now = new Date("2026-01-01T00:10:00.000Z");
  await assert.rejects(store.markSettlementPending(issued.publicId), /while quote is valid/);
});

test("owned duplicate resume reports the exact current public state", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const original = issuance("resume-state", { quoteId: hash("a"), submissionHash: hash("b") });
  const issued = await store.issue(original);
  await store.markSettlementPending(issued.publicId);

  const retry = issuance("resume-state-retry", { quoteId: hash("c"), submissionHash: hash("b") });
  assert.deepEqual(await store.issue(retry), {
    resumed: true, publicId: issued.publicId, state: "pending_settlement",
  });
  await store.markSettlementPending(issued.publicId, false);
  assert.equal((await store.issue(retry)).state, "payment_required");

  now = new Date("2026-01-01T00:10:00.000Z");
  await store.markExpired();
  assert.equal((await store.issue(retry)).state, "expired");
});

test("failed notifications retry only through pending and stop at the configured bound", async () => {
  const store = await setupStore({ notificationRetryLimit: 1 });
  const quoteId = hash("7");
  await store.issue(issuance("retry-job", { quoteId, submissionHash: hash("8") }));
  await store.settle(settlementCommand("retry-job", quoteId, {
    settlement: { event: { quoteId, submissionHash: hash("8") } },
  }));
  await store.updateNotification("notification-retry-job", { status: "failed", errorCode: "timeout" });
  await assert.rejects(store.updateNotification("notification-retry-job", { status: "sent" }), /return to pending/);
  const retried = await store.updateNotification("notification-retry-job", { status: "pending" });
  assert.equal(retried.retryCount, 1);
  assert.equal(retried.errorCode, "timeout");
  await store.updateNotification("notification-retry-job", { status: "failed" });
  await assert.rejects(store.updateNotification("notification-retry-job", { status: "pending" }), /retry limit/);
});

test("pending reservation capacity is 12 count-based liabilities", async () => {
  const store = await setupStore();
  assert.equal(await store.isProfileAccepting("profile-1", "nouns"), true);
  for (let index = 1; index <= 12; index += 1) {
    await store.issue(issuance(`pending-${index}`, {
      payer: addr(100 + index), quoteId: hex32(1000 + index), submissionHash: hex32(2000 + index),
    }));
  }
  await assert.rejects(store.issue(issuance("pending-13", {
    payer: addr(113), quoteId: hex32(1013), submissionHash: hex32(2013),
  })), /capacity unavailable/);
  assert.equal(await store.isProfileAccepting("profile-1", "nouns"), false);
  assert.equal((await store.counts()).submissions, 12);
});

test("memory policies enforce the shared pending-to-settled relationship and issuance uses persisted count caps", async () => {
  const store = new MemoryGateStore({ clock: () => new Date("2026-01-01T00:00:00.000Z") });
  const profile = { id: "profile-1", wallet: ADDR.wallet1, availability: "accepting_now" };
  const policy = { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
    attentionAmount: "1000000", pendingReservationCapacity: 2, settledCapacity: 4, tags: [] };
  await store.mutateProfile({ profile, policy });
  assert.deepEqual(await store.getPolicy("profile-1", "nouns"), { ...policy, profileId: "profile-1" });
  for (const [pendingReservationCapacity, settledCapacity] of [[13, 25], [25, 25]]) {
    await assert.rejects(store.mutateProfile({ profile, policy: { ...policy, pendingReservationCapacity, settledCapacity } }), /maximum.*12|at most.*half/i);
  }
  await store.configureDeployment({
    id: "deployment-1", chainId: "8453", splitter: ADDR.splitter, signer: ADDR.signer,
    token: ADDR.token, gavelRecipient: ADDR.payer2, contractCodeHash: hash("e"), deploymentBlock: "0", nextBlock: "0", config: {}, rpcAccess: {}, issuanceActive: true,
  });
  await store.issue(issuance("persisted-cap-1", { payer: addr(701), quoteId: hex32(701), submissionHash: hex32(801) }));
  await store.issue(issuance("persisted-cap-2", { payer: addr(702), quoteId: hex32(702), submissionHash: hex32(802) }));
  await assert.rejects(store.issue(issuance("persisted-cap-3", {
    payer: addr(703), quoteId: hex32(703), submissionHash: hex32(803),
  })), /capacity unavailable/);
});

test("settled capacity is 25 in a rolling 24-hour window", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  for (let index = 1; index <= 25; index += 1) {
    const payer = addr(200 + index);
    const quoteId = hex32(3000 + index);
    const submissionHash = hex32(4000 + index);
    await store.issue(issuance(`settled-${index}`, { payer, quoteId, submissionHash }));
    await store.settle(settlementCommand(`settled-${index}`, quoteId, {
      settlement: { txHash: hex32(5000 + index), event: { quoteId, payer, submissionHash } },
    }));
  }
  await assert.rejects(store.issue(issuance("settled-26", {
    payer: addr(226), quoteId: hex32(3026), submissionHash: hex32(4026),
  })), /capacity unavailable/);

  now = new Date("2026-01-02T00:00:01.000Z");
  const afterWindow = issuance("after-window", {
    payer: addr(227), quoteId: hex32(3027), submissionHash: hex32(4027), expiresAt: new Date("2026-01-02T00:10:01.000Z"),
  });
  assert.equal((await store.issue(afterWindow)).resumed, false);
});

test("late canonical settlement consumes a released reservation, creates overage, and keeps issuance blocked", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ clock: () => now });
  const lateQuoteId = hex32(9000);
  const lateHash = hex32(9001);
  const late = await store.issue(issuance("late-overage", {
    payer: addr(900), quoteId: lateQuoteId, submissionHash: lateHash,
  }));
  now = new Date("2026-01-01T00:11:00.000Z");
  await store.markExpired(now);
  await store.recordScannerRange({
    deploymentId: "deployment-1", generation: "1", fromBlock: "0", throughBlock: "0",
    canonicalBlockHash: hex32(9002), canonicalBlockTimestamp: now,
    canonicalBlocks: [{ blockNumber: "0", blockHash: hex32(9002), parentHash: hex32(9003), blockTimestamp: now }],
    observations: [],
  });

  for (let index = 1; index <= 25; index += 1) {
    const payer = addr(900 + index);
    const quoteId = hex32(9100 + index);
    const submissionHash = hex32(9200 + index);
    await store.issue(issuance(`overage-${index}`, {
      payer, quoteId, submissionHash, expiresAt: new Date("2026-01-01T00:21:00.000Z"),
    }));
    await store.settle(settlementCommand(`overage-${index}`, quoteId, {
      settlement: { txHash: hex32(9300 + index), event: { quoteId, payer, submissionHash } },
    }));
  }

  assert.deepEqual(await store.settle(settlementCommand("late-overage", lateQuoteId, {
    settlement: { txHash: hex32(9400), event: { quoteId: lateQuoteId, payer: addr(900), submissionHash: lateHash } },
  })), { settled: true, inboxCreatedAt: now });
  assert.deepEqual(await store.getSubmission(late.publicId), { publicId: late.publicId, state: "accepted", acceptedAt: now });
  assert.equal((await store.counts()).inboxItems, 26);
  await assert.rejects(store.issue(issuance("blocked-overage", {
    payer: addr(999), quoteId: hex32(9500), submissionHash: hex32(9501), expiresAt: new Date("2026-01-01T00:21:00.000Z"),
  })), /capacity unavailable/);
});

defineGateStoreConformance("MemoryGateStore", async (suffix, options = {}) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = await setupStore({ ...options, clock: () => now });
  const quoteId = hash("a");
  const submissionHash = hash("b");
  const input = issuance(`conformance-${suffix}`, { quoteId, submissionHash });
  const issued = await store.issue(input);
  const notificationId = `notification-conformance-${suffix}`;
  return {
    store,
    issued,
    issuedAt: new Date(now),
    publicId: issued.publicId,
    notificationId,
    setNow(value) { now = value; },
    resume() {
      return store.issue(issuance(`conformance-${suffix}-retry`, { quoteId: hash("c"), submissionHash }));
    },
    settle(inbox = {}) {
      return store.settle(settlementCommand(`conformance-${suffix}`, quoteId, {
        settlement: { event: { quoteId, submissionHash } },
        inbox,
      }));
    },
  };
});
