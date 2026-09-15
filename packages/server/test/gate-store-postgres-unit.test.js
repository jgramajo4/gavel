const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PostgresGateStore, createPublicGateReader } = require("../src/gate/store");

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const H = (digit) => `0x${digit.repeat(64)}`;

function noConnectStore() {
  return new PostgresGateStore({ pool: {
    connect: async () => { throw new Error("validation reached the database"); },
    query: async () => { throw new Error("validation reached the database"); },
  }});
}

function issuanceCommand() {
  return {
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: A,
      expectedProfileVersion: "1", walletKind: "eoa", stage: "VOTING", deploymentCodeHash: H("1") },
    snapshot: { id: "s", dao: "nouns", proposalId: "1", contentHash: H("2"), nativeState: "ACTIVE",
      eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: H("3"),
      refreshedAt: new Date(), canonicalFacts: {}, decodedFacts: {}, canonicalActions: [] },
    submission: { id: "sub", submissionHash: H("4"), profileId: "p", payer: A, signedSender: A, material: {} },
    quote: { id: "q", quoteId: H("5"), payer: A, voter: A, attentionAmount: "1000000", feeAmount: "250000",
      token: A, baseChainId: "8453", splitter: A, deploymentId: "d", quoteVersion: 1 },
    reservation: { id: "r", profileId: "p", amount: "1000000" },
  };
}

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

test("Postgres issuance compares counts with the persisted policy capacities selected under lock", async () => {
  const calls = [];
  const client = { async query(sql) {
    sql = String(sql); calls.push(sql);
    if (/FROM gate\.submissions WHERE submission_hash/.test(sql)) return { rows: [] };
    if (/FROM gate\.profiles WHERE id=.*FOR UPDATE/.test(sql)) return { rows: [{ id: "p", wallet: A, wallet_kind: "eoa", availability: "accepting_now", profile_version: "1" }] };
    if (/FROM gate\.dao_policies/.test(sql)) return { rows: [{ enabled: true, chain_id: "1", attention_amount: "1000000", accept_voting: true,
      pending_reservation_capacity: 2, settled_capacity: 4 }] };
    if (/FROM gate\.splitter_deployments/.test(sql)) return { rows: [{ issuance_active: true, chain_id: "8453", splitter: A, token: A, contract_code_hash: H("1") }] };
    if (/interval '600 seconds'/.test(sql)) return { rows: [{ now: new Date(0), expiresAt: new Date(600_000) }] };
    if (/AS pending_count/.test(sql)) return { rows: [{ pending_count: 2, settled_count: 0, pair_proposal: 0, active_pair: 0 }] };
    return { rows: [], rowCount: 1 };
  }, release() {} };
  const store = new PostgresGateStore({ pool: { connect: async () => client }, quoteSigner: async () => "signed" });
  await assert.rejects(store.issue(issuanceCommand()), /capacity unavailable/);
  assert.match(calls.find((sql) => /FROM gate\.dao_policies/.test(sql)), /FOR UPDATE/);
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
      feeAmount: "250000", token: A, baseChainId: "1", splitter: A, quoteVersion: 1, expiresAt: future },
    reservation: { id: "r", profileId: "p", amount: "1000000", expiresAt: future },
  };
  const payerKindUnknown = structuredClone(command);
  delete payerKindUnknown.context.payerIsEoa;
  await assert.rejects(store.issue(payerKindUnknown), /payer.*EOA/i);
  const senderUnknown = structuredClone(command);
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
      if (/FROM gate\.profiles WHERE id=.*FOR UPDATE/.test(sql)) return { rows: [{ id: "p", wallet: A, wallet_kind: "contract", availability: "accepting_now", profile_version: "7", base_payout_code_hash: keccak256(code) }] };
      if (/FROM gate\.dao_policies/.test(sql)) return { rows: [{ enabled: true, chain_id: "1", attention_amount: "1000000", accept_pre_vote: false, accept_voting: true, pending_reservation_capacity: 12, settled_capacity: 25 }] };
      if (/FROM gate\.splitter_deployments/.test(sql)) return { rows: [{ issuance_active: true, chain_id: "8453", splitter: A, token: A, contract_code_hash: H("1") }] };
      if (/interval '600 seconds'/.test(sql)) return { rows: [{ now: databaseNow, expiresAt: trustedExpiry }] };
      if (/AS pending_count/.test(sql)) return { rows: [{ pending_count: 0, settled_count: 0, pair_proposal: 0, active_pair: 0 }] };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
  const signerCalls = [];
  const store = new PostgresGateStore({
    pool: { connect: async () => client },
    baseCodeReader: async ({ wallet, chainId }) => { calls.push({ sql: "ETH_GET_CODE", wallet, chainId }); return code; },
    quoteSigner: async (unsigned) => { signerCalls.push(structuredClone(unsigned)); calls.push({ sql: "SIGN" }); return "0xsigned"; },
  });
  const command = {
    context: { authPassed: true, parsePassed: true, payerIsEoa: true, authenticatedSender: B, expectedProfileVersion: "7", walletKind: "contract", stage: "VOTING", deploymentCodeHash: H("1") },
    snapshot: { id: "snap", dao: "nouns", proposalId: "1", contentHash: H("2"), nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1", sourceBlock: "1", sourceBlockHash: H("3"), refreshedAt: new Date(), canonicalFacts: {}, decodedFacts: {}, canonicalActions: [] },
    submission: { id: "sub", submissionHash: H("4"), profileId: "p", payer: B, signedSender: B, material: {} },
    quote: { id: "q", quoteId: H("5"), payer: B, voter: A, attentionAmount: "1000000", feeAmount: "250000", token: A, baseChainId: "8453", splitter: A, deploymentId: "d", quoteVersion: 1, expiresAt: callerExpiry },
    reservation: { id: "r", profileId: "p", amount: "1000000", expiresAt: callerExpiry },
  };
  const issued = await store.issue(command);
  assert.equal(issued.quote.signature, "0xsigned");
  assert.equal(issued.quote.expiresAt.valueOf(), trustedExpiry.valueOf());
  assert.equal(signerCalls.length, 1);
  assert.equal(signerCalls[0].expiry, Math.floor(trustedExpiry.valueOf() / 1000));
  assert.equal(Object.hasOwn(signerCalls[0], "signature"), false);
  assert.equal(calls.find((x) => /INSERT INTO gate\.quotes/.test(x.sql)).values.at(-1).valueOf(), trustedExpiry.valueOf());
  assert.equal(calls.find((x) => /INSERT INTO gate\.capacity_reservations/.test(x.sql)).values.at(-1).valueOf(), trustedExpiry.valueOf());
  assert.ok(calls.findIndex((x) => /pg_advisory_xact_lock/.test(x.sql)) < calls.findIndex((x) => x.sql === "ETH_GET_CODE"));
  assert.ok(calls.findIndex((x) => /INSERT INTO gate\.capacity_reservations/.test(x.sql)) < calls.findIndex((x) => x.sql === "SIGN"));
  assert.ok(calls.findIndex((x) => x.sql === "SIGN") < calls.findIndex((x) => /UPDATE gate\.quotes SET quote_signature/.test(x.sql)));

  const unsignedStore = new PostgresGateStore({
    pool: { connect: async () => client },
    baseCodeReader: async () => code,
  });
  const callerSigned = structuredClone(command);
  callerSigned.quote.signature = "0xcaller-supplied";
  await assert.rejects(unsignedStore.issue(callerSigned), /quote signer unavailable/i);

  const preVote = structuredClone(command); preVote.context.stage = "PRE_VOTE";
  await assert.rejects(store.issue(preVote), /Nouns.*VOTING/i);
  const ethereumSettlement = structuredClone(command); ethereumSettlement.quote.baseChainId = "1";
  await assert.rejects(store.issue(ethereumSettlement), /Base 8453/i);
  const contractPayer = structuredClone(command); contractPayer.context.payerIsEoa = false;
  await assert.rejects(store.issue(contractPayer), /payer.*EOA/i);
});

test("settlement accepts exactly the frozen eight event fields and notification starts pending", async () => {
  const store = noConnectStore();
  const base = {
    quoteId: H("1"), settlement: { txHash: H("2"), logIndex: 0, receiptBlock: "2", receiptBlockHash: H("3"), receiptBlockTimestamp: new Date(), settledAt: new Date(),
      event: { quoteId: H("1"), payer: A, voter: A, attentionAmount: "1000000", gavelRecipient: B, gavelFeeAmount: "250000", token: A, submissionHash: H("4") },
      evidence: { chainId: "8453", splitter: A, canonical: true, scannerVerified: true, oneConfirmation: true } },
    inbox: { id: "i", issuanceLifecycle: "VOTING", currentLifecycle: "VOTING", lifecycleChanged: false, currentLifecycleUnavailable: false },
    notification: { id: "n", channel: "email", destinationRef: "cipher", status: "pending" }, monitor: { id: "m", nextCheckBlock: "3" },
  };
  for (const mutate of [
    (x) => { delete x.settlement.event.gavelRecipient; },
    (x) => { x.settlement.event.quoteVersion = 1; },
    (x) => { x.notification.status = "sent"; },
  ]) {
    const invalid = structuredClone(base); mutate(invalid);
    await assert.rejects(store.settle(invalid), /exactly|pending/i);
  }
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
      token: A, baseChainId: "8453", splitter: A, quoteVersion: 1, expiresAt: future },
    reservation: { id: "r", profileId: "p", amount: "1000000", expiresAt: future },
  };
  for (const patch of [{ nativeState: "1" }, { nativeState: 1 }, { nativeState: "SUCCEEDED" }, { eligibility: "CLOSED" }]) {
    await assert.rejects(issuanceStore.issue({ ...issuance, snapshot: { ...issuance.snapshot, ...patch } }), /ACTIVE.*VOTING/i);
  }

  const base = {
    quoteId: H("1"), settlement: { txHash: H("2"), logIndex: 0, receiptBlock: "2", receiptBlockHash: H("3"), receiptBlockTimestamp: new Date(), settledAt: new Date(),
      event: { quoteId: H("1"), payer: A, voter: A, attentionAmount: "1000000", gavelRecipient: B, gavelFeeAmount: "250000", token: A, submissionHash: H("4") },
      evidence: { chainId: "8453", splitter: A, canonical: true, scannerVerified: true, oneConfirmation: true } },
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
      token: A, baseChainId: "8453", splitter: A, quoteVersion: 1, expiresAt: future },
    reservation: { id: "r", profileId: "p", amount: "1000000", expiresAt: future },
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
      token: A, baseChainId: "8453", splitter: A, quoteVersion: 1, expiresAt: future },
    reservation: { id: "r2", profileId: "p", amount: "1000000", expiresAt: future },
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
  const configured = await store.configureDeployment({ id: "d", chainId: "8453", splitter: A, signer: B, token: A,
    gavelRecipient: B, deploymentBlock: "40", nextBlock: "99", contractCodeHash: H("1"), rpcAccess: "cipher" });
  const deploymentInsert = seen.find(({ sql }) => /INSERT INTO gate\.splitter_deployments/.test(sql));
  const cursorInsert = seen.find(({ sql }) => /INSERT INTO gate\.settlement_cursors/.test(sql));
  assert.equal(deploymentInsert.values[7], "40");
  assert.equal(cursorInsert.values[4], "40");
  assert.equal(configured.nextBlock, "40");
  assert.doesNotMatch(deploymentInsert.sql, /DO UPDATE SET scanner_cursor=EXCLUDED\.scanner_cursor/);
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
    canonicalBlocks: ["40", "41"].map((blockNumber) => ({ blockNumber, blockHash: H("2"),
      blockTimestamp: new Date("2026-01-01T00:00:00Z") })),
    observations: [{ kind: "exact_log", quoteId: H("3"), txHash: H("4"), logIndex: 0, blockNumber: "41",
      blockHash: H("2"), blockTimestamp: new Date("2026-01-01T00:00:00Z"), exactMatch: true }], metadata: { overlap: 64 } });
  assert.equal(result.released, 0);
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

test("public reader queries only dedicated views and returns state-specific receipt timestamps", async () => {
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
  assert.match(seen[0], /FROM gate_public\.profiles/i);
  assert.match(seen[1], /FROM gate_public\.dao_policies/i);
  assert.match(seen[2], /FROM gate_public\.submission_receipts/i);
  assert.doesNotMatch(seen.join("\n"), /gate\.(?:profiles|dao_policies|submissions|inbox_items)|\bJOIN\b/i);
});

test("Gate migration encodes strict invariants, immutable evidence, marker, and no DELETE grant", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../migrations/001_gate.sql"), "utf8");
  const storeSource = fs.readFileSync(path.join(__dirname, "../src/gate/store.js"), "utf8");
  assert.match(sql, /schema_migrations[\s\S]*gate\/001_gate/i);
  assert.match(sql, /enabled boolean NOT NULL/i);
  assert.match(sql, /current_lifecycle_unavailable boolean NOT NULL/i);
  assert.match(sql, /CREATE TYPE gate\.lifecycle AS ENUM \('PRE_VOTE','VOTING','CLOSED','UNKNOWN'\)/i);
  assert.match(sql, /dao <> 'nouns' OR \(chain_id = 1 AND accept_pre_vote = false AND \(enabled = false OR accept_voting = true\)\)/i);
  assert.match(sql, /mapping_version text NOT NULL CHECK\(mapping_version='nouns-lifecycle\/1'\)/i);
  assert.match(sql, /ALTER COLUMN mapping_version TYPE text[\s\S]*nouns-lifecycle\/1/i);
  assert.match(sql, /ADD CONSTRAINT proposal_snapshots_mapping_version_check\s+CHECK \(mapping_version='nouns-lifecycle\/1'\)/i);
  assert.match(sql, /status IN\('QUOTED','SETTLEMENT_PENDING','SETTLED','EXPIRED'\)/i);
  assert.match(sql, /retry_count integer NOT NULL DEFAULT 0/i);
  assert.match(sql, /private_unavailability_reason/i);
  assert.match(sql, /canonical_actions jsonb NOT NULL/i);
  assert.match(sql, /attention_amount >= 1000000/i);
  assert.match(sql, /fee_amount = 250000/i);
  assert.match(sql, /base_chain_id bigint NOT NULL CHECK\(base_chain_id=8453\)/i);
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
  assert.match(sql, /settlement_scanner_verified boolean/i);
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
  assert.match(storeSource, /pending_count\)\s*<\s*Number\(policy\.pending_reservation_capacity\)/i);
  assert.match(storeSource, /settled_count\)\s*<\s*Number\(policy\.settled_capacity\)/i);
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
});
