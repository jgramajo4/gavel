"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, getAddress } = require("ethers");
const {
  buildQuoteMessage,
  createQuoteTypedData,
  decodeSettleCall,
  deriveUsdcAuthorization,
  quoteTotalAmount,
} = require("@gavel/gate");

const { RECEIVE_WITH_AUTHORIZATION_TYPES, createGateRelayService } = require("../src/gate/relay-service");
const { MemoryGateStore } = require("../src/gate/store-memory");

const SIGNER_KEY = `0x${"7".repeat(64)}`;
const PAYER_KEY = `0x${"11".repeat(32)}`;
const STRANGER_KEY = `0x${"22".repeat(32)}`;
const signerWallet = new Wallet(SIGNER_KEY);
const payerWallet = new Wallet(PAYER_KEY);
const strangerWallet = new Wallet(STRANGER_KEY);

const QUOTE_SIGNER = getAddress(signerWallet.address);
const PAYER = getAddress(payerWallet.address);
const VOTER = getAddress(`0x${"ab".repeat(20)}`);
const SPLITTER = getAddress(`0x${"5e".repeat(20)}`);
const TOKEN = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const RELAYER = getAddress(`0x${"7e".repeat(20)}`);
const CHAIN_ID = "8453";
const PUBLIC_ID = "A".repeat(22);
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const TOKEN_DOMAIN = Object.freeze({ name: "USD Coin", version: "2" });

function quoteMessage(overrides = {}) {
  return buildQuoteMessage({
    quoteId: `0x${"a1".repeat(32)}`,
    payer: PAYER,
    voter: VOTER,
    attentionAmount: "1000000",
    gavelFeeAmount: "250000",
    submissionHash: `0x${"77".repeat(32)}`,
    token: TOKEN,
    expiry: String(NOW_SECONDS + 600),
    quoteVersion: "1",
    ...overrides,
  });
}

async function issuedQuote({ message = quoteMessage(), signer = signerWallet, splitter = SPLITTER,
  chainId = Number(CHAIN_ID) } = {}) {
  const typed = createQuoteTypedData(message, { chainId, verifyingContract: splitter });
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.message);
  return { domain: typed.domain, message: typed.message, signature, totalAmount: quoteTotalAmount(message) };
}

async function authorizationSignature({ message = quoteMessage(), splitter = SPLITTER, wallet = payerWallet,
  chainId = Number(CHAIN_ID), token = TOKEN } = {}) {
  return wallet.signTypedData(
    { ...TOKEN_DOMAIN, chainId, verifyingContract: token },
    { ...RECEIVE_WITH_AUTHORIZATION_TYPES },
    deriveUsdcAuthorization(message, splitter),
  );
}

function relayerStub({ address = RELAYER, fail = false } = {}) {
  const sent = [];
  const broadcasts = [];
  const txHash = `0x${"ab".repeat(32)}`;
  const rawTransaction = `0x02${"12".repeat(100)}`;
  return {
    sent,
    broadcasts,
    relayer: {
      address,
      async preflightSettlement(transaction) {
        sent.push(transaction);
        return { txHash, rawTransaction };
      },
      async broadcastSettlement(prepared) {
        broadcasts.push(prepared);
        if (fail) throw new Error("RPC response lost after broadcast");
        return txHash;
      },
    },
  };
}

function submissionStub({ quote, state = "payment_required", owner = PAYER } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async resumeSubmission({ session, publicId }) {
        calls.push({ publicId, wallet: session?.wallet });
        // Owner-bound, exactly as the real service is: a non-owner sees nothing.
        if (getAddress(session.wallet) !== getAddress(owner)) return null;
        if (publicId !== PUBLIC_ID) return null;
        return quote === null
          ? { publicId, state, updatedAt: new Date(NOW_MS) }
          : { publicId, state, updatedAt: new Date(NOW_MS), quote };
      },
    },
  };
}

async function harness(options = {}) {
  const quote = options.quote === undefined ? await issuedQuote() : options.quote;
  const relay = relayerStub(options.relayer);
  const submissions = submissionStub({ quote, state: options.state, owner: options.owner });
  const service = createGateRelayService({
    relayer: relay.relayer,
    relayStore: options.store ?? new MemoryGateStore(),
    submissionService: submissions.service,
    deployment: { chainId: CHAIN_ID, splitter: SPLITTER, token: TOKEN, quoteSigner: QUOTE_SIGNER },
    tokenDomain: TOKEN_DOMAIN,
    now: () => options.now ?? NOW_MS,
  });
  return { service, relay, submissions, quote };
}

const SESSION = Object.freeze({ role: "base_sender", wallet: PAYER });

function relayRequest(signature) {
  return { authorization: { signature } };
}

test("a valid settlement is rebuilt server-side and broadcast gas-only", async () => {
  const { service, relay } = await harness();
  const receipt = await service.relaySettlement({
    session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature()),
  });

  assert.deepEqual(Object.keys(receipt).sort(), ["chainId", "relayer", "txHash"]);
  assert.equal(receipt.chainId, CHAIN_ID);
  assert.equal(receipt.relayer, RELAYER);
  assert.match(receipt.txHash, /^0x[0-9a-f]{64}$/);

  // Exactly three fields crossed into the funded wallet, and no ETH moved.
  assert.equal(relay.sent.length, 1);
  assert.deepEqual(Object.keys(relay.sent[0]).sort(), ["data", "to", "value"]);
  assert.equal(relay.sent[0].to, SPLITTER);
  assert.equal(relay.sent[0].value, "0x0");

  // The calldata the server built decodes back to the quote the server signed,
  // and the USDC leg is the payer's, never the relayer's.
  const decoded = decodeSettleCall(relay.sent[0].data);
  assert.equal(decoded.quote.payer, PAYER);
  assert.equal(decoded.quote.voter, VOTER);
  assert.equal(decoded.quote.token, TOKEN);
  assert.equal(decoded.authorization.from, PAYER);
  assert.equal(decoded.authorization.to, SPLITTER);
  assert.equal(decoded.authorization.value, "1250000");
  assert.notEqual(decoded.authorization.from, RELAYER);
});

test("an arbitrary destination, calldata, or value cannot be submitted", async () => {
  const { service, relay } = await harness();
  const signature = await authorizationSignature();
  const bodies = [
    { authorization: { signature }, to: `0x${"9".repeat(40)}` },
    { authorization: { signature }, data: "0xdeadbeef" },
    { authorization: { signature }, value: "0xde0b6b3a7640000" },
    { authorization: { signature, to: `0x${"9".repeat(40)}` } },
    { authorization: { signature, data: "0xdeadbeef" } },
    { to: `0x${"9".repeat(40)}`, data: "0xdeadbeef", value: "0x1" },
  ];
  for (const request of bodies) {
    await assert.rejects(
      service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request }),
      (error) => error.code === "INVALID_RELAY" && error.statusCode === 400,
      `expected ${JSON.stringify(request)} to be refused`,
    );
  }
  assert.equal(relay.sent.length, 0);
});

test("a malformed or absent authorization never reaches the relayer", async () => {
  const { service, relay } = await harness();
  for (const request of [undefined, null, {}, [], "0x", { authorization: null },
    { authorization: { signature: "0xabc" } }, { authorization: { signature: 7 } }]) {
    await assert.rejects(
      service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request }),
      (error) => error.statusCode === 400,
    );
  }
  assert.equal(relay.sent.length, 0);
});

test("a session that does not own the submission gets a plain 404", async () => {
  const { service, relay } = await harness({ owner: VOTER });
  await assert.rejects(
    service.relaySettlement({
      session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature()),
    }),
    (error) => error.code === "NOT_FOUND" && error.statusCode === 404,
  );
  assert.equal(relay.sent.length, 0);
});

test("a quote issued to a different payer is refused even with a valid signature", async () => {
  // The persisted quote names a stranger as payer; the session, and therefore
  // the owner-bound lookup, is this payer's.
  const message = quoteMessage({ payer: getAddress(strangerWallet.address) });
  const { service, relay } = await harness({ quote: await issuedQuote({ message }) });
  await assert.rejects(
    service.relaySettlement({
      session: SESSION,
      publicId: PUBLIC_ID,
      request: relayRequest(await authorizationSignature({ message, wallet: strangerWallet })),
    }),
    (error) => error.code === "NOT_FOUND",
  );
  assert.equal(relay.sent.length, 0);
});

test("a quote this Gate did not sign is refused", async () => {
  const { service, relay } = await harness({ quote: await issuedQuote({ signer: strangerWallet }) });
  await assert.rejects(
    service.relaySettlement({
      session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature()),
    }),
    (error) => error.code === "INVALID_RELAY" && error.statusCode === 409 && /not signed by this Gate/.test(error.message),
  );
  assert.equal(relay.sent.length, 0);
});

test("a tampered persisted quote field breaks the signature and is refused", async () => {
  const signed = await issuedQuote();
  for (const override of [
    { voter: getAddress(`0x${"55".repeat(20)}`) },
    { attentionAmount: "9000000" },
    { gavelFeeAmount: "250000", attentionAmount: "1000001" },
    { quoteId: `0x${"b2".repeat(32)}` },
    { expiry: String(NOW_SECONDS + 1200) },
    { submissionHash: `0x${"88".repeat(32)}` },
  ]) {
    const tampered = { ...signed, message: quoteMessage(override) };
    const { service, relay } = await harness({ quote: tampered });
    await assert.rejects(
      service.relaySettlement({
        session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature()),
      }),
      (error) => error.statusCode === 409 && error.code === "INVALID_RELAY",
      `expected ${JSON.stringify(override)} to be refused`,
    );
    assert.equal(relay.sent.length, 0);
  }
});

test("a quote for another splitter, token, or chain is refused", async () => {
  const cases = [
    { splitter: getAddress(`0x${"44".repeat(20)}`) },
    { chainId: 84532 },
    { message: quoteMessage({ token: getAddress(`0x${"66".repeat(20)}`) }) },
  ];
  for (const override of cases) {
    const { service, relay } = await harness({ quote: await issuedQuote(override) });
    await assert.rejects(
      service.relaySettlement({
        session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature(override)),
      }),
      (error) => error.statusCode === 409 && /this Gate deployment/.test(error.message),
      `expected ${JSON.stringify(override)} to be refused`,
    );
    assert.equal(relay.sent.length, 0);
  }
});

test("an expired quote is refused before any gas is spent", async () => {
  const message = quoteMessage({ expiry: String(NOW_SECONDS - 1) });
  const { service, relay } = await harness({ quote: await issuedQuote({ message }) });
  await assert.rejects(
    service.relaySettlement({
      session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature({ message })),
    }),
    (error) => error.code === "EXPIRED" && error.statusCode === 410 && error.state === "expired",
  );
  assert.equal(relay.sent.length, 0);
});

test("an authorization for a different quote or a different signer is refused", async () => {
  const { service, relay } = await harness();
  const wrongQuote = await authorizationSignature({ message: quoteMessage({ quoteId: `0x${"b2".repeat(32)}` }) });
  const wrongSplitter = await authorizationSignature({ splitter: getAddress(`0x${"44".repeat(20)}`) });
  const wrongSigner = await authorizationSignature({ wallet: strangerWallet });
  const wrongToken = await authorizationSignature({ token: getAddress(`0x${"66".repeat(20)}`) });
  for (const signature of [wrongQuote, wrongSplitter, wrongSigner, wrongToken]) {
    await assert.rejects(
      service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request: relayRequest(signature) }),
      (error) => error.statusCode === 400 && /authorization/.test(error.message),
    );
  }
  assert.equal(relay.sent.length, 0);
});

test("a relayer that IS the payer is refused", async () => {
  const { service, relay } = await harness({ relayer: { address: PAYER } });
  await assert.rejects(
    service.relaySettlement({
      session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature()),
    }),
    (error) => error.code === "RELAYER_IS_PAYER" && error.statusCode === 503,
  );
  assert.equal(relay.sent.length, 0);
});

test("a submission Gate has already moved past is not re-broadcast", async () => {
  for (const state of ["pending_settlement", "accepted", "rejected_by_policy", "duplicate"]) {
    const { service, relay } = await harness({ state });
    await assert.rejects(
      service.relaySettlement({
        session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature()),
      }),
      (error) => error.code === "NOT_PAYABLE" && error.statusCode === 409 && error.state === state,
    );
    assert.equal(relay.sent.length, 0);
  }
});

test("an expired submission with no quote is refused as expired", async () => {
  const { service, relay } = await harness({ quote: null, state: "expired" });
  await assert.rejects(
    service.relaySettlement({
      session: SESSION, publicId: PUBLIC_ID, request: relayRequest(await authorizationSignature()),
    }),
    (error) => error.code === "EXPIRED" && error.state === "expired",
  );
  assert.equal(relay.sent.length, 0);
});

test("relaying the same quote twice broadcasts once and returns the same hash", async () => {
  const { service, relay } = await harness();
  const request = relayRequest(await authorizationSignature());
  const first = await service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request });
  const second = await service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request });
  const [concurrentA, concurrentB] = await Promise.all([
    service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request }),
    service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request }),
  ]);
  assert.equal(relay.sent.length, 1);
  assert.equal(second.txHash, first.txHash);
  assert.equal(concurrentA.txHash, first.txHash);
  assert.equal(concurrentB.txHash, first.txHash);
});

test("an ambiguous broadcast failure is not retried or reported as a false receipt", async () => {
  const { service, relay } = await harness({ relayer: { fail: true } });
  const request = relayRequest(await authorizationSignature());
  await assert.rejects(service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request }),
    (error) => error.code === "RELAY_RECONCILIATION_REQUIRED");
  await assert.rejects(service.relaySettlement({ session: SESSION, publicId: PUBLIC_ID, request }),
    (error) => error.code === "RELAY_RECONCILIATION_REQUIRED");
  assert.equal(relay.sent.length, 1);
  assert.equal(relay.broadcasts.length, 1);
});

test("an unauthenticated or wrong-role session never reaches the store", async () => {
  const { service, submissions, relay } = await harness();
  const request = relayRequest(await authorizationSignature());
  for (const session of [undefined, {}, { role: "dao_inbox", wallet: PAYER }, { role: "base_sender" },
    { role: "base_sender", wallet: "not-an-address" }]) {
    await assert.rejects(
      service.relaySettlement({ session, publicId: PUBLIC_ID, request }),
      (error) => error.code === "UNAUTHORIZED" && error.statusCode === 401,
    );
  }
  assert.equal(submissions.calls.length, 0);
  assert.equal(relay.sent.length, 0);
});

test("the receipt carries no signature, session, or key material", async () => {
  const { service } = await harness();
  const signature = await authorizationSignature();
  const receipt = await service.relaySettlement({
    session: SESSION, publicId: PUBLIC_ID, request: relayRequest(signature),
  });
  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, new RegExp(signature.slice(2, 40), "i"));
  for (const secret of ["signature", "authorization", "Bearer", "session", "token", "key", "rpc"]) {
    assert.doesNotMatch(serialized, new RegExp(secret, "i"), `the receipt echoed ${secret}`);
  }
});

test("the service refuses to be constructed with a relayer inside the money path", async () => {
  const quote = await issuedQuote();
  for (const address of [SPLITTER, TOKEN, QUOTE_SIGNER]) {
    assert.throws(
      () => createGateRelayService({
        relayer: relayerStub({ address }).relayer,
        relayStore: new MemoryGateStore(),
        submissionService: submissionStub({ quote }).service,
        deployment: { chainId: CHAIN_ID, splitter: SPLITTER, token: TOKEN, quoteSigner: QUOTE_SIGNER },
        tokenDomain: TOKEN_DOMAIN,
      }),
      /must not be the/,
    );
  }
});

test("the service refuses an unattested token domain", async () => {
  const quote = await issuedQuote();
  for (const tokenDomain of [undefined, {}, { name: "USD Coin" }, { name: "", version: "2" }]) {
    assert.throws(
      () => createGateRelayService({
        relayer: relayerStub().relayer,
        relayStore: new MemoryGateStore(),
        submissionService: submissionStub({ quote }).service,
        deployment: { chainId: CHAIN_ID, splitter: SPLITTER, token: TOKEN, quoteSigner: QUOTE_SIGNER },
        tokenDomain,
      }),
      /name and version are required/,
    );
  }
});
