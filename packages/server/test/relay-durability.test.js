"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");
const {
  buildQuoteMessage,
  createQuoteTypedData,
  deriveUsdcAuthorization,
  quoteTotalAmount,
} = require("@gavel/gate");
const { MemoryGateStore } = require("../src/gate/store-memory");
const { RECEIVE_WITH_AUTHORIZATION_TYPES, createGateRelayService } = require("../src/gate/relay-service");

const SIGNER = new Wallet(`0x${"7".repeat(64)}`);
const PAYER = new Wallet(`0x${"11".repeat(32)}`);
const OTHER = new Wallet(`0x${"22".repeat(32)}`);
const SPLITTER = getAddress(`0x${"5e".repeat(20)}`);
const TOKEN = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const RELAYER = getAddress(`0x${"7e".repeat(20)}`);
const PUBLIC_ID = "A".repeat(22);
const CHAIN_ID = "8453";
const NOW = 1_800_000_000_000;
const TX_HASH = `0x${"ab".repeat(32)}`;
const RAW_TX = `0x02${"12".repeat(100)}`;
const TOKEN_DOMAIN = Object.freeze({ name: "USD Coin", version: "2" });
const SESSION = Object.freeze({ role: "base_sender", wallet: PAYER.address });

function message(overrides = {}) {
  return buildQuoteMessage({
    quoteId: `0x${"a1".repeat(32)}`,
    payer: PAYER.address,
    voter: getAddress(`0x${"ab".repeat(20)}`),
    attentionAmount: "1000000",
    gavelFeeAmount: "250000",
    submissionHash: `0x${"77".repeat(32)}`,
    token: TOKEN,
    expiry: String(Math.floor(NOW / 1000) + 600),
    quoteVersion: "1",
    ...overrides,
  });
}

async function issuedQuote(quoteMessage = message()) {
  const typed = createQuoteTypedData(quoteMessage, { chainId: Number(CHAIN_ID), verifyingContract: SPLITTER });
  return {
    domain: typed.domain,
    message: typed.message,
    signature: await SIGNER.signTypedData(typed.domain, typed.types, typed.message),
    totalAmount: quoteTotalAmount(typed.message),
  };
}

async function authorizationSignature(wallet = PAYER, quoteMessage = message()) {
  return wallet.signTypedData(
    { ...TOKEN_DOMAIN, chainId: Number(CHAIN_ID), verifyingContract: TOKEN },
    { ...RECEIVE_WITH_AUTHORIZATION_TYPES },
    deriveUsdcAuthorization(quoteMessage, SPLITTER),
  );
}

function submissionService(quote) {
  return {
    async resumeSubmission({ session, publicId }) {
      if (publicId !== PUBLIC_ID || getAddress(session.wallet) !== PAYER.address) return null;
      return { publicId, state: "payment_required", quote };
    },
  };
}

function relayer({ preflightFailures = 0, broadcastFailure = false, delayed = false } = {}) {
  const calls = { preflight: 0, broadcast: 0 };
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  return {
    calls,
    release,
    value: {
      address: RELAYER,
      async preflightSettlement(transaction) {
        calls.preflight += 1;
        assert.deepEqual(Object.keys(transaction).sort(), ["data", "to", "value"]);
        if (calls.preflight <= preflightFailures) {
          const error = new Error("gas estimation rejected");
          error.code = "PREFLIGHT_FAILED";
          error.definitelyNotSent = true;
          throw error;
        }
        return { txHash: TX_HASH, rawTransaction: RAW_TX };
      },
      async broadcastSettlement(prepared) {
        calls.broadcast += 1;
        assert.deepEqual(prepared, { txHash: TX_HASH, rawTransaction: RAW_TX });
        if (delayed) await blocked;
        if (broadcastFailure) throw new Error("RPC response lost after send");
        return TX_HASH;
      },
    },
  };
}

async function service({ store, relay, quote }) {
  const resolvedQuote = quote ?? await issuedQuote();
  return createGateRelayService({
    relayer: relay.value,
    relayStore: store,
    submissionService: submissionService(resolvedQuote),
    deployment: { chainId: CHAIN_ID, splitter: SPLITTER, token: TOKEN, quoteSigner: SIGNER.address },
    tokenDomain: TOKEN_DOMAIN,
    now: () => NOW,
  });
}

const request = async (wallet = PAYER) => ({ authorization: { signature: await authorizationSignature(wallet) } });
const invoke = (relayService, body) => relayService.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request: body });

test("restart recovers a durably stored relay hash without broadcasting again", async () => {
  const store = new MemoryGateStore();
  const firstRelayer = relayer();
  const instanceA = await service({ store, relay: firstRelayer });
  const body = await request();
  const first = await invoke(instanceA, body);

  const secondRelayer = relayer();
  const instanceB = await service({ store, relay: secondRelayer });
  const recovered = await invoke(instanceB, body);

  assert.equal(first.txHash, TX_HASH);
  assert.deepEqual(recovered, first);
  assert.equal(firstRelayer.calls.broadcast, 1);
  assert.equal(secondRelayer.calls.preflight, 0);
  assert.equal(secondRelayer.calls.broadcast, 0);
});

test("restart after the write-ahead record refuses a false receipt and never broadcasts a replacement", async () => {
  const durableStore = new MemoryGateStore();
  const crashingStore = new Proxy(durableStore, {
    get(target, property) {
      if (property !== "markRelayBroadcasting") {
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (record) => {
        await target.markRelayBroadcasting(record);
        throw new Error("simulated process crash after durable write-ahead");
      };
    },
  });
  const original = relayer();
  const instanceA = await service({ store: crashingStore, relay: original });
  const body = await request();

  await assert.rejects(invoke(instanceA, body), /simulated process crash/);
  const persisted = await durableStore.getRelayAttempt({ quoteId: message().quoteId });
  assert.equal(persisted.status, "broadcasting");
  assert.equal(persisted.txHash, TX_HASH);
  assert.equal(original.calls.broadcast, 0);

  const replacement = relayer();
  const instanceB = await service({ store: durableStore, relay: replacement });
  await assert.rejects(
    invoke(instanceB, body),
    (error) => error.code === "RELAY_RECONCILIATION_REQUIRED",
  );
  assert.equal(replacement.calls.preflight, 0);
  assert.equal(replacement.calls.broadcast, 0);
});

test("concurrent duplicate relay calls converge on one broadcast and one hash", async () => {
  const store = new MemoryGateStore();
  const delayed = relayer({ delayed: true });
  const relayService = await service({ store, relay: delayed });
  const body = await request();

  const first = invoke(relayService, body);
  const second = invoke(relayService, body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delayed.calls.preflight, 1);
  assert.equal(delayed.calls.broadcast, 1);
  delayed.release();

  const receipts = await Promise.all([first, second]);
  assert.equal(receipts[0].txHash, TX_HASH);
  assert.deepEqual(receipts[1], receipts[0]);
});

test("definitely-not-sent preflight failure releases the durable claim for retry", async () => {
  const store = new MemoryGateStore();
  const failing = relayer({ preflightFailures: 1 });
  const relayService = await service({ store, relay: failing });
  const body = await request();

  await assert.rejects(invoke(relayService, body), (error) => error.code === "PREFLIGHT_FAILED");
  const receipt = await invoke(relayService, body);

  assert.equal(receipt.txHash, TX_HASH);
  assert.equal(failing.calls.preflight, 2);
  assert.equal(failing.calls.broadcast, 1);
});

test("ambiguous post-send failure is persisted for reconciliation and never rebroadcast", async () => {
  const store = new MemoryGateStore();
  const ambiguous = relayer({ broadcastFailure: true });
  const instanceA = await service({ store, relay: ambiguous });
  const body = await request();

  await assert.rejects(invoke(instanceA, body), (error) => error.code === "RELAY_RECONCILIATION_REQUIRED");
  const state = await store.getRelayAttempt({ quoteId: message().quoteId });
  assert.equal(state.status, "reconciliation_required");
  assert.equal(state.txHash, TX_HASH);

  const replacement = relayer();
  const instanceB = await service({ store, relay: replacement });
  await assert.rejects(invoke(instanceB, body), (error) => error.code === "RELAY_RECONCILIATION_REQUIRED");
  assert.equal(replacement.calls.preflight, 0);
  assert.equal(replacement.calls.broadcast, 0);
});

test("authorization is verified before durable dedup lookup, so another authorization cannot inherit a hash", async () => {
  const store = new MemoryGateStore();
  const original = relayer();
  const instanceA = await service({ store, relay: original });
  await invoke(instanceA, await request());

  const replacement = relayer();
  const instanceB = await service({ store, relay: replacement });
  await assert.rejects(invoke(instanceB, await request(OTHER)), /authorization/i);
  assert.equal(replacement.calls.preflight, 0);
  assert.equal(replacement.calls.broadcast, 0);
});

test("the durable relay identity is the authoritative quote nonce plus deployment, not caller text", async () => {
  const store = new MemoryGateStore();
  const identity = {
    quoteId: message().quoteId,
    authorizationNonce: message().quoteId,
    chainId: CHAIN_ID,
    splitter: SPLITTER,
    token: TOKEN,
  };
  const first = await store.claimRelayAttempt(identity);
  assert.equal(first.disposition, "claimed");
  await store.markRelayBroadcasting({ quoteId: identity.quoteId, claimToken: first.claimToken,
    txHash: TX_HASH, rawTransaction: RAW_TX });
  await store.completeRelayBroadcast({ quoteId: identity.quoteId, txHash: TX_HASH });

  const sameAuthorization = await store.claimRelayAttempt(identity);
  assert.equal(sameAuthorization.disposition, "existing");
  assert.equal(sameAuthorization.txHash, TX_HASH);
  await assert.rejects(store.claimRelayAttempt({ ...identity, authorizationNonce: `0x${"b2".repeat(32)}` }),
    /authorization nonce/i);
});
