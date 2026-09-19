const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");
const { buildQuoteMessage, createQuoteTypedData, verifyQuoteSignature } = require("@gavel/gate");

const { MemoryGateStore } = require("../src/gate/store-memory");
const { PostgresGateStore } = require("../src/gate/store");
const { createQuoteSigner } = require("../src/gate/quote-signer");

function loadIssuance() { return require("../src/gate/quote-issuance"); }

const SIGNER_KEY = `0x${"7".repeat(64)}`;
const SIGNER_ADDRESS = new Wallet(SIGNER_KEY).address;
const VOTER = "0x1111111111111111111111111111111111111111";
const SPLITTER = "0x2222222222222222222222222222222222222222";
const PAYER = "0x3333333333333333333333333333333333333333";
const RECIPIENT = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const H = (digit) => `0x${digit.repeat(64)}`;
const DB_NOW = new Date("2026-01-01T00:00:00.000Z");
const DB_EXPIRY = new Date("2026-01-01T00:10:00.000Z");

function signer() { return createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: SPLITTER }); }

function issuanceCommand(overrides = {}) {
  return {
    context: {
      authPassed: true, parsePassed: true, expectedProfileVersion: "1", walletKind: "eoa",
      authenticatedSender: PAYER, payerIsEoa: true, payerWalletKind: "eoa",
      basePayoutCodeHash: null, stage: "VOTING", deploymentCodeHash: H("e"),
    },
    snapshot: {
      id: "snapshot-1", dao: "nouns", proposalId: "42", contentHash: H("c"), nativeState: "ACTIVE",
      eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1", sourceBlock: "100", sourceBlockHash: H("d"),
      refreshedAt: DB_NOW, canonicalFacts: {}, decodedFacts: {}, canonicalActions: [],
    },
    submission: { id: "submission-1", submissionHash: H("a"), profileId: "profile-1", issuanceSnapshotId: "snapshot-1",
      payer: PAYER, signedSender: PAYER, material: {} },
    quote: { id: "quote-1", quoteId: H("b"), payer: PAYER, voter: VOTER, attentionAmount: "1000000",
      feeAmount: "250000", token: TOKEN, baseChainId: "8453", splitter: SPLITTER, deploymentId: "deployment-1",
      quoteVersion: 1 },
    reservation: { id: "reservation-1", profileId: "profile-1", amount: "1000000" },
    ...overrides,
  };
}

async function memoryStore(options = {}) {
  const store = new MemoryGateStore({ clock: () => DB_NOW, ...options });
  await store.mutateProfile({
    profile: { id: "profile-1", wallet: VOTER, walletKind: "eoa", availability: "accepting_now" },
    policy: { dao: "nouns", chainId: "1", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: [] },
  });
  await store.configureDeployment({
    id: "deployment-1", chainId: "8453", splitter: SPLITTER, signer: SIGNER_ADDRESS, token: TOKEN,
    gavelRecipient: RECIPIENT, contractCodeHash: H("e"), deploymentBlock: "0", nextBlock: "0",
    issuanceActive: true, config: { environment: "production" }, rpcAccess: {},
  });
  return store;
}

// A stub pool that answers exactly the statements Postgres issuance runs, so the
// Postgres path can be exercised for signing semantics without a live database.
function postgresStore(options = {}) {
  const calls = [];
  const client = {
    async query(sql, values) {
      const text = String(sql);
      calls.push({ sql: text, values });
      if (/FROM gate\.submissions WHERE submission_hash/.test(text)) return { rows: [] };
      if (/gate\.lock_issuance_profile_policy/.test(text)) {
        return { rows: [{ wallet: VOTER.toLowerCase(), walletKind: "eoa", availability: "accepting_now",
          profileVersion: "1", basePayoutCodeHash: null, enabled: true, chainId: "1", attentionAmount: "1000000",
          acceptPreVote: false, acceptVoting: true, pendingReservationCapacity: 12, settledCapacity: 25 }] };
      }
      if (/FROM gate\.splitter_deployments/.test(text)) {
        return { rows: [{ issuance_active: true, chain_id: "8453", splitter: SPLITTER.toLowerCase(),
          token: TOKEN.toLowerCase(), contract_code_hash: H("e"), config: { environment: "production" } }] };
      }
      if (/interval '600 seconds'/.test(text)) return { rows: [{ now: DB_NOW, expiresAt: DB_EXPIRY }] };
      if (/AS pending_count/.test(text)) {
        return { rows: [{ pending_count: 0, settled_count: 0, pair_proposal: 0, active_pair: 0 }] };
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const store = new PostgresGateStore({
    pool: { connect: async () => client, query: client.query },
    randomBytes: () => Buffer.alloc(16, 9),
    ...options,
  });
  return { store, calls };
}

test("the shared issuance module owns the single quote message and domain construction", () => {
  const { buildIssuedQuoteMessage, issuanceInstant, quoteExpiryFrom, issuedQuotePayload } = loadIssuance();

  assert.equal(issuanceInstant(new Date("2026-01-01T00:00:00.750Z")).toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(quoteExpiryFrom(DB_NOW).toISOString(), DB_EXPIRY.toISOString());

  const message = buildIssuedQuoteMessage({
    quoteId: H("b"), payer: PAYER.toLowerCase(), voter: VOTER.toLowerCase(), attentionAmount: "1000000",
    feeAmount: "250000", submissionHash: H("a"), token: TOKEN.toLowerCase(), expiresAt: DB_EXPIRY,
  });
  assert.deepEqual(message, buildQuoteMessage({
    quoteId: H("b"), payer: PAYER, voter: VOTER, attentionAmount: "1000000", gavelFeeAmount: "250000",
    submissionHash: H("a"), token: TOKEN, expiry: String(DB_EXPIRY.getTime() / 1000), quoteVersion: "1",
  }));

  const payload = issuedQuotePayload({ domain: signer().domain, message, signature: "0xabcdef" });
  assert.deepEqual(Object.keys(payload).sort(), ["domain", "message", "signature", "totalAmount"]);
  assert.equal(payload.totalAmount, "1250000");
});

test("a signer bound to a different chain or splitter can never sign for a deployment", async () => {
  const { assertSignerDeploymentBinding } = loadIssuance();

  assert.doesNotThrow(() => assertSignerDeploymentBinding(signer(), { chainId: "8453", splitter: SPLITTER.toLowerCase() }));
  assert.throws(() => assertSignerDeploymentBinding(signer(), { chainId: "84532", splitter: SPLITTER }),
    /signer domain/i);
  assert.throws(() => assertSignerDeploymentBinding(signer(), { chainId: "8453", splitter: RECIPIENT }),
    /signer domain/i);

  const store = await memoryStore();
  const wrongSigner = createQuoteSigner({ signer: SIGNER_KEY, chainId: 8453, splitter: RECIPIENT });
  await assert.rejects(store.issue({ ...issuanceCommand(), signer: wrongSigner }), /signer domain/i);
  assert.equal((await store.counts()).quotes, 0);
  assert.equal((await store.counts()).reservations, 0);
});

test("the in-memory and Postgres stores sign identical quote domains and messages", async () => {
  const memory = await memoryStore();
  const memoryIssued = await memory.issue({ ...issuanceCommand(), signer: signer() });

  const postgres = postgresStore();
  const postgresIssued = await postgres.store.issue({ ...issuanceCommand(), signer: signer() });

  assert.deepEqual(memoryIssued.quote.domain, postgresIssued.quote.domain);
  assert.deepEqual(memoryIssued.quote.message, postgresIssued.quote.message);
  assert.equal(memoryIssued.quote.signature, postgresIssued.quote.signature);
  assert.equal(memoryIssued.quote.totalAmount, postgresIssued.quote.totalAmount);
  assert.equal(memoryIssued.quote.expiresAt.valueOf(), DB_EXPIRY.valueOf());
  assert.equal(postgresIssued.quote.expiresAt.valueOf(), DB_EXPIRY.valueOf());

  const typed = createQuoteTypedData(memoryIssued.quote.message, memoryIssued.quote.domain);
  assert.equal(verifyQuoteSignature(typed, memoryIssued.quote.signature, SIGNER_ADDRESS), true);
  assert.equal(memoryIssued.quote.message.expiry, String(DB_EXPIRY.getTime() / 1000));
  assert.equal(memoryIssued.quote.message.token, getAddress(TOKEN));
});

test("neither store accepts a caller-supplied expiry or signature", async () => {
  const memory = await memoryStore();
  for (const mutate of [
    (command) => { command.quote.expiresAt = new Date("2099-01-01T00:00:00.000Z"); },
    (command) => { command.quote.signature = "0xcaller-supplied"; },
    (command) => { command.reservation.expiresAt = new Date("2099-01-01T00:00:00.000Z"); },
  ]) {
    const command = issuanceCommand();
    mutate(command);
    await assert.rejects(memory.issue({ ...command, signer: signer() }), /store owns|caller|not accepted/i);
  }
  assert.equal((await memory.counts()).quotes, 0);

  const postgres = postgresStore();
  const preSigned = issuanceCommand();
  preSigned.quote.signature = "0xcaller-supplied";
  await assert.rejects(postgres.store.issue({ ...preSigned, signer: signer() }), /store owns|caller|not accepted/i);
});

test("exactly one signing invocation happens per successful quote, inside the issuance transaction", async () => {
  const invocations = [];
  const countingSigner = () => {
    const real = signer();
    return Object.freeze({
      address: real.address,
      domain: real.domain,
      async signQuote(message) { invocations.push(structuredClone(message)); return real.signQuote(message); },
    });
  };

  const memory = await memoryStore();
  const issued = await memory.issue({ ...issuanceCommand(), signer: countingSigner() });
  assert.equal(invocations.length, 1);
  assert.deepEqual(invocations[0], issued.quote.message);

  invocations.length = 0;
  const postgres = postgresStore();
  await postgres.store.issue({ ...issuanceCommand(), signer: countingSigner() });
  assert.equal(invocations.length, 1);

  // Signing happens before the quote and reservation rows are written, so a
  // signer failure can never leave a committed reservation behind.
  const signIndex = postgres.calls.findIndex((call) => /INSERT INTO gate\.quotes/.test(call.sql));
  const reservationIndex = postgres.calls.findIndex((call) => /INSERT INTO gate\.capacity_reservations/.test(call.sql));
  assert.ok(signIndex >= 0 && reservationIndex > signIndex);
  assert.equal(postgres.calls.some((call) => /UPDATE gate\.quotes SET quote_signature/.test(call.sql)), false);
});

test("a signer failure aborts issuance atomically and commits no quote or reservation", async () => {
  const failing = Object.freeze({
    address: SIGNER_ADDRESS,
    domain: signer().domain,
    async signQuote() { throw new Error("KMS unavailable"); },
  });

  const memory = await memoryStore();
  await assert.rejects(memory.issue({ ...issuanceCommand(), signer: failing }), /KMS unavailable|signer/i);
  assert.deepEqual(await memory.counts(), {
    snapshots: 0, submissions: 0, quotes: 0, reservations: 0, inboxItems: 0, notifications: 0, monitors: 0,
  });

  const postgres = postgresStore();
  await assert.rejects(postgres.store.issue({ ...issuanceCommand(), signer: failing }), /KMS unavailable|signer/i);
  assert.equal(postgres.calls.some((call) => /INSERT INTO gate\.capacity_reservations/.test(call.sql)), false);

  // A signer that returns a signature from the wrong key is rejected in the
  // same transaction rather than reaching a payer.
  const foreign = new Wallet(`0x${"8".repeat(64)}`);
  const wrongKey = Object.freeze({
    address: SIGNER_ADDRESS,
    domain: signer().domain,
    async signQuote(message) {
      const typed = createQuoteTypedData(message, signer().domain);
      return foreign.signTypedData(typed.domain, typed.types, typed.message);
    },
  });
  const mismatched = await memoryStore();
  await assert.rejects(mismatched.issue({ ...issuanceCommand(), signer: wrongKey }), /signature/i);
  assert.equal((await mismatched.counts()).quotes, 0);
});

test("issuance requires a signer: there is no unsigned or deferred-signature path", async () => {
  const memory = await memoryStore();
  await assert.rejects(memory.issue(issuanceCommand()), /signer/i);
  assert.equal((await memory.counts()).quotes, 0);

  const postgres = postgresStore();
  await assert.rejects(postgres.store.issue(issuanceCommand()), /signer/i);
});
