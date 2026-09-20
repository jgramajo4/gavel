"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getAddress } = require("ethers");

const { resolveConfig } = require("../src/config");
const { authorizePayment, broadcastPayment } = require("../src/payment");
const { parseIssuedQuote } = require("../src/quote");
const { createRemoteRelay } = require("../src/remote-relay");
const { SETTLE_SELECTOR, decodeSettleCall } = require("../src/splitter");
const {
  BASE_MAINNET, PAYER, RELAYER, SPLITTER, createWalletStub, issuedQuote,
} = require("./helpers");

const NOW_MS = 1_800_000_000_000;
const now = () => NOW_MS;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const RELAY_ORIGIN = "https://relay.0773h.com";
const PUBLIC_ID = "A".repeat(22);
const TOKEN = "gate-session-token";
const TX_HASH = `0x${"ab".repeat(32)}`;

const quoteFixture = () => parseIssuedQuote(issuedQuote());

async function preparedFor(quote = quoteFixture()) {
  const { wallet } = createWalletStub();
  return { quote, prepared: await authorizePayment({ wallet, quote, confirmed: true, now }) };
}

/** A recording relay endpoint. Every request is captured for inspection. */
function relayStub({ status = 200, body, relayer = RELAYER, chainId = String(BASE_MAINNET), fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    if (fail) throw fail;
    const payload = body === undefined ? { txHash: TX_HASH, chainId, relayer } : body;
    return { status, async text() { return payload === null ? "" : JSON.stringify(payload); } };
  };
  return { calls, fetchImpl };
}

function relayFor(stub) {
  return createRemoteRelay({ relayUrl: RELAY_ORIGIN, fetchImpl: stub.fetchImpl });
}

test("the remote relay sends the submission id and one signature, and nothing else", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub();
  const receipt = await relayFor(stub).relay({
    token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS,
  });

  assert.equal(stub.calls.length, 1);
  const [call] = stub.calls;
  assert.equal(call.url, `${RELAY_ORIGIN}/v1/submissions/${PUBLIC_ID}/relay`);
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);

  // The wire body is one signature. No target, no calldata, no value.
  const body = JSON.parse(call.body);
  assert.deepEqual(Object.keys(body), ["authorization"]);
  assert.deepEqual(Object.keys(body.authorization), ["signature"]);
  assert.match(body.authorization.signature, /^0x[0-9a-fA-F]{130}$/);
  for (const field of ["to", "data", "value", "quote", "domain", "message"]) {
    assert.doesNotMatch(call.body, new RegExp(`"${field}"`), `the relay request carried ${field}`);
  }

  assert.equal(receipt.txHash, TX_HASH);
  assert.equal(receipt.chainId, String(BASE_MAINNET));
  assert.equal(receipt.relayer, RELAYER);
  assert.equal(receipt.payer, PAYER);
  assert.equal(receipt.remote, true);
  assert.equal(receipt.broadcast, true);
  // A relay receipt is never acceptance.
  assert.equal(receipt.accepted, false);
});

test("the signature sent is the one bound to this quote's calldata", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub();
  await relayFor(stub).relay({ token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS });

  const sent = JSON.parse(stub.calls[0].body).authorization.signature;
  const decoded = decodeSettleCall(prepared.data);
  assert.equal(sent, decoded.authorizationSignature);
  assert.equal(decoded.authorization.from, PAYER);
  assert.equal(decoded.authorization.to, SPLITTER);
  assert.ok(prepared.data.startsWith(SETTLE_SELECTOR));
});

test("an arbitrary destination, mutated calldata, or ETH value never leaves the client", async () => {
  const { quote, prepared } = await preparedFor();
  const otherQuote = parseIssuedQuote(issuedQuote({ message: { attentionAmount: "9000000" }, totalAmount: "9250000" }));
  const flipped = prepared.data[20] === "f" ? "e" : "f";
  const candidates = [
    { ...prepared, to: getAddress(`0x${"9".repeat(40)}`) },
    { ...prepared, data: "0xdeadbeef" },
    { ...prepared, data: `${prepared.data.slice(0, 20)}${flipped}${prepared.data.slice(21)}` },
    { ...prepared, value: "0x1" },
    { ...prepared, from: PAYER },
    { to: getAddress(`0x${"8".repeat(40)}`), data: "0xdeadbeef", value: "0x0" },
  ];
  const stub = relayStub();
  const relay = relayFor(stub);
  for (const candidate of candidates) {
    await assert.rejects(
      relay.relay({ token: TOKEN, publicId: PUBLIC_ID, prepared: candidate, quote, nowSeconds: NOW_SECONDS }),
      (error) => error.code === "PREPARED_TX_REJECTED",
      `expected ${JSON.stringify(Object.keys(candidate))} to be refused`,
    );
  }
  // A settle call for another quote is refused too.
  await assert.rejects(
    relay.relay({ token: TOKEN, publicId: PUBLIC_ID, prepared, quote: otherQuote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "PREPARED_TX_REJECTED",
  );
  assert.equal(stub.calls.length, 0, "a refused settlement still reached the relay");
});

test("an expired quote is never relayed", async () => {
  const quote = parseIssuedQuote(issuedQuote({ message: { expiry: String(NOW_SECONDS + 60) } }));
  const { prepared } = await preparedFor(quote);
  const stub = relayStub();
  await assert.rejects(
    relayFor(stub).relay({ token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS + 61 }),
    (error) => error.code === "QUOTE_EXPIRED",
  );
  assert.equal(stub.calls.length, 0);
});

test("a relay that reports the payer as its own gas payer is refused", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub({ relayer: PAYER });
  await assert.rejects(
    relayFor(stub).relay({ token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "RELAYER_IS_PAYER",
  );
});

test("a relay answer on the wrong chain, or with no usable hash, is refused", async () => {
  const { quote, prepared } = await preparedFor();
  const answers = [
    [{ txHash: TX_HASH, chainId: "84532", relayer: RELAYER }, "PREPARED_TX_REJECTED"],
    [{ txHash: "0xnope", chainId: String(BASE_MAINNET), relayer: RELAYER }, "BROADCAST_FAILED"],
    [{ chainId: String(BASE_MAINNET), relayer: RELAYER }, "BROADCAST_FAILED"],
    [{ txHash: TX_HASH, chainId: String(BASE_MAINNET) }, "BROADCAST_FAILED"],
    [{ txHash: TX_HASH, chainId: String(BASE_MAINNET), relayer: "not-an-address" }, "BROADCAST_FAILED"],
    [null, "BROADCAST_FAILED"],
  ];
  for (const [body, code] of answers) {
    await assert.rejects(
      relayFor(relayStub({ body })).relay({
        token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS,
      }),
      (error) => error.code === code,
      `expected ${JSON.stringify(body)} to be refused as ${code}`,
    );
  }
});

test("a Gate refusal keeps its code and its state", async () => {
  const { quote, prepared } = await preparedFor();
  const cases = [
    [401, { error: { code: "UNAUTHORIZED", message: "authentication required" } }, "UNAUTHORIZED"],
    [404, { error: { code: "NOT_FOUND", message: "Not found" } }, "NOT_FOUND"],
    [410, { state: "expired", error: { code: "EXPIRED", message: "gone" } }, "EXPIRED"],
    [409, { state: "pending_settlement", error: { code: "NOT_PAYABLE", message: "nothing to broadcast" } }, "NOT_PAYABLE"],
    [503, { error: { code: "RELAYER_IS_PAYER", message: "separate account" } }, "RELAYER_IS_PAYER"],
    [500, null, "REQUEST_FAILED"],
  ];
  for (const [status, body, code] of cases) {
    await assert.rejects(
      relayFor(relayStub({ status, body })).relay({
        token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS,
      }),
      (error) => error.code === code && error.status === status,
      `expected HTTP ${status} to surface as ${code}`,
    );
  }
});

test("a transport failure is reported as an UNKNOWN outcome, never as a retry invitation", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub({ fail: new Error("socket hang up") });
  await assert.rejects(
    relayFor(stub).relay({ token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "TRANSPORT_FAILED" && /unknown/i.test(error.message) && /Do not pay again/.test(error.message),
  );
});

test("the relay needs a session and a Gate submission id", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub();
  const relay = relayFor(stub);
  await assert.rejects(
    relay.relay({ publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS }),
    (error) => error.code === "UNAUTHORIZED",
  );
  for (const publicId of [undefined, "AAAA", `${PUBLIC_ID}/../../evil`]) {
    await assert.rejects(
      relay.relay({ token: TOKEN, publicId, prepared, quote, nowSeconds: NOW_SECONDS }),
      (error) => error.code === "INVALID_REQUEST",
    );
  }
  assert.equal(stub.calls.length, 0);
});

test("no key, RPC credential, or advocate content crosses the relay boundary", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub();
  await relayFor(stub).relay({ token: TOKEN, publicId: PUBLIC_ID, prepared, quote, nowSeconds: NOW_SECONDS });

  const serialized = JSON.stringify(stub.calls[0].body);
  for (const secret of ["privateKey", "seed", "mnemonic", "rpc", "apiKey", "pitch", "disclosures", "evidence"]) {
    assert.doesNotMatch(serialized, new RegExp(secret, "i"), `the relay saw ${secret}`);
  }
  // The session token travels in the header to Gate's own origin, as every
  // other Gate call already does — never in the URL or the body.
  assert.doesNotMatch(stub.calls[0].url, /token/i);
  assert.doesNotMatch(serialized, new RegExp(TOKEN, "i"));
});

test("broadcastPayment uses the remote relay when no in-process relayer exists", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub();
  const phases = [];
  const receipt = await broadcastPayment({
    remoteRelay: relayFor(stub),
    session: { token: TOKEN },
    publicId: PUBLIC_ID,
    prepared,
    quote,
    now,
    onPhase: (phase) => phases.push(phase),
  });
  assert.equal(receipt.txHash, TX_HASH);
  assert.equal(receipt.remote, true);
  assert.deepEqual(phases, ["broadcasting", "broadcast"]);
  assert.equal(stub.calls.length, 1);
});

test("the remote relay needs the payer's Gate session", async () => {
  const { quote, prepared } = await preparedFor();
  const stub = relayStub();
  await assert.rejects(
    broadcastPayment({ remoteRelay: relayFor(stub), publicId: PUBLIC_ID, prepared, quote, now }),
    (error) => error.code === "UNAUTHORIZED",
  );
  assert.equal(stub.calls.length, 0);
});

test("GAVEL_GATE_RELAYER_URL fails closed on anything but a public HTTPS origin", () => {
  const base = { GAVEL_GATE_URL: "https://gate.0773h.com" };
  assert.equal(resolveConfig(base).relayerUrl, null);
  assert.equal(resolveConfig({ ...base, GAVEL_GATE_RELAYER_URL: RELAY_ORIGIN }).relayerUrl, RELAY_ORIGIN);

  const refused = [
    "http://relay.0773h.com",
    "https://127.0.0.1:8443",
    "https://10.0.0.5",
    "https://192.168.1.10",
    "https://[::1]",
    "https://localhost",
    "https://relay.local",
    "https://relay.test",
    "https://relay.internal",
    "https://example.com",
    "https://relay.example.com",
    "https://gate.0773h.com/relay",
    "https://user:secret@relay.0773h.com",
    "https://relay.0773h.com?token=x",
    "relay.0773h.com",
    "not a url",
  ];
  for (const value of refused) {
    assert.throws(
      () => resolveConfig({ ...base, GAVEL_GATE_RELAYER_URL: value }),
      (error) => error.code === "INVALID_CONFIG",
      `expected ${value} to be refused`,
    );
  }
});

test("a relay client cannot be built without an origin or a fetch", () => {
  assert.throws(() => createRemoteRelay({}), (error) => error.code === "INVALID_CONFIG");
  assert.throws(() => createRemoteRelay({ relayUrl: RELAY_ORIGIN, fetchImpl: null }),
    (error) => error.code === "INVALID_CONFIG");
});
