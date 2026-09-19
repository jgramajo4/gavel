const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Wallet } = require("ethers");
const { PostgresGateStore, createPublicGateReader } = require("../src/gate/store");
const { createQuoteSigner } = require("../src/gate/quote-signer");

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const CANONICAL_BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const H = (digit) => `0x${digit.repeat(64)}`;

function noConnectStore() {
  return new PostgresGateStore({ pool: {
    connect: async () => { throw new Error("validation reached the database"); },
    query: async () => { throw new Error("validation reached the database"); },
  }});
}

const SIGNER_KEY = `0x${"7".repeat(64)}`;
const gateSigner = (splitter = A, chainId = 8453) => createQuoteSigner({ signer: SIGNER_KEY, chainId, splitter });

function issuanceCommand() {
  return {
    signer: gateSigner(),
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: A,
      expectedProfileVersion: "1", walletKind: "eoa", stage: "VOTING", deploymentCodeHash: H("1") },
    snapshot: { id: "s", dao: "nouns", proposalId: "1", contentHash: H("2"), nativeState: "ACTIVE",
      eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: H("3"),
      refreshedAt: new Date(), canonicalFacts: {}, decodedFacts: {}, canonicalActions: [] },
    submission: { id: "sub", submissionHash: H("4"), profileId: "p", payer: A, signedSender: A, material: {} },
    quote: { id: "q", quoteId: H("5"), payer: A, voter: A, attentionAmount: "1000000", feeAmount: "250000",
      token: CANONICAL_BASE_USDC, baseChainId: "8453", splitter: A, deploymentId: "d", quoteVersion: 1 },
    reservation: { id: "r", profileId: "p", amount: "1000000" },
    signer: gateSigner(),
  };
}

function issuanceClient(deployment) {
  return { async query(sql) {
    sql = String(sql);
    if (/FROM gate\.submissions WHERE submission_hash/.test(sql)) return { rows: [] };
    if (/gate\.lock_issuance_profile_policy/.test(sql)) return { rows: [{ wallet: A, walletKind: "eoa", availability: "accepting_now",
      profileVersion: "1", enabled: true, chainId: "1", attentionAmount: "1000000", acceptPreVote: false,
      acceptVoting: true, pendingReservationCapacity: 12, settledCapacity: 25 }] };
    if (/FROM gate\.splitter_deployments/.test(sql)) return { rows: [deployment] };
    if (/interval '600 seconds'/.test(sql)) return { rows: [{ now: new Date(0), expiresAt: new Date(600_000) }] };
    if (/AS pending_count/.test(sql)) return { rows: [{ pending_count: 0, settled_count: 0, pair_proposal: 0, active_pair: 0 }] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
}

const productionDeployment = (overrides = {}) => ({
  issuance_active: true, chain_id: "8453", splitter: A, token: CANONICAL_BASE_USDC,
  contract_code_hash: H("1"), config: { environment: "production" }, ...overrides,
});

test("Postgres store rejects non-canonical protocol primitives before SQL", async () => {
  const store = noConnectStore();
  await assert.rejects(store.mutateProfile({ profile: { id: "p", wallet: "0xabc" } }), /wallet.*0x.*40/i);
  await assert.rejects(store.mutateProfile({
    profile: { id: "p", wallet: A },
    policy: { dao: A, chainId: "1", enabled: true, acceptPreVote: true, acceptVoting: true, attentionAmount: "1000000" },
  }), /dao.*slug/i);
  await assert.rejects(store.issue({
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: A,
      expectedProfileVersion: "1", walletKind: "eoa", stage: "VOTING", deploymentCodeHash: `0x${"1".repeat(64)}` },
    snapshot: { dao: "nouns", proposalId: "1", contentHash: "bad" },
    submission: { payer: A, signedSender: A }, quote: { payer: A }, reservation: {},
  }), /bytes32|snapshot|hash/i);
  await assert.rejects(store.mutateProfile({
    profile: { id: "p", wallet: A },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: false, attentionAmount: "1000000" },
  }), /VOTING/i);
  await assert.rejects(store.mutateProfile({
    profile: { id: "p", wallet: A },
    policy: { dao: "nouns", chainId: "1", enabled: "yes", acceptPreVote: true, acceptVoting: true, attentionAmount: "1000000" },
  }), /enabled.*boolean/i);
  await assert.rejects(store.mutateProfile({
    profile: { id: "p", wallet: A },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "2000000", pendingReservationCapacity: 0, settledCapacity: 25 },
  }), /pending.*positive/i);
  await assert.rejects(store.mutateProfile({ profile: { id: "p", wallet: A,
    display: { message: { session: "private" } } } }), /display\.message/);
  for (const [pendingReservationCapacity, settledCapacity] of [[13, 25], [25, 25]]) {
    await assert.rejects(store.mutateProfile({
      profile: { id: "p", wallet: A },
      policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
        attentionAmount: "1000000", pendingReservationCapacity, settledCapacity },
    }), /maximum.*12|at most.*half/i);
  }
});

test("Postgres Candidate issuance rejects proposal target and AGAINST material before SQL", async () => {
  const command = issuanceCommand();
  command.context.stage = "PRE_VOTE";
  command.snapshot.kind = "candidate";
  command.snapshot.targetId = `candidate:${A}:${H("9")}`;
  delete command.snapshot.proposalId;
  command.snapshot.eligibility = "PRE_VOTE";
  command.snapshot.mappingVersion = "nouns-candidate-lifecycle/1";
  command.submission.material = { targetId: "proposal:999", stage: "PRE_VOTE", position: "AGAINST" };

  await assert.rejects(noConnectStore().issue(command), /Candidate submission material/i);
});

test("Postgres issuance rejects sparse or non-canonical action collections before SQL", async () => {
  const invalidActions = [
    new Array(1),
    [{ actionIndex: 1, target: A, valueWei: "0", signature: "", calldata: "0x" }],
    [{ actionIndex: 0, target: A, valueWei: "00", signature: "", calldata: "0x" }],
    [{ actionIndex: 0, target: A, valueWei: "0", signature: "", calldata: "0x", extra: true }],
  ];
  for (const canonicalActions of invalidActions) {
    const command = issuanceCommand();
    command.snapshot.canonicalActions = canonicalActions;
    await assert.rejects(noConnectStore().issue(command), /canonicalActions/i);
  }
});

test("Postgres issuance compares counts with the persisted policy capacities selected under lock", async () => {
  const calls = [];
  const client = { async query(sql) {
    sql = String(sql); calls.push(sql);
    if (/FROM gate\.submissions WHERE submission_hash/.test(sql)) return { rows: [] };
    if (/gate\.lock_issuance_profile_policy/.test(sql)) return { rows: [{ wallet: A, walletKind: "eoa", availability: "accepting_now",
      profileVersion: "1", enabled: true, chainId: "1", attentionAmount: "1000000", acceptPreVote: false,
      acceptVoting: true, pendingReservationCapacity: 2, settledCapacity: 4 }] };
    if (/FROM gate\.splitter_deployments/.test(sql)) return { rows: [productionDeployment()] };
    if (/interval '600 seconds'/.test(sql)) return { rows: [{ now: new Date(0), expiresAt: new Date(600_000) }] };
    if (/AS pending_count/.test(sql)) return { rows: [{ pending_count: 2, settled_count: 0, pair_proposal: 0, active_pair: 0 }] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client }, quoteSigner: async () => "signed" });
  await assert.rejects(store.issue(issuanceCommand()), /capacity unavailable/);
  assert.match(calls.find((sql) => /gate\.lock_issuance_profile_policy/.test(sql)), /lock_issuance_profile_policy/);
});

test("Postgres issuance accepts an explicit canonical production deployment", async () => {
  const client = issuanceClient(productionDeployment());
  const issued = await new PostgresGateStore({ pool: { connect: async () => client } }).issue(issuanceCommand());
  assert.equal(issued.quote.domain.chainId, 8453);
  assert.equal(issued.quote.message.token.toLowerCase(), CANONICAL_BASE_USDC);
});

test("Postgres issuance accepts an explicitly labeled Base Sepolia test deployment", async () => {
  const client = issuanceClient({ issuance_active: true, chain_id: "84532", splitter: A, token: B,
    contract_code_hash: H("1"), config: { environment: "test", testTokenLabel: "base-sepolia-eip3009-test-token" } });
  const command = issuanceCommand();
  command.quote.baseChainId = "84532";
  command.quote.token = B;
  command.signer = gateSigner(A, 84532);
  const issued = await new PostgresGateStore({ pool: { connect: async () => client } }).issue(command);
  assert.equal(issued.quote.domain.chainId, 84532);
  assert.equal(issued.quote.message.token.toLowerCase(), B);
});

test("Postgres issuance rejects a deployment whose explicit environment mismatches its chain", async () => {
  const client = issuanceClient({ issuance_active: true, chain_id: "84532", splitter: A, token: B,
    contract_code_hash: H("1"), config: { environment: "production" } });
  const command = issuanceCommand();
  command.quote.baseChainId = "84532";
  command.quote.token = B;
  command.signer = gateSigner(A, 84532);
  await assert.rejects(new PostgresGateStore({ pool: { connect: async () => client } }).issue(command),
    /deployment environment/i);
});

test("Postgres issuance rejects closed deployment environment and token invariants", async () => {
  const cases = [
    ["8453/test", { chain_id: "8453", token: B, config: { environment: "test", testTokenLabel: "test-token" } }, { token: B }],
    ["84532/production", { chain_id: "84532", token: B, config: { environment: "production" } }, { baseChainId: "84532", token: B }],
    ["production wrong token", { token: B }, { token: B }],
    ["test unlabeled", { chain_id: "84532", token: B, config: { environment: "test" } }, { baseChainId: "84532", token: B }],
    ["missing config", { config: undefined }],
  ];
  for (const [name, deploymentPatch, quotePatch] of cases) {
    const deployment = productionDeployment(deploymentPatch);
    const command = issuanceCommand();
    Object.assign(command.quote, quotePatch);
    if (command.quote.baseChainId === "84532") command.signer = gateSigner(A, 84532);
    await assert.rejects(new PostgresGateStore({ pool: { connect: async () => issuanceClient(deployment) } }).issue(command),
      /deployment environment/i, name);
  }
});

test("Postgres issuance rejects unknown chains and deployment tuple mismatches", async () => {
  const unknown = issuanceCommand();
  unknown.quote.baseChainId = "1";
  await assert.rejects(new PostgresGateStore({ pool: { connect: async () => issuanceClient(productionDeployment()) } }).issue(unknown),
    /Base 8453 or Base Sepolia 84532/i);

  for (const deploymentPatch of [{ chain_id: "84532" }, { splitter: B }, { contract_code_hash: H("2") }]) {
    await assert.rejects(new PostgresGateStore({ pool: { connect: async () => issuanceClient(productionDeployment(deploymentPatch)) } })
      .issue(issuanceCommand()), /issuance context changed/i);
  }
});

test("Postgres issuance and settlement reject stale or incomplete evidence before SQL", async () => {
  const store = noConnectStore();
  const future = new Date(Date.now() + 60_000);
  const command = {
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: A,
      expectedProfileVersion: "1", walletKind: "eoa", basePayoutCodeHash: null,
      stage: "VOTING", deploymentCodeHash: `0x${"1".repeat(64)}` },
    snapshot: { id: "s", dao: "nouns", proposalId: "1", contentHash: `0x${"2".repeat(64)}`,
      mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: `0x${"3".repeat(64)}`, canonicalActions: [] },
    submission: { id: "sub", submissionHash: `0x${"4".repeat(64)}`, profileId: "p", payer: A, signedSender: A },
    quote: { id: "q", quoteId: `0x${"5".repeat(64)}`, payer: A, voter: A, attentionAmount: "1000000",
      feeAmount: "250000", token: A, baseChainId: "1", splitter: A, quoteVersion: 1 },
    reservation: { id: "r", profileId: "p", amount: "1000000" },
  };
  const signer = gateSigner();
  const payerKindUnknown = { ...structuredClone(command), signer };
  delete payerKindUnknown.context.payerIsEoa;
  await assert.rejects(store.issue(payerKindUnknown), /payer.*EOA/i);
  const senderUnknown = { ...structuredClone(command), signer };
  delete senderUnknown.context.authenticatedSender;
  await assert.rejects(store.issue(senderUnknown), /authenticatedSender/i);
  await assert.rejects(store.settle({
    quoteId: command.quote.quoteId,
    settlement: { txHash: command.snapshot.contentHash },
    inbox: {}, notification: {}, monitor: {},
  }), /exact settlement event.*scanner evidence/i);
  await assert.rejects(store.releaseReservation(command.quote.quoteId, {}), /deploymentId/i);
});

test("profile mutation preserves omitted wallet kind and marks unauthoritative downgrades for SQL rejection under lock", async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    if (/FROM gate\.mutate_profile/.test(sql)) return { rows: [{ id: "p", wallet: A, walletKind: "contract" }] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  await store.mutateProfile({ profile: { id: "p", wallet: A } });
  const omitted = calls.find((call) => /FROM gate\.mutate_profile/.test(call.sql));
  assert.equal(omitted.values[2], null);
  assert.ok(calls.findIndex((call) => /pg_advisory_xact_lock/.test(call.sql)) < calls.indexOf(omitted));
  assert.deepEqual(calls.find((call) => /pg_advisory_xact_lock/.test(call.sql)).values, ["gate:profile:p"]);

  calls.length = 0;
  await store.mutateProfile({ profile: { id: "p", wallet: A, walletKind: "eoa" } });
  const downgrade = calls.find((call) => /FROM gate\.mutate_profile/.test(call.sql));
  assert.equal(downgrade.values[2], "eoa");
  assert.equal(downgrade.values[11], false);
});

test("Postgres profile transaction writes delivery settings only through a parameterized least-privilege function", async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    if (/FROM gate\.profiles WHERE wallet/.test(sql)) return { rows: [{ id: "p", wallet: A }] };
    if (/gate\.set_delivery_setting/.test(sql)) return { rows: [{ set_delivery_setting: null }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  const envelope = "gg1.primary.AAAAAAAAAAAAAAAA.ciphertext.AAAAAAAAAAAAAAAAAAAAAA";
  await store.withProfileTransaction(A, async (transaction) => {
    await transaction.setDeliverySetting("p", envelope);
  });
  const write = calls.find((call) => /gate\.set_delivery_setting/.test(call.sql));
  assert.deepEqual(write.values, ["p", A, envelope]);
  assert.doesNotMatch(write.sql, /INSERT INTO|UPDATE gate\.delivery_settings/i);
});

test("settlement quote SQL returns bound profile identity and never synthesizes a plaintext fallback", async () => {
  const calls = [];
  const store = new PostgresGateStore({ pool: { async query(sql, values) { calls.push({ sql: String(sql), values }); return { rows: [] }; } } });
  assert.equal(await store.findSettlementQuote(H("1")), null);
  assert.match(calls[0].sql, /s\.profile_id AS "profileId"/i);
  assert.match(calls[0].sql, /ds\.ciphertext AS "destinationRef"/i);
  assert.doesNotMatch(calls[0].sql, /COALESCE|profile:/i);
});

test("profile listing enforces a bounded stable SQL page", async () => {
  const calls = [];
  const store = new PostgresGateStore({ pool: { async query(sql, values) { calls.push({ sql: String(sql), values }); return { rows: [] }; } } });
  await store.listProfiles({ dao: "nouns", availability: "accepting_now", limit: 50, offset: 0 });
  assert.match(calls[0].sql, /ORDER BY p\.updated_at DESC,p\.id ASC\s+LIMIT \$3 OFFSET \$4/i);
  assert.deepEqual(calls[0].values, ["nouns", "accepting_now", 50, 0]);
  await assert.rejects(store.listProfiles({ limit: 51 }), /limit/);
});

test("public profile capacity lookup returns only a coarse availability boolean", async () => {
  const calls = [];
  const store = new PostgresGateStore({ pool: { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    return { rows: [{ available: false }] };
  } } });
  assert.equal(await store.isProfileAccepting("profile-1", "nouns"), false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ["profile-1", "nouns"]);
  assert.match(calls[0].sql, /pending_reservation_capacity/);
  assert.match(calls[0].sql, /settled_capacity/);
  assert.match(calls[0].sql, /interval '24 hours'/);
});

test("issuance uses independent DAO/Base chains, exact database-clock lifetime, locked Base code verification, and in-transaction signing", async () => {
  const calls = [];
  const databaseNow = new Date("2026-01-01T00:00:00.000Z");
  const trustedExpiry = new Date("2026-01-01T00:10:00.000Z");
  const callerExpiry = new Date("2099-01-01T00:00:00.000Z");
  const code = "0x6001600055";
  const { keccak256 } = require("ethers");
  const client = {
    async query(sql, values) {
      sql = String(sql); calls.push({ sql, values });
      if (/FROM gate\.submissions WHERE submission_hash/.test(sql)) return { rows: [] };
      if (/gate\.lock_issuance_profile_policy/.test(sql)) return { rows: [{ wallet: A, walletKind: "contract", availability: "accepting_now",
        profileVersion: "7", basePayoutCodeHash: keccak256(code), enabled: true, chainId: "1", attentionAmount: "1000000",
        acceptPreVote: false, acceptVoting: true, pendingReservationCapacity: 12, settledCapacity: 25 }] };
      if (/FROM gate\.splitter_deployments/.test(sql)) return { rows: [productionDeployment()] };
      if (/interval '600 seconds'/.test(sql)) return { rows: [{ now: databaseNow, expiresAt: trustedExpiry }] };
      if (/AS pending_count/.test(sql)) return { rows: [{ pending_count: 0, settled_count: 0, pair_proposal: 0, active_pair: 0 }] };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const signerCalls = [];
  const { Wallet } = require("ethers");
  const signingWallet = new Wallet(`0x${"7".repeat(64)}`);
  const signer = Object.freeze({
    address: signingWallet.address,
    domain: { name: "GavelGateSplitter", version: "1", chainId: 8453, verifyingContract: A },
    async signQuote(message) {
      signerCalls.push(structuredClone(message));
      calls.push({ sql: "SIGN" });
      const { createQuoteTypedData } = require("@gavel/gate");
      const typed = createQuoteTypedData(message, { chainId: 8453, verifyingContract: A });
      return signingWallet.signTypedData(typed.domain, typed.types, typed.message);
    },
  });
  const store = new PostgresGateStore({
    pool: { connect: async () => client },
    baseCodeReader: async ({ wallet, chainId }) => { calls.push({ sql: "ETH_GET_CODE", wallet, chainId }); return code; },
  });
  const command = {
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: B, expectedProfileVersion: "7", walletKind: "contract", stage: "VOTING", deploymentCodeHash: H("1") },
    snapshot: { id: "snap", dao: "nouns", proposalId: "1", contentHash: H("2"), nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: H("3"), refreshedAt: new Date(), canonicalFacts: {}, decodedFacts: {}, canonicalActions: [] },
    submission: { id: "sub", submissionHash: H("4"), profileId: "p", payer: B, signedSender: B, material: {} },
    quote: { id: "q", quoteId: H("5"), payer: B, voter: A, attentionAmount: "1000000", feeAmount: "250000", token: CANONICAL_BASE_USDC, baseChainId: "8453", splitter: A, deploymentId: "d", quoteVersion: 1 },
    reservation: { id: "r", profileId: "p", amount: "1000000" },
  };
  const issued = await store.issue({ ...command, signer });
  assert.equal(issued.quote.expiresAt.valueOf(), trustedExpiry.valueOf());
  assert.equal(signerCalls.length, 1);
  assert.equal(signerCalls[0].expiry, String(Math.floor(trustedExpiry.valueOf() / 1000)));
  assert.equal(signerCalls[0].submissionHash, H("4"));
  assert.equal(Object.hasOwn(signerCalls[0], "signature"), false);
  assert.deepEqual(issued.quote.message, signerCalls[0]);
  const quoteInsert = calls.find((x) => /INSERT INTO gate\.quotes/.test(x.sql));
  assert.equal(quoteInsert.values.at(-1), issued.quote.signature);
  assert.equal(quoteInsert.values.at(-2).valueOf(), trustedExpiry.valueOf());
  assert.equal(calls.find((x) => /INSERT INTO gate\.capacity_reservations/.test(x.sql)).values.at(-1).valueOf(), trustedExpiry.valueOf());
  assert.ok(calls.findIndex((x) => /pg_advisory_xact_lock/.test(x.sql)) < calls.findIndex((x) => x.sql === "ETH_GET_CODE"));
  // Signing happens before either row is written, and the signature is part of
  // the quote INSERT rather than a later UPDATE.
  assert.ok(calls.findIndex((x) => x.sql === "SIGN") < calls.findIndex((x) => /INSERT INTO gate\.quotes/.test(x.sql)));
  assert.ok(calls.findIndex((x) => /INSERT INTO gate\.quotes/.test(x.sql))
    < calls.findIndex((x) => /INSERT INTO gate\.capacity_reservations/.test(x.sql)));
  assert.equal(calls.some((x) => /UPDATE gate\.quotes SET quote_signature/.test(x.sql)), false);

  await assert.rejects(store.issue(structuredClone(command)), /signer/i);
  const callerSigned = { ...structuredClone(command), signer };
  callerSigned.quote.signature = "0xcaller-supplied";
  await assert.rejects(store.issue(callerSigned), /store owns signing/i);
  const callerExpired = { ...structuredClone(command), signer };
  callerExpired.quote.expiresAt = callerExpiry;
  await assert.rejects(store.issue(callerExpired), /store owns issuance time/i);

  const preVote = { ...structuredClone(command), signer }; preVote.context.stage = "PRE_VOTE";
  await assert.rejects(store.issue(preVote), /Nouns.*VOTING/i);
  const ethereumSettlement = { ...structuredClone(command), signer }; ethereumSettlement.quote.baseChainId = "1";
  await assert.rejects(store.issue(ethereumSettlement), /Base 8453/i);
  const contractPayer = { ...structuredClone(command), signer }; contractPayer.context.payerIsEoa = false;
  await assert.rejects(store.issue(contractPayer), /payer.*EOA/i);
});

test("owner-bound hash lookup and resume disclose nothing to a non-owner and refresh nothing", async () => {
  const expiresAt = new Date("2026-01-01T00:10:00.000Z");
  const rows = {
    hash: [{ publicId: "PPPPPPPPPPPPPPPPPPPPPP", status: "QUOTED", payer: A }],
    resume: [{
      publicId: "PPPPPPPPPPPPPPPPPPPPPP", status: "QUOTED", payer: A, submissionHash: H("4"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"), inboxCreatedAt: null, quoteId: H("5"), voter: B,
      attentionAmount: "1000000", feeAmount: "250000", token: A, baseChainId: "8453", splitter: A,
      expiresAt, signature: "0xsigned", quoteState: "quoted", now: new Date("2026-01-01T00:05:00.000Z"),
    }],
  };
  const statements = [];
  const store = new PostgresGateStore({ pool: { async query(sql, values) {
    const text = String(sql);
    statements.push(text);
    if (/FROM gate\.submissions WHERE submission_hash/.test(text)) return { rows: rows.hash };
    return { rows: rows.resume };
  } } });

  assert.deepEqual(await store.getOwnedSubmissionByHash({ submissionHash: H("4"), payer: A }),
    { publicId: "PPPPPPPPPPPPPPPPPPPPPP", state: "payment_required" });
  await assert.rejects(store.getOwnedSubmissionByHash({ submissionHash: H("4"), payer: B }), /unavailable/i);
  rows.hash = [];
  assert.equal(await store.getOwnedSubmissionByHash({ submissionHash: H("4"), payer: A }), null);

  const resumed = await store.getOwnedResume({ publicId: "PPPPPPPPPPPPPPPPPPPPPP", payer: A });
  assert.equal(resumed.state, "payment_required");
  assert.equal(resumed.quote.signature, "0xsigned");
  assert.equal(resumed.quote.message.expiry, String(expiresAt.valueOf() / 1000));
  assert.equal(resumed.quote.totalAmount, "1250000");
  assert.equal(await store.getOwnedResume({ publicId: "PPPPPPPPPPPPPPPPPPPPPP", payer: B }), null);

  // Past its expiry the same row resumes to a coarse expired state, and every
  // statement issued was a read.
  rows.resume[0].now = new Date("2026-01-01T00:10:00.000Z");
  const expired = await store.getOwnedResume({ publicId: "PPPPPPPPPPPPPPPPPPPPPP", payer: A });
  assert.equal(expired.state, "expired");
  assert.equal(Object.hasOwn(expired, "quote"), false);
  assert.equal(statements.every((text) => /^\s*SELECT/i.test(text)), true);
});

test("expired settlement hints atomically persist and return the coarse expired projection", async () => {
  const updatedAt = new Date("2026-01-01T00:10:00.000Z");
  const statements = [];
  const client = { async query(sql) {
    statements.push(String(sql));
    if (/FROM gate\.submissions s JOIN gate\.quotes/.test(String(sql))) return { rows: [{
      id: "sub", publicId: "A".repeat(22), status: "QUOTED", payer: A, quoteInternalId: "quote",
      quote_state: "quoted", unexpired: false, baseChainId: "8453", splitter: A,
    }] };
    if (/RETURNING public_state_changed_at AS "updatedAt"/.test(String(sql))) return { rows: [{ updatedAt }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  assert.deepEqual(await store.recordSettlementHint({ publicId: "A".repeat(22), payer: A,
    txHash: H("1"), chainId: "8453", splitter: A }), {
    publicId: "A".repeat(22), state: "expired", updatedAt,
  });
  assert.equal(statements.some((sql) => /capacity_reservations SET state='expiry_pending_reconciliation'/.test(sql)), true);
});

test("settlement accepts exactly the frozen eight event fields and notification starts pending", async () => {
  const store = noConnectStore();
  const base = {
    quoteId: H("1"), settlement: { txHash: H("2"), logIndex: 0, receiptBlock: "2", receiptBlockHash: H("3"), receiptBlockTimestamp: new Date(), settledAt: new Date(),
      event: { quoteId: H("1"), payer: A, voter: A, attentionAmount: "1000000", gavelRecipient: B, gavelFeeAmount: "250000", token: A, submissionHash: H("4") },
      evidence: { chainId: "8453", splitter: A, canonical: true, scannerVerified: true, oneConfirmation: true, confirmations: 1 } },
    inbox: { id: "i", issuanceLifecycle: "VOTING", currentLifecycle: "VOTING", lifecycleChanged: false, currentLifecycleUnavailable: false },
    notification: { id: "n", channel: "email", destinationRef: "cipher", status: "pending" }, monitor: { id: "m", nextCheckBlock: "3" },
  };
  for (const mutate of [
    (x) => { delete x.settlement.event.gavelRecipient; },
    (x) => { x.settlement.event.quoteVersion = 1; },
  ]) {
    const invalid = structuredClone(base); mutate(invalid);
    await assert.rejects(store.settle(invalid), /exactly|pending/i);
  }
});

test("PostgreSQL settlement isolates optional notification failures behind a savepoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/gate/store.js"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  assert.match(source, /SAVEPOINT optional_notification[\s\S]*ROLLBACK TO SAVEPOINT optional_notification/);
  assert.match(migration, /qstate='settled'[\s\S]*notice_count NOT BETWEEN 0 AND 1/);
});

test("issuance and inbox lifecycles enforce canonical ACTIVE to VOTING and exact unavailable/change semantics", async () => {
  const store = noConnectStore();
  const issuanceClient = { async query(sql) {
    if (/FROM gate\.submissions WHERE submission_hash/.test(String(sql))) return { rows: [] };
    if (["BEGIN", "ROLLBACK"].includes(String(sql))) return { rows: [], rowCount: 1 };
    throw new Error("fresh issuance lifecycle validation ran too late");
  }, release() {} };
  const issuanceStore = new PostgresGateStore({ pool: { connect: async () => issuanceClient } });
  const future = new Date(Date.now() + 60_000);
  const issuance = {
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: A,
      expectedProfileVersion: "1", walletKind: "eoa", stage: "VOTING", deploymentCodeHash: H("1") },
    snapshot: { id: "s", dao: "nouns", proposalId: "1", contentHash: H("2"), nativeState: "ACTIVE", eligibility: "VOTING",
      mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: H("3"), canonicalActions: [] },
    submission: { id: "sub", submissionHash: H("4"), profileId: "p", payer: A, signedSender: A },
    quote: { id: "q", quoteId: H("5"), payer: A, voter: A, attentionAmount: "1000000", feeAmount: "250000",
      token: A, baseChainId: "8453", splitter: A, quoteVersion: 1 },
    reservation: { id: "r", profileId: "p", amount: "1000000" },
    signer: gateSigner(),
  };
  for (const patch of [{ nativeState: "1" }, { nativeState: 1 }, { nativeState: "SUCCEEDED" }, { eligibility: "CLOSED" }]) {
    await assert.rejects(issuanceStore.issue({ ...issuance, snapshot: { ...issuance.snapshot, ...patch } }), /ACTIVE.*VOTING/i);
  }

  const base = {
    quoteId: H("1"), settlement: { txHash: H("2"), logIndex: 0, receiptBlock: "2", receiptBlockHash: H("3"), receiptBlockTimestamp: new Date(), settledAt: new Date(),
      event: { quoteId: H("1"), payer: A, voter: A, attentionAmount: "1000000", gavelRecipient: B, gavelFeeAmount: "250000", token: A, submissionHash: H("4") },
      evidence: { chainId: "8453", splitter: A, canonical: true, scannerVerified: true, oneConfirmation: true, confirmations: 1 } },
    inbox: { id: "i", issuanceLifecycle: "VOTING", currentLifecycle: "VOTING", lifecycleChanged: false, currentLifecycleUnavailable: false },
    notification: { id: "n", channel: "email", destinationRef: "cipher", status: "pending" }, monitor: { id: "m", nextCheckBlock: "3" },
  };
  for (const [patch, pattern] of [
    [{ issuanceLifecycle: "CLOSED" }, /issuance.*VOTING/i],
    [{ currentLifecycle: "PRE_VOTE", lifecycleChanged: true }, /current lifecycle/i],
    [{ currentLifecycle: "CLOSED", lifecycleChanged: false }, /change flag/i],
    [{ currentLifecycle: "UNKNOWN", lifecycleChanged: false, currentLifecycleUnavailable: false }, /UNKNOWN.*unavailable/i],
    [{ currentLifecycle: "UNKNOWN", lifecycleChanged: true, currentLifecycleUnavailable: true }, /without a change|change flag/i],
  ]) await assert.rejects(store.settle({ ...base, inbox: { ...base.inbox, ...patch } }), pattern);
});

test("duplicates resume with the exact public state and pending settlement is a reversible hint", async () => {
  const duplicateClient = { async query(sql) {
    if (/FROM gate\.submissions WHERE submission_hash/.test(String(sql))) return { rows: [{ publicId: "opaque", status: "QUOTED", payer: A, profileId: "p" }] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => duplicateClient } });
  const future = new Date(Date.now() + 60_000);
  const resumed = await store.issue({
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: A,
      expectedProfileVersion: "1", walletKind: "eoa", stage: "VOTING", deploymentCodeHash: H("1") },
    snapshot: { id: "s", dao: "nouns", proposalId: "1", contentHash: H("2"), nativeState: "ACTIVE", eligibility: "VOTING",
      mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: H("3"), canonicalActions: [] },
    submission: { id: "sub", submissionHash: H("4"), profileId: "p", payer: A, signedSender: A },
    quote: { id: "q", quoteId: H("5"), payer: A, voter: A, attentionAmount: "1000000", feeAmount: "250000",
      token: A, baseChainId: "8453", splitter: A, quoteVersion: 1 },
    reservation: { id: "r", profileId: "p", amount: "1000000" },
    signer: gateSigner(),
  });
  assert.deepEqual(resumed, { resumed: true, publicId: "opaque", state: "payment_required" });

  duplicateClient.query = async (sql) => {
    if (/FROM gate\.submissions WHERE submission_hash/.test(String(sql))) return { rows: [{ publicId: "opaque", status: "SETTLEMENT_PENDING", payer: A, profileId: "p" }] };
    return { rows: [], rowCount: 1 };
  };
  assert.deepEqual(await store.issue({
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: A,
      expectedProfileVersion: "1", walletKind: "eoa", stage: "VOTING", deploymentCodeHash: H("1") },
    snapshot: { id: "s2", dao: "nouns", proposalId: "1", contentHash: H("2"), nativeState: "ACTIVE", eligibility: "VOTING",
      mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: H("3"), canonicalActions: [] },
    submission: { id: "sub2", submissionHash: H("4"), profileId: "p", payer: A, signedSender: A },
    quote: { id: "q2", quoteId: H("6"), payer: A, voter: A, attentionAmount: "1000000", feeAmount: "250000",
      token: A, baseChainId: "8453", splitter: A, quoteVersion: 1 },
    reservation: { id: "r2", profileId: "p", amount: "1000000" },
    signer: gateSigner(),
  }), { resumed: true, publicId: "opaque", state: "pending_settlement" });

  const calls = [];
  const pendingClient = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    if (/FOR UPDATE OF s,q/.test(String(sql))) return { rows: [{ id: "sub", status: calls.filter((call) => /UPDATE gate\.submissions/.test(call.sql)).length ? "SETTLEMENT_PENDING" : "QUOTED", quote_state: "quoted", unexpired: true }] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const pendingStore = new PostgresGateStore({ pool: { connect: async () => pendingClient } });
  assert.equal(await pendingStore.markSettlementPending("opaque"), true);
  const toPending = calls.find((call) => /UPDATE gate\.submissions/.test(call.sql));
  assert.deepEqual(toPending.values, ["sub", "SETTLEMENT_PENDING", "QUOTED"]);
  assert.equal(await pendingStore.markSettlementPending("opaque", false), true);
  const updates = calls.filter((call) => /UPDATE gate\.submissions/.test(call.sql));
  assert.deepEqual(updates[1].values, ["sub", "QUOTED", "SETTLEMENT_PENDING"]);
  await assert.rejects(pendingStore.markSettlementPending("opaque", "false"), /must be boolean/);
});

test("owned exact-hash retries resume before mutable lifecycle, index, deployment, and policy checks", async () => {
  for (const mutate of [
    (command) => { command.snapshot.nativeState = "DEFEATED"; command.snapshot.eligibility = "CLOSED"; },
    (command) => { command.snapshot.nativeState = "UNKNOWN"; command.snapshot.eligibility = "UNKNOWN"; },
    (command) => { command.context.expectedProfileVersion = "99"; command.quote.baseChainId = "1"; },
  ]) {
    const calls = [];
    const client = { async query(sql) {
      sql = String(sql); calls.push(sql);
      if (/FROM gate\.submissions WHERE submission_hash/.test(sql)) {
        return { rows: [{ publicId: "original", status: "QUOTED", payer: A, profileId: "p" }] };
      }
      if (!["BEGIN", "COMMIT"].includes(sql)) throw new Error(`mutable check reached: ${sql}`);
      return { rows: [], rowCount: 1 };
    }, release() {} };
    const command = issuanceCommand(); mutate(command);
    const store = new PostgresGateStore({ pool: { connect: async () => client } });
    assert.deepEqual(await store.issue(command), { resumed: true, publicId: "original", state: "payment_required" });
    assert.equal(calls.filter((sql) => /submission_hash/.test(sql)).length, 1);
    assert.equal(calls.some((sql) => /profiles|dao_policies|splitter_deployments|pg_advisory/.test(sql)), false);
  }
});

test("exact-hash collisions fail closed for either a different payer or a different profile owner", async () => {
  const client = { async query(sql) {
    if (/FROM gate\.submissions WHERE submission_hash/.test(String(sql))) {
      return { rows: [{ publicId: "private", status: "QUOTED", payer: A, profileId: "p" }] };
    }
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  const crossPayer = issuanceCommand();
  crossPayer.submission.payer = B; crossPayer.submission.signedSender = B;
  crossPayer.context.authenticatedSender = B; crossPayer.quote.payer = B;
  await assert.rejects(store.issue(crossPayer), /submission is unavailable/);
  const crossOwner = issuanceCommand(); crossOwner.submission.profileId = "other"; crossOwner.reservation.profileId = "other";
  await assert.rejects(store.issue(crossOwner), /submission is unavailable/);
});

test("issuance rechecks the exact hash after the profile lock and resumes the committed race winner", async () => {
  const calls = [];
  let hashLookups = 0;
  const client = { async query(sql) {
    sql = String(sql); calls.push(sql);
    if (/FROM gate\.submissions WHERE submission_hash/.test(sql)) {
      hashLookups += 1;
      return hashLookups === 1 ? { rows: [] }
        : { rows: [{ publicId: "winner", status: "QUOTED", payer: A, profileId: "p" }] };
    }
    if (/FROM gate\.profiles|FROM gate\.dao_policies|FROM gate\.splitter_deployments/.test(sql)) {
      throw new Error("mutable issuance checks ran before the race-closing duplicate lookup");
    }
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  assert.deepEqual(await store.issue(issuanceCommand()), {
    resumed: true, publicId: "winner", state: "payment_required",
  });
  assert.equal(hashLookups, 2);
  assert.ok(calls.findIndex((sql) => /pg_advisory_xact_lock/.test(sql))
    < calls.findLastIndex((sql) => /submission_hash/.test(sql)));
});

test("issuance locks the persisted profile identity when it differs from the wallet", async () => {
  const calls = [];
  let hashLookups = 0;
  const client = { async query(sql, values = []) {
    sql = String(sql); calls.push({ sql, values });
    if (/FROM gate\.submissions WHERE submission_hash/.test(sql)) {
      hashLookups += 1;
      return hashLookups === 1 ? { rows: [] } : { rows: [{ publicId: "winner", status: "QUOTED", payer: A, profileId: "p" }] };
    }
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  await store.issue(issuanceCommand());
  assert.deepEqual(calls.find(({ sql }) => /pg_advisory_xact_lock/.test(sql)).values, ["gate:profile:p"]);
});

test("notification metadata-only patches preserve omitted fields and pass a bounded retry limit", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    return { rows: [{ id: "n", inboxId: "i", channel: "email", status: "failed", providerOpaqueId: "provider-2", errorCode: "timeout", retryCount: 1 }] };
  } };
  const store = new PostgresGateStore({ pool, notificationRetryLimit: 1 });
  const row = await store.updateNotification("n", { providerOpaqueId: "provider-2" });
  assert.equal(row.retryCount, 1);
  assert.deepEqual(calls[0].values, ["n", null, "provider-2", true, null, false, 1]);
});

test("a new deployment ignores a caller-provided later cursor and starts exactly at deployment block", async () => {
  const seen = [];
  const client = { async query(sql, values) {
    seen.push({ sql: String(sql), values });
    if (/INSERT INTO gate\.splitter_deployments/.test(sql)) return { rows: [{ id: "d", deploymentBlock: "40", nextBlock: "40" }] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  const configured = await store.configureDeployment({ id: "d", chainId: "8453", splitter: A, signer: B,
    token: CANONICAL_BASE_USDC, gavelRecipient: B, deploymentBlock: "40", nextBlock: "99",
    contractCodeHash: H("1"), config: { environment: "production" }, rpcAccess: "cipher" });
  const deploymentInsert = seen.find(({ sql }) => /INSERT INTO gate\.splitter_deployments/.test(sql));
  const cursorInsert = seen.find(({ sql }) => /INSERT INTO gate\.settlement_cursors/.test(sql));
  assert.equal(deploymentInsert.values[7], "40");
  assert.equal(cursorInsert.values[4], "40");
  assert.equal(configured.nextBlock, "40");
  assert.doesNotMatch(deploymentInsert.sql, /DO UPDATE SET scanner_cursor=EXCLUDED\.scanner_cursor/);
  assert.match(deploymentInsert.sql, /config->>'environment'/);
  assert.match(deploymentInsert.sql, /config->'testTokenLabel'/);
});

test("Postgres deployment lookup returns the exact persisted registry tuple by chain and splitter", async () => {
  const calls = [];
  const persisted = { id: "d", chainId: "8453", splitter: A, signer: B, token: CANONICAL_BASE_USDC,
    gavelRecipient: B, contractCodeHash: H("1"), config: { environment: "production" }, issuanceActive: true };
  const store = new PostgresGateStore({ pool: { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    return { rows: [persisted] };
  } } });
  assert.deepEqual(await store.getDeployment({ chainId: "8453", splitter: A.toUpperCase().replace("0X", "0x") }), persisted);
  assert.deepEqual(calls[0].values, ["8453", A]);
  assert.match(calls[0].sql, /FROM gate\.splitter_deployments[\s\S]*WHERE chain_id=\$1 AND splitter=\$2/i);
});

test("Postgres deployment configuration rejects invalid inactive identity before SQL", async () => {
  let connected = false;
  const store = new PostgresGateStore({ pool: { async connect() { connected = true; throw new Error("must not connect"); } } });
  await assert.rejects(store.configureDeployment({ id: "d", chainId: "8453", splitter: A, signer: B, token: A,
    gavelRecipient: B, deploymentBlock: "0", contractCodeHash: H("1"), config: {}, rpcAccess: "cipher",
    issuanceActive: false }), /deployment environment/i);
  assert.equal(connected, false);
});

test("scanner range persistence sends complete observations in the cursor transaction", async () => {
  const seen = [];
  const client = { async query(sql, values) {
    seen.push({ sql: String(sql), values });
    if (/gate\.record_scanner_range/.test(sql)) return { rows: [{ released: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  const result = await store.recordScannerRange({ deploymentId: "d", generation: "1", fromBlock: "40", throughBlock: "41",
    canonicalBlockHash: H("2"), canonicalBlockTimestamp: new Date("2026-01-01T00:00:00Z"),
    canonicalBlocks: [
      { blockNumber: "40", blockHash: H("1"), parentHash: H("0"), blockTimestamp: new Date("2026-01-01T00:00:00Z") },
      { blockNumber: "41", blockHash: H("2"), parentHash: H("1"), blockTimestamp: new Date("2026-01-01T00:00:00Z") },
    ],
    observations: [{ kind: "exact_log", quoteId: H("3"), txHash: H("4"), logIndex: 0, blockNumber: "41",
      blockHash: H("2"), blockTimestamp: new Date("2026-01-01T00:00:00Z"), exactMatch: true }], metadata: { overlap: 64 } });
  assert.equal(result.released, 0);
  assert.equal(result.reorged, 0);
  const call = seen.find(({ sql }) => /gate\.record_scanner_range/.test(sql));
  assert.match(call.sql, /record_scanner_range\(\$1,\$2,\$3,\$4,\$5,\$6::jsonb\)/);
  const persisted = JSON.parse(call.values[5]);
  assert.equal(persisted.kind, "observations");
  assert.equal(persisted.observations.length, 1);
  assert.equal(persisted.observations[0].quoteId, H("3"));
  assert.equal(persisted.generation, "1");
  assert.deepEqual(persisted.metadata, { overlap: 64 });
});

test("reservation release delegates only to persisted canonical range and log evidence", async () => {
  const seen = [];
  const client = { async query(sql, values) {
    seen.push({ sql: String(sql), values });
    if (/gate\.release_expired_reservation/.test(sql)) return { rows: [{ released: true }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client } });
  assert.equal(await store.releaseReservation(H("1"), { deploymentId: "d" }), true);
  assert.equal(seen.some(({ sql }) => /lastEligibleBlock|coverageComplete/.test(sql)), false);
  assert.match(seen.find(({ sql }) => /release_expired_reservation/.test(sql)).sql, /release_expired_reservation/);
});

test("PR6 Postgres store exposes durable settlement and worker queue methods", async () => {
  const seen = [];
  const pool = { async query(sql, values) {
    const text = String(sql); seen.push({ sql: text, values });
    if (/settlement_cursors/.test(text)) return { rows: [{ deploymentId: "d", deploymentBlock: "1", nextRangeFrom: "2", generation: "3" }] };
    return { rows: [] };
  } };
  const store = new PostgresGateStore({ pool });
  assert.deepEqual(await store.getScannerState({ chainId: "8453", splitter: A }),
    { deploymentId: "d", deploymentBlock: "1", nextRangeFrom: "2", generation: "3" });
  assert.equal(await store.findSettlementQuote(H("1")), null);
  assert.deepEqual(await store.listPendingSettlementHints({ limit: 5 }), []);
  assert.deepEqual(await store.claimSettlementMonitors({ chainId: "8453", splitter: A, headBlock: "99", limit: 5 }), []);
  assert.deepEqual(await store.claimNotificationAttempts({ limit: 5, now: new Date(0) }), []);
  for (const method of ["recordSettlementHint", "resolveSettlementHint", "claimSettlementLifecycle", "recordSettlementLifecycle",
    "advanceSettlementMonitor", "completeNotification", "failNotification", "reconcileNotification"]) assert.equal(typeof store[method], "function", method);
  const issuedSql = seen.map(({ sql }) => sql).join("\n");
  assert.match(issuedSql, /SELECT id,"claimToken","retryCount","firstAttemptAt","dedupeDeadline","profileId","destinationRef",summary[\s\S]*gate\.claim_notification_attempts/);
  const migrationSql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  assert.match(migrationSql, /claim_notification_attempts[\s\S]*SKIP LOCKED/);
  assert.match(migrationSql, /GRANT EXECUTE ON FUNCTION gate\.claim_notification_attempts/);
  assert.doesNotMatch(migrationSql, /\bGRANT\s[^;]*UPDATE[^;]*gate\.notification_attempts/i);
});

test("settlement monitor SQL claims only due rows and advances with a fenced durable schedule", async () => {
  const calls = [];
  const client = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    if (/WITH candidates/.test(String(sql))) return { rows: [] };
    if (/UPDATE gate\.settlement_reorg_monitors/.test(String(sql))) return { rows: [] };
    return { rows: [] };
  }, release() {} };
  const pool = { query: client.query.bind(client), connect: async () => client };
  const store = new PostgresGateStore({ pool });
  await store.claimSettlementMonitors({ chainId: "8453", splitter: A, headBlock: "73", limit: 9 });
  assert.match(calls[0].sql, /next_check_block<=\$3/);
  assert.match(calls[0].sql, /JOIN gate\.quotes q ON q\.id=c\.quote_id[\s\S]*q\.quote_id AS "quoteId"/i);
  assert.match(calls[0].sql, /claim_generation=claim_generation\+1/);
  assert.match(calls[0].sql, /make_interval\(secs => \$5 \/ 1000\.0\)/);
  assert.deepEqual(calls[0].values, ["8453", A, "73", 9, 300000]);
  assert.equal(await store.advanceSettlementMonitor({ id: "m", claimToken: "4", progressBlock: "72",
    nextCheckBlock: "73", completed: false, reorged: false }), false);
  const update = calls.find((call) => /WHERE id=\$1 AND claim_generation/.test(call.sql));
  assert.match(update.sql, /claim_generation=\$3::bigint/);
  assert.match(update.sql, /claimed_until>clock_timestamp\(\)/);
  assert.match(update.sql, /next_check_block=COALESCE\(\$4,next_check_block\)/);
});

test("notification SQL persists a 24-hour dedupe deadline and terminally fences manual reconciliation", async () => {
  const calls = [];
  const pool = { async query(sql, values) {
    calls.push({ sql: String(sql), values });
    return { rows: [{ completed: false, failed: false, reconciled: false }] };
  } };
  const store = new PostgresGateStore({ pool });
  await store.claimNotificationAttempts({ limit: 9, leaseMs: 123_000 });
  assert.equal(await store.completeNotification({ id: "n", claimToken: "7", providerOpaqueId: "p" }), false);
  assert.equal(await store.failNotification({ id: "n", claimToken: "7", errorCode: "TEMP", nextAttemptAt: new Date(0) }), false);
  assert.equal(await store.reconcileNotification({ id: "n", claimToken: "7",
    errorCode: "PROVIDER_IDEMPOTENCY_CONFLICT" }), false);
  assert.match(calls[0].sql, /claim_notification_attempts\(\$1,\$2,\$3\)/);
  assert.deepEqual(calls[0].values, [9, 3, 123_000]);
  assert.deepEqual(calls[1].values, ["n", "7", "p"]);
  assert.deepEqual(calls[2].values, ["n", "7", "TEMP", new Date(0)]);
  assert.deepEqual(calls[3].values, ["n", "7", "PROVIDER_IDEMPOTENCY_CONFLICT"]);

  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const claim = sql.match(/CREATE OR REPLACE FUNCTION gate\.claim_notification_attempts[\s\S]*?\$\$;/i)?.[0] || "";
  const complete = sql.match(/CREATE OR REPLACE FUNCTION gate\.complete_notification_attempt[\s\S]*?END \$\$;/i)?.[0] || "";
  const fail = sql.match(/CREATE OR REPLACE FUNCTION gate\.fail_notification_attempt[\s\S]*?END \$\$;/i)?.[0] || "";
  const reconcile = sql.match(/CREATE OR REPLACE FUNCTION gate\.reconcile_notification_attempt[\s\S]*?END \$\$;/i)?.[0] || "";
  assert.match(claim, /SET state='pending'[\s\S]*claim_generation=claim_generation\+1/i);
  assert.match(claim, /clock_timestamp\(\)[\s\S]*make_interval\(secs\s*=>\s*p_lease_ms\s*\/\s*1000\.0\)/i);
  assert.match(claim, /first_attempt_at=COALESCE\(first_attempt_at,statement_timestamp\(\)\)/i);
  assert.match(claim, /dedupe_deadline=COALESCE\(dedupe_deadline,statement_timestamp\(\)\+interval '24 hours'\)/i);
  assert.match(claim, /manual_reconciliation_at IS NULL/i);
  assert.doesNotMatch(claim, /p_now/i);
  for (const fn of [claim, complete, fail, reconcile]) assert.match(fn, /SECURITY DEFINER SET search_path=pg_catalog,gate/i);
  for (const fn of [complete, fail, reconcile]) {
    assert.match(fn, /claim_generation=p_claim_token::bigint/i);
    assert.match(fn, /claimed_until>clock_timestamp\(\)/i);
  }
  assert.match(reconcile, /state='failed'[\s\S]*manual_reconciliation_at=clock_timestamp\(\)/i);
  assert.match(sql, /manual_reconciliation_at IS NOT NULL[\s\S]*manual reconciliation is terminal/i);
  assert.match(sql, /UPDATE gate\.notification_attempts[\s\S]*state='failed'[\s\S]*error_code='PROVIDER_IDEMPOTENCY_HISTORY_UNKNOWN'[\s\S]*claim_generation>0/i);
  assert.match(sql, /sha256:gate-001-v3-agentmail-idempotency/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION gate\.complete_notification_attempt\(text,text,text\) FROM PUBLIC/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.complete_notification_attempt\(text,text,text\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.reconcile_notification_attempt\(text,text,text\) TO gavel_gate/i);
  assert.match(sql, /DROP FUNCTION IF EXISTS gate\.claim_notification_attempts\(integer,timestamptz,integer\)/i);
  assert.match(sql, /DROP FUNCTION IF EXISTS gate\.complete_notification_attempt\(text,text\)/i);
  assert.match(sql, /DROP FUNCTION IF EXISTS gate\.fail_notification_attempt\(text,text,timestamptz\)/i);
  assert.doesNotMatch(sql, /\bGRANT\s[^;]*UPDATE[^;]*gate\.notification_attempts/i);
});

test("scanner range leaves pending hints alone and only releases already expiry-pending reservations", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const scanner = sql.match(/CREATE OR REPLACE FUNCTION gate\.record_scanner_range[\s\S]*?END \$\$;/i)?.[0] || "";
  assert.doesNotMatch(scanner, /status='SETTLEMENT_PENDING'|state='expiry_pending_reconciliation'[\s\S]*FROM orphaned/i);
  assert.match(scanner, /q\.state='expired' AND r\.state='expiry_pending_reconciliation'/i);
  assert.match(scanner, /UPDATE gate\.quotes q SET reservation_state='released'/i);
});

test("Gate migration closes quote chains and deployment environments in the catalog", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  assert.match(sql, /ADD CONSTRAINT quotes_base_chain_check\s+CHECK\s*\(base_chain_id IN\s*\(8453,84532\)\)/i);
  const environmentCheck = sql.match(/ADD CONSTRAINT splitter_deployments_environment_check[\s\S]*?;\n/i)?.[0] || "";
  assert.match(environmentCheck, /environment[\s\S]*production[\s\S]*8453[\s\S]*833589fcd6edb6e08f4c7c32d4f71b54bda02913[\s\S]*test[\s\S]*84532[\s\S]*testTokenLabel/i);
  assert.doesNotMatch(environmentCheck, /issuance_active/i);
  assert.match(environmentCheck, /NOT\s*\(config\s*\?\s*'testTokenLabel'\)/i);
  assert.doesNotMatch(sql, /SET issuance_active=false[\s\S]*splitter_deployments_environment_check/i);
  assert.match(sql, /FUNCTION gate\.protect_splitter_deployment_identity[\s\S]*OLD\.config->'environment'[\s\S]*OLD\.config->'testTokenLabel'[\s\S]*immutable deployment identity/i);
  assert.match(sql, /splitter_deployments_immutable_identity[\s\S]*protect_splitter_deployment_identity/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION gate\.validate_relational_bindings[\s\S]*issuance_active[\s\S]*deployment environment[\s\S]*CREATE TRIGGER quotes_validate_bindings/i);
  assert.match(sql, /IF marked THEN[\s\S]*quotes_base_chain_check[\s\S]*splitter_deployments_environment_check[\s\S]*quotes_validate_bindings[\s\S]*marker does not match installed Gate schema/i);
  assert.match(sql, /sha256:gate-001-v3-closed-base-environments/i);
});

test("Gate chain upgrade drops only known quote chain constraints", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const upgrade = sql.match(/ALTER TABLE gate\.quotes DROP CONSTRAINT IF EXISTS quotes_base_chain[^\n]*[\s\S]*?ADD CONSTRAINT quotes_base_chain_check[^;]*;/i)?.[0] || "";
  assert.match(upgrade, /DROP CONSTRAINT IF EXISTS quotes_base_chain_id_check/i);
  assert.match(upgrade, /DROP CONSTRAINT IF EXISTS quotes_base_chain_check/i);
  assert.doesNotMatch(upgrade, /pg_constraint|pg_get_constraintdef|EXECUTE format/i);
});

test("Gate migration replaces legacy settlement completeness checks with one stable confirmation-depth constraint", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const upgrade = sql.match(/DO \$\$\s*DECLARE legacy_constraint name;\s*BEGIN\s*FOR legacy_constraint IN\s*SELECT c\.conname FROM pg_constraint c\s*WHERE c\.conrelid='gate\.quotes'::regclass[\s\S]*?END \$\$;\s*ALTER TABLE gate\.quotes ADD CONSTRAINT quotes_settlement_complete_check[\s\S]*?\)\);/i)?.[0] || "";
  assert.match(upgrade, /c\.conrelid='gate\.quotes'::regclass[\s\S]*c\.contype='c'/i);
  assert.match(upgrade, /pg_get_constraintdef\(c\.oid\)[\s\S]*settlement_confirmations/i);
  assert.match(upgrade, /ALTER TABLE gate\.quotes DROP CONSTRAINT %I/i);
  assert.match(upgrade, /ADD CONSTRAINT quotes_settlement_complete_check/i);
  assert.match(upgrade, /\(state='settled'\)=\([\s\S]*settlement_confirmations\s*=\s*1/i);
  for (const column of [
    "settled_tx_hash", "settled_log_index", "settled_at", "receipt_block", "receipt_block_hash",
    "receipt_block_timestamp", "settlement_proof_canonical", "settlement_scanner_verified",
    "settlement_event_quote_id", "settlement_payer", "settlement_voter", "settlement_attention_amount",
    "settlement_fee_amount", "settlement_gavel_recipient", "settlement_token", "settlement_submission_hash",
    "settlement_quote_version", "settlement_source_chain_id", "settlement_splitter",
  ]) assert.match(upgrade, new RegExp(`\\b${column}\\b`), column);
});

test("public reader uses only narrow definer projection functions", async () => {
  const seen = [];
  const rows = [
    { id: "p" }, { profileId: "p", dao: "nouns" },
    { publicId: "one", state: "payment_required", updatedAt: new Date(1), acceptedAt: null },
    { publicId: "two", state: "pending_settlement", updatedAt: new Date(2), acceptedAt: null },
    { publicId: "three", state: "expired", updatedAt: new Date(3), acceptedAt: null },
    { publicId: "four", state: "accepted", updatedAt: null, acceptedAt: new Date(4) },
  ];
  const reader = createPublicGateReader({ query: async (sql) => {
    seen.push(String(sql));
    return { rows: [rows.shift()] };
  }});
  await reader.getProfile("p");
  await reader.getPolicy("p", "nouns");
  for (const state of ["payment_required", "pending_settlement", "expired"]) {
    assert.deepEqual(Object.keys(await reader.getSubmission(state)), ["publicId", "state", "updatedAt"]);
  }
  assert.deepEqual(Object.keys(await reader.getSubmission("accepted")), ["publicId", "state", "acceptedAt"]);
  assert.match(seen[0], /FROM gate\.public_profile\(\$1\)/i);
  assert.match(seen[1], /FROM gate\.public_dao_policy\(\$1,\$2\)/i);
  assert.match(seen[2], /FROM gate\.public_submission_receipt\(\$1\)/i);
  assert.doesNotMatch(seen.join("\n"), /FROM gate_public\.|gate\.(?:profiles|dao_policies|submissions|inbox_items)|\bJOIN\b/i);
});

test("Gate migration encodes strict invariants, immutable evidence, marker, and no DELETE grant", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const storeSource = fs.readFileSync(path.join(__dirname, "../src/gate/store.js"), "utf8");
  const profileReader = storeSource.match(/async #getProfileByWallet[\s\S]*?\n  }/i)?.[0] || "";
  assert.doesNotMatch(profileReader, /lock\s*=|FOR UPDATE/i);
  assert.match(sql, /schema_migrations[\s\S]*gate\/001_gate/i);
  assert.match(sql, /enabled boolean NOT NULL/i);
  assert.match(sql, /current_lifecycle_unavailable boolean NOT NULL/i);
  assert.match(sql, /CREATE TYPE gate\.lifecycle AS ENUM \('PRE_VOTE','VOTING','CLOSED','UNKNOWN'\)/i);
  assert.match(sql, /dao <> 'nouns' OR \(chain_id = 1 AND \(enabled = false OR accept_pre_vote = true OR accept_voting = true\)\)/i);
  assert.match(sql, /mapping_version text NOT NULL CHECK\(mapping_version IN\('nouns-lifecycle\/1','nouns-candidate-lifecycle\/1'\)\)/i);
  assert.match(sql, /ALTER COLUMN mapping_version TYPE text[\s\S]*nouns-lifecycle\/1/i);
  assert.match(sql, /ADD CONSTRAINT proposal_snapshots_mapping_version_check\s+CHECK \(mapping_version IN\('nouns-lifecycle\/1','nouns-candidate-lifecycle\/1'\)\)/i);
  assert.match(sql, /status IN\('QUOTED','SETTLEMENT_PENDING','SETTLED','EXPIRED'\)/i);
  assert.match(sql, /retry_count integer NOT NULL DEFAULT 0/i);
  assert.match(sql, /private_unavailability_reason/i);
  assert.match(sql, /canonical_actions jsonb NOT NULL/i);
  assert.match(sql, /attention_amount >= 1000000/i);
  assert.match(sql, /fee_amount = 250000/i);
  assert.match(sql, /base_chain_id bigint NOT NULL CHECK\(base_chain_id IN\(8453,84532\)\)/i);
  assert.match(sql, /quote_version = 1/i);
  assert.doesNotMatch(sql, /skip_policy_version_bump/i);
  assert.doesNotMatch(sql, /policy_bump_suppressed_txid/i);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE/i);
  assert.match(sql, /protect_settlement_evidence/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION gate\.mutate_profile/i);
  assert.match(sql, /display_cache\s*-\s*ARRAY\['ens','message'\]/i);
  assert.match(sql, /before_row\.wallet\s*<>\s*p_wallet[\s\S]*wallet.*immutable/i);
  const publicProfiles = sql.match(/CREATE (?:OR REPLACE )?VIEW gate_public\.profiles[\s\S]*?;/i)?.[0] || "";
  assert.doesNotMatch(publicProfiles, /SELECT[^;]*\bdisplay_cache\s*(?:,|FROM)/i);
  assert.match(publicProfiles, /\bens\b[\s\S]*\bmessage\b/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION gate\.validate_relational_bindings/i);
  assert.doesNotMatch(sql, /DECLARE[^\n]+;\s*\nDECLARE\s/i);
  assert.match(sql, /settlement_confirmations integer/i);
  assert.match(sql, /settlement_confirmations\s*=\s*1/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.mutate_profile/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.mutate_profile\(text,text,text,gate\.availability,jsonb,boolean,timestamptz,boolean,text,boolean,jsonb\) TO gavel_gate/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION gate\.transition_notification\(text,gate\.notification_state,text,text\) TO gavel_gate/i);
  assert.doesNotMatch(sql, /GRANT SELECT,INSERT,UPDATE ON gate\.profiles/i);
  assert.match(sql, /IF marked THEN[\s\S]*information_schema\.columns[\s\S]*marker does not match installed Gate schema/i);
  assert.match(sql, /pending_reservation_capacity integer NOT NULL[^;]*DEFAULT 12/i);
  assert.match(sql, /settled_capacity integer NOT NULL[^;]*DEFAULT 25/i);
  assert.match(sql, /pending_reservation_capacity\s*<=\s*settled_capacity\s*\/\s*2/i);
  assert.match(sql, /current_manifest[\s\S]*pg_attribute[\s\S]*pg_constraint[\s\S]*pg_index[\s\S]*pg_trigger[\s\S]*pg_proc[\s\S]*pg_enum/i);
  assert.match(sql, /current_manifest\s+IS DISTINCT FROM\s+stored_manifest/i);
  const capacityQuery = storeSource.match(/const limits = \(await client\.query\(`([\s\S]*?)`,/i)?.[1] || "";
  assert.match(capacityQuery, /count\(\*\)[\s\S]*state IN\('active','expiry_pending_reconciliation'\)/i);
  assert.match(capacityQuery, /count\(\*\)[\s\S]*state='consumed'[\s\S]*consumed_at>clock_timestamp\(\)-interval '24 hours'/i);
  assert.doesNotMatch(capacityQuery, /settled_at/);
  assert.match(storeSource, /interval '600 seconds'/i);
  assert.match(storeSource, /pending_count\)\s*<\s*Number\(locked\.pendingReservationCapacity\)/i);
  assert.match(storeSource, /settled_count\)\s*<\s*Number\(locked\.settledCapacity\)/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION gate\.release_expired_reservation/i);
  const releaseFunction = sql.match(/CREATE OR REPLACE FUNCTION gate\.release_expired_reservation[\s\S]*?END \$\$;/i)?.[0] || "";
  assert.ok(releaseFunction.indexOf("FROM gate.settlement_cursors") < releaseFunction.indexOf("FROM gate.quotes"));
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate\.settlement_scan_ranges/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate\.settlement_scan_blocks/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS gate\.settlement_scan_observations/i);
  assert.match(sql, /INSERT INTO gate\.settlement_scan_ranges[\s\S]*INSERT INTO gate\.settlement_scan_blocks[\s\S]*INSERT INTO gate\.settlement_scan_observations[\s\S]*UPDATE gate\.settlement_cursors/i);
  assert.match(sql, /NOT EXISTS[\s\S]*settlement_scan_observations/i);
  assert.match(sql, /settlement evidence was not persisted by scanner/i);
  assert.match(sql, /checkpoint_block_timestamp[\s\S]*expires_at/i);
  assert.match(sql, /p_hash IS NULL\s+OR p_hash !~/i);
  assert.match(sql, /release_cursor\.checkpoint_block_timestamp IS NULL/i);
  assert.match(sql, /release_cursor\.next_range_from<>release_cursor\.checkpoint_block\+1/i);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER[\s\S]*DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(sql, /migration_checksum|catalog_manifest/i);
  assert.match(sql, /ON CONFLICT\s*\(version\)\s*DO UPDATE SET[\s\S]*migration_checksum\s*=\s*EXCLUDED\.migration_checksum[\s\S]*catalog_manifest\s*=\s*EXCLUDED\.catalog_manifest/i);
  assert.match(sql, /SELECT 'gate\/001_gate-v3','sha256:gate-001-v4-runtime-privilege-audit'/i);
  assert.match(sql, /migration_checksum IN \([\s\S]*sha256:gate-001-v4-nouns-candidates[\s\S]*sha256:gate-001-v4-runtime-privilege-audit[\s\S]*\)/i);
  assert.match(sql, /migration_checksum='sha256:gate-001-v4-runtime-privilege-audit'/i);
});
