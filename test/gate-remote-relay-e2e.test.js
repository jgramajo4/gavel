"use strict";

/**
 * End to end across the remote-relay boundary, with no mocked boundary in the
 * middle: a real Gate HTTP server, the real relay service and its shared
 * prepared-settlement guard, and the real Bankr advocate client talking to it
 * over a socket.
 *
 *   quote -> confirmation -> EIP-3009 authorization -> remote relay
 *         -> transaction hash -> settlement hint -> Gate's own verdict
 *
 * The only stubs are the things this feature does not own: Gate's session
 * store, its submission store, and the funded wallet's actual chain write.
 * Nothing here spends money, and nothing here can: the relayer is a recorder.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");
const {
  buildQuoteMessage,
  createQuoteTypedData,
  decodeSettleCall,
  quoteTotalAmount,
} = require("@gavel/gate");

const { createGateHttpServer } = require("../packages/server/src/gate/http");
const { createGateRelayService } = require("../packages/server/src/gate/relay-service");
const { createBankrGateFlow } = require("../integrations/bankr/src/flow");
const { parseIssuedQuote } = require("../integrations/bankr/src/quote");
const { createWalletStub, PAYER, SPLITTER, TOKEN, TOKEN_NAME, TOKEN_VERSION, VOTER } =
  require("../integrations/bankr/test/helpers");

const SIGNER_KEY = `0x${"7".repeat(64)}`;
const signerWallet = new Wallet(SIGNER_KEY);
const QUOTE_SIGNER = getAddress(signerWallet.address);
const RELAYER = getAddress(`0x${"7e".repeat(20)}`);
const CHAIN_ID = 8453;
const PUBLIC_ID = "abcdefghijklmnopqrstuv";
const SESSION_TOKEN = "T".repeat(43);
const TX_HASH = `0x${"ab".repeat(32)}`;
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

const GATE_ORIGIN = "https://gate.0773h.com";
const RELAY_ORIGIN = "https://relay.0773h.com";

async function signedQuote() {
  const message = buildQuoteMessage({
    quoteId: `0x${"a1".repeat(32)}`,
    payer: PAYER,
    voter: VOTER,
    attentionAmount: "1000000",
    gavelFeeAmount: "250000",
    submissionHash: `0x${"77".repeat(32)}`,
    token: TOKEN,
    expiry: String(NOW_SECONDS + 600),
    quoteVersion: "1",
  });
  const typed = createQuoteTypedData(message, { chainId: CHAIN_ID, verifyingContract: SPLITTER });
  return {
    domain: typed.domain,
    message: typed.message,
    signature: await signerWallet.signTypedData(typed.domain, typed.types, typed.message),
    totalAmount: quoteTotalAmount(message),
  };
}

/** The funded wallet, as a recorder. It signs nothing and spends nothing. */
function relayerRecorder() {
  const sent = [];
  return {
    sent,
    relayer: {
      address: RELAYER,
      async sendSettlement(transaction) { sent.push(transaction); return TX_HASH; },
    },
  };
}

async function gateServer(quote) {
  const state = { state: "payment_required", hints: [], statuses: ["pending_settlement", "accepted"] };
  const recorder = relayerRecorder();
  const relayService = createGateRelayService({
    relayer: recorder.relayer,
    submissionService: {
      async resumeSubmission({ session, publicId }) {
        if (getAddress(session.wallet) !== PAYER || publicId !== PUBLIC_ID) return null;
        return { publicId, state: state.state, updatedAt: new Date(NOW_MS), quote };
      },
    },
    deployment: { chainId: String(CHAIN_ID), splitter: SPLITTER, token: TOKEN, quoteSigner: QUOTE_SIGNER },
    tokenDomain: { name: TOKEN_NAME, version: TOKEN_VERSION },
    now: () => NOW_MS,
  });
  let statusIndex = 0;
  const server = createGateHttpServer({
    authService: {
      issueChallenge: async () => ({}),
      verifyProof: async () => ({}),
      authenticateSession: async (token, requirement) => {
        if (token !== SESSION_TOKEN || requirement.role !== "base_sender") throw new Error("unauthorized");
        return { role: "base_sender", wallet: PAYER };
      },
    },
    profileService: {
      updateProfile: async () => ({}),
      listPublicProfiles: async () => [],
      getPublicProfile: async () => null,
    },
    submissionService: {
      createSubmission: async () => ({ publicId: PUBLIC_ID, state: "payment_required", quote }),
      resumeSubmission: async () => ({ publicId: PUBLIC_ID, state: state.state, quote }),
      getPublicStatus: async () => {
        const next = state.statuses[Math.min(statusIndex, state.statuses.length - 1)];
        statusIndex += 1;
        return next === "accepted"
          ? { publicId: PUBLIC_ID, state: next, acceptedAt: "2026-09-19T00:01:00.000Z" }
          : { publicId: PUBLIC_ID, state: next };
      },
    },
    settlementService: {
      submitTxHash: async ({ publicId, txHash, chainId }) => {
        state.hints.push({ publicId, txHash, chainId });
        // A hint moves Gate to pending_settlement. It is not acceptance: the
        // scanner still has to verify the log.
        state.state = "pending_settlement";
        return { publicId, state: "pending_settlement", updatedAt: new Date(NOW_MS) };
      },
    },
    relayService,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, recorder, state, base: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Production origins on the wire, a loopback socket underneath.
 *
 * The client's own origin rules stay strict — it refuses an IP literal, a
 * loopback, and plain HTTP — so the test names the real origins and rewrites
 * only at the transport, which is what a TLS terminator does anyway.
 */
function localFetch(base) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const target = String(url).replace(GATE_ORIGIN, base).replace(RELAY_ORIGIN, base);
      calls.push({ url: String(url), method: options.method || "GET", body: options.body });
      const response = await fetch(target, options);
      const text = await response.text();
      return { status: response.status, async text() { return text; } };
    },
  };
}

function flowFor(transport) {
  const walletStub = createWalletStub();
  return {
    walletStub,
    flow: createBankrGateFlow({
      wallet: walletStub.wallet,
      // Deliberately no in-process relayer: this is the Bankr sandbox case.
      fetchImpl: transport.fetchImpl,
      config: {
        gateUrl: GATE_ORIGIN,
        indexUrl: "https://index.0773h.com",
        relayerUrl: RELAY_ORIGIN,
        dao: "nouns",
        allowedChainIds: [CHAIN_ID],
        requestTimeoutMs: 5_000,
      },
      now: () => NOW_MS,
      sleep: async () => {},
    }),
  };
}

test("quote -> authorization -> remote relay -> tx hash -> settlement hint -> accepted", async (t) => {
  const issued = await signedQuote();
  const gate = await gateServer(issued);
  t.after(() => new Promise((resolve) => gate.server.close(resolve)));
  // The client reads Gate's payload exactly as it reads any issued quote.
  const quote = parseIssuedQuote(issued);
  const transport = localFetch(gate.base);
  const { flow, walletStub } = flowFor(transport);
  const session = { token: SESSION_TOKEN };

  // 1. The confirmation an advocate must approve. Every value is the quote's.
  const summary = flow.confirmation({ quote, target: { title: "Fund the builder grant", stage: "PRE_VOTE" }, voter: { wallet: VOTER } });
  assert.equal(summary.totalAmount, "1250000");
  assert.ok(summary.text.includes("Total: 1.25 USDC"));

  // 2. Bankr signs one EIP-3009 authorization. Nothing is broadcast here.
  const prepared = await flow.authorize({ quote, confirmed: true });
  assert.deepEqual(Object.keys(prepared).sort(), ["data", "to", "value"]);
  assert.equal(prepared.value, "0x0");
  assert.equal(gate.recorder.sent.length, 0);

  // 3. The Gate server validates and broadcasts with its own funded wallet.
  const payment = await flow.broadcast({ prepared, quote, session, publicId: PUBLIC_ID });
  assert.equal(payment.txHash, TX_HASH);
  assert.equal(payment.remote, true);
  assert.equal(payment.relayer, RELAYER);
  assert.equal(payment.payer, PAYER);
  assert.notEqual(payment.relayer, payment.payer);
  assert.equal(payment.accepted, false, "a relay receipt is never acceptance");

  // The transaction the funded wallet actually got: three fields, zero ETH,
  // and calldata that decodes back to the quote Gate itself signed.
  assert.equal(gate.recorder.sent.length, 1);
  const sent = gate.recorder.sent[0];
  assert.deepEqual(Object.keys(sent).sort(), ["data", "to", "value"]);
  assert.equal(sent.to, SPLITTER);
  assert.equal(sent.value, "0x0");
  const decoded = decodeSettleCall(sent.data);
  assert.equal(decoded.quote.quoteId, String(quote.message.quoteId).toLowerCase());
  assert.equal(decoded.quote.payer, PAYER);
  assert.equal(decoded.quote.voter, VOTER);
  assert.equal(decoded.authorization.from, PAYER);
  assert.equal(decoded.authorization.to, SPLITTER);
  assert.equal(decoded.authorization.value, "1250000");
  // The USDC leg is the payer's. The relayer paid gas and nothing else.
  assert.notEqual(decoded.authorization.from, RELAYER);
  assert.equal(decoded.quoteSignature, issued.signature);

  // 4. The hash goes to Gate as a HINT. It is not delivery.
  const hint = await flow.submitSettlementHint({ session, publicId: PUBLIC_ID, payment });
  assert.equal(hint.hint, true);
  assert.equal(hint.accepted, false);
  assert.deepEqual(gate.state.hints, [{ publicId: PUBLIC_ID, txHash: TX_HASH, chainId: String(CHAIN_ID) }]);

  // 5. Only Gate's own verdict is delivery.
  const verdict = await flow.awaitAcceptance({ publicId: PUBLIC_ID, intervalMs: 0, attempts: 5 });
  assert.equal(verdict.state, "accepted");
  assert.equal(verdict.delivered, true);

  // Bankr signed exactly once here (the authorization) and broadcast nothing.
  assert.equal(walletStub.calls.signTypedData.length, 1);
  assert.equal(typeof walletStub.wallet.sendTransaction, "undefined");

  // What crossed the wire to the relay: one signature, no transaction fields.
  const relayCall = transport.calls.find((call) => call.url.endsWith("/relay"));
  const body = JSON.parse(relayCall.body);
  assert.deepEqual(Object.keys(body), ["authorization"]);
  assert.deepEqual(Object.keys(body.authorization), ["signature"]);
  assert.equal(body.authorization.signature, decoded.authorizationSignature);
});

test("the live relay route refuses an arbitrary transaction and a replay, and never double-spends gas", async (t) => {
  const issued = await signedQuote();
  const gate = await gateServer(issued);
  t.after(() => new Promise((resolve) => gate.server.close(resolve)));
  const quote = parseIssuedQuote(issued);

  const post = (body, token = SESSION_TOKEN) => fetch(`${gate.base}/v1/submissions/${PUBLIC_ID}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  const { flow } = flowFor(localFetch(gate.base));
  const prepared = await flow.authorize({ quote, confirmed: true });
  const { authorizationSignature } = decodeSettleCall(prepared.data);

  // Nothing that names a destination, calldata, or a value is accepted.
  for (const body of [
    { to: SPLITTER, data: "0xdeadbeef", value: "0x1" },
    { authorization: { signature: authorizationSignature }, to: `0x${"9".repeat(40)}` },
    { authorization: { signature: authorizationSignature }, data: "0xdeadbeef" },
    { authorization: { signature: authorizationSignature }, value: "0xde0b6b3a7640000" },
    { authorization: { signature: `0x${"11".repeat(65)}` } },
  ]) {
    const response = await post(body);
    assert.ok(response.status >= 400, `expected ${JSON.stringify(body)} to be refused`);
    assert.equal(gate.recorder.sent.length, 0);
  }

  // An unauthenticated caller never reaches the funded wallet either.
  assert.equal((await post({ authorization: { signature: authorizationSignature } }, null)).status, 401);
  assert.equal((await post({ authorization: { signature: authorizationSignature } }, "forged")).status, 401);
  assert.equal(gate.recorder.sent.length, 0);

  // The real settlement broadcasts exactly once, however many times it is sent.
  const first = await post({ authorization: { signature: authorizationSignature } });
  assert.equal(first.status, 200);
  const second = await post({ authorization: { signature: authorizationSignature } });
  assert.equal(second.status, 200);
  assert.equal((await first.json()).txHash, (await second.json()).txHash);
  assert.equal(gate.recorder.sent.length, 1, "the relay spent gas twice on one quote");
});
