"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TypedDataEncoder, verifyTypedData } = require("ethers");

const { createGateApi } = require("../src/gate-api");
const { openBaseSenderSession } = require("../src/session");
const { PAYER, createFetchStub, createWalletStub } = require("./helpers");

const AUDIENCE = "gate.local";
const BASE_VERIFIER = "0x0000000000000000000000000000000000000B45";

function challenge(overrides = {}) {
  const message = {
    wallet: PAYER,
    role: "base_sender",
    audience: AUDIENCE,
    purpose: "gavel-gate-wallet-session",
    nonce: `0x${"7e".repeat(32)}`,
    issuedAt: "1800000000",
    expiry: "1800000300",
    version: "1",
    ...(overrides.message || {}),
  };
  return {
    proofType: "WalletSession",
    primaryType: "WalletSession",
    domain: { name: "GavelGate", version: "1", chainId: 8453, verifyingContract: BASE_VERIFIER },
    types: {
      WalletSession: [
        { name: "wallet", type: "address" },
        { name: "role", type: "string" },
        { name: "audience", type: "string" },
        { name: "purpose", type: "string" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "version", type: "string" },
      ],
    },
    message,
    nonceHash: `0x${"5a".repeat(32)}`,
    payloadHash: `0x${"5b".repeat(32)}`,
    ...overrides.top,
  };
}

function gateFor({ challengeBody = challenge(), verifyBody, verifyStatus = 200 } = {}) {
  const verified = verifyBody ?? {
    token: "T".repeat(43),
    session: { wallet: PAYER.toLowerCase(), role: "base_sender", chainId: "8453", audience: AUDIENCE,
      issuedAt: "1800000000", expiry: "1800000900" },
  };
  const { fetchImpl, calls } = createFetchStub([
    { match: (url) => url.endsWith("/v1/gate/auth/challenge"), status: 200, body: challengeBody },
    { match: (url) => url.endsWith("/v1/gate/auth/verify"), status: verifyStatus, body: verified },
  ]);
  return { api: createGateApi({ baseUrl: "https://gate.test", fetchImpl }), calls };
}

test("the payer authenticates on Gate's existing base_sender WalletSession path", async () => {
  const { api, calls } = gateFor();
  const { wallet, calls: walletCalls } = createWalletStub();
  const session = await openBaseSenderSession({ gateApi: api, wallet });

  assert.equal(session.session.role, "base_sender");
  assert.equal(session.token, "T".repeat(43));
  assert.equal(session.account, PAYER);

  const challengeBody = JSON.parse(calls[0].body);
  assert.deepEqual(challengeBody, { proofType: "WalletSession", wallet: PAYER, role: "base_sender" });

  // The verify body is Gate's exact contract: three typed-data fields plus the signature.
  const verifyBody = JSON.parse(calls[1].body);
  assert.deepEqual(Object.keys(verifyBody).sort(), ["proofType", "signature", "typedData"]);
  assert.deepEqual(Object.keys(verifyBody.typedData).sort(), ["domain", "message", "primaryType"]);
  assert.equal(walletCalls.signTypedData.length, 1);
});

test("the wallet signs Gate's typed data unchanged", async () => {
  const { api } = gateFor();
  const { wallet, calls: walletCalls } = createWalletStub();
  await openBaseSenderSession({ gateApi: api, wallet });

  const issued = challenge();
  const [signed] = walletCalls.signTypedData;
  assert.deepEqual(signed.domain, issued.domain);
  assert.deepEqual(signed.types, issued.types);
  assert.deepEqual(signed.message, issued.message);
  assert.equal(
    TypedDataEncoder.hash(signed.domain, signed.types, signed.message),
    TypedDataEncoder.hash(issued.domain, issued.types, issued.message),
  );
});

test("the signature recovers to the payer wallet", async () => {
  const { api, calls } = gateFor();
  const { wallet } = createWalletStub();
  await openBaseSenderSession({ gateApi: api, wallet });

  const verifyBody = JSON.parse(calls[1].body);
  const issued = challenge();
  assert.equal(
    verifyTypedData(verifyBody.typedData.domain, issued.types, verifyBody.typedData.message, verifyBody.signature),
    PAYER,
  );
});

test("a challenge for another wallet or role is refused before signing", async () => {
  for (const overrides of [{ message: { wallet: `0x${"9".repeat(40)}` } }, { message: { role: "dao_inbox" } }]) {
    const { api } = gateFor({ challengeBody: challenge(overrides) });
    const { wallet, calls: walletCalls } = createWalletStub();
    await assert.rejects(
      openBaseSenderSession({ gateApi: api, wallet }),
      (error) => error.code === "INVALID_AUTH_CHALLENGE",
    );
    assert.equal(walletCalls.signTypedData.length, 0);
  }
});

test("a session issued for another role is refused", async () => {
  const { api } = gateFor({
    verifyBody: { token: "T".repeat(43), session: { wallet: PAYER.toLowerCase(), role: "dao_inbox" } },
  });
  const { wallet } = createWalletStub();
  await assert.rejects(
    openBaseSenderSession({ gateApi: api, wallet }),
    (error) => error.code === "INVALID_AUTH_PROOF" && /base_sender/.test(error.message),
  );
});

test("a rejected proof surfaces Gate's coarse failure and no token", async () => {
  const { api } = gateFor({ verifyStatus: 401, verifyBody: { error: { code: "INVALID_AUTH_PROOF", message: "bad" } } });
  const { wallet } = createWalletStub();
  await assert.rejects(
    openBaseSenderSession({ gateApi: api, wallet }),
    (error) => error.code === "INVALID_AUTH_PROOF" && !/T{10}/.test(error.message),
  );
});

test("the session token travels only in the Authorization header", async () => {
  const { api, calls } = gateFor();
  const { wallet } = createWalletStub();
  const session = await openBaseSenderSession({ gateApi: api, wallet });
  await api.getStatus("A".repeat(22)).catch(() => {});

  for (const call of calls) {
    assert.doesNotMatch(call.url, new RegExp(session.token));
    assert.ok(!String(call.body ?? "").includes(session.token));
  }
});
