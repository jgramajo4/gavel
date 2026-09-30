// Issue 6: wallet-provided signature bytes are bounded at the server.
//
// Everything here runs through the real HTTP server, the real auth service,
// the real profile service, and the real memory store. The only substituted
// boundary is the ERC-1271 `eth_call`, and that substitute does Safe-style
// work (split into 65-byte owner signatures, recover each against the digest,
// require the owner threshold) rather than returning the magic value blindly.
const assert = require("node:assert/strict");
const test = require("node:test");
const { AbiCoder, Wallet, getAddress, recoverAddress } = require("ethers");
const { MAX_WALLET_SIGNATURE_BYTES } = require("@gavel/gate");

const { createAuthService } = require("../src/gate/auth");
const { createGateHttpServer } = require("../src/gate/http");
const { createProfileService } = require("../src/gate/profile-service");
const { MemoryGateStore } = require("../src/gate/store-memory");

const AUDIENCE = "https://gate.example";
const BASE_CHAIN_ID = 8453;
const NOW = 2_000_000_000;
const SAFE = "0x5afe00000000000000000000000000000000cafe";
const BLOB_WALLET = "0xb10b00000000000000000000000000000000b10b";
const OWNERS = [Wallet.createRandom(), Wallet.createRandom()];
// A 2-of-2 Safe whose second owner is itself a contract (a nested 2-of-2 Safe).
const NESTED_SAFE = "0x5afe0000000000000000000000000000000000a1";
const OUTER_SAFE = "0x5afe0000000000000000000000000000000000b2";
const OUTER_EOA_OWNER = Wallet.createRandom();
const hex = (bytes, byte = "ab") => `0x${byte.repeat(bytes)}`;

// The Safe `checkNSignatures` layout, as far as Gate's input shape matters:
// `threshold` 65-byte slots {r, s, v}, owners strictly ascending. v=0 is a
// contract signature: r holds the owner address, s the byte offset of a
// {uint256 length, bytes data} tail appended after the static slots, which is
// handed to that owner's own validator. v=27/28 is plain ECDSA over the digest.
function safeCheckSignatures(digest, signature, owners, threshold, contractValidators) {
  const bytes = Buffer.from(signature.slice(2), "hex");
  if (bytes.length < threshold * 65) return false;
  let last = 0n;
  for (let i = 0; i < threshold; i += 1) {
    const slot = bytes.subarray(i * 65, i * 65 + 65);
    const v = slot[64];
    let owner;
    if (v === 0) {
      owner = getAddress(`0x${slot.subarray(12, 32).toString("hex")}`);
      const offset = Number(BigInt(`0x${slot.subarray(32, 64).toString("hex")}`));
      if (offset < threshold * 65 || offset + 32 > bytes.length) return false; // GS021 / GS022
      const length = Number(BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`));
      if (offset + 32 + length > bytes.length) return false; // GS023
      const validator = contractValidators[owner];
      if (!validator || !validator(`0x${bytes.subarray(offset + 32, offset + 32 + length).toString("hex")}`)) return false;
    } else if (v === 27 || v === 28) {
      owner = recoverAddress(digest, `0x${slot.toString("hex")}`);
    } else {
      return false;
    }
    if (BigInt(owner) <= last || !owners.includes(owner)) return false; // GS026
    last = BigInt(owner);
  }
  return true;
}

function concatenatedOwnersSigned(digest, signature) {
  const body = signature.slice(2);
  if (body.length !== 130 * OWNERS.length) return false;
  const signers = new Set();
  for (let i = 0; i < body.length; i += 130) signers.add(recoverAddress(digest, `0x${body.slice(i, i + 130)}`));
  return OWNERS.every((owner) => signers.has(owner.address));
}

// Build the outer Safe's signature: owners sorted ascending, the EOA owner as a
// plain ECDSA slot, the nested Safe as a v=0 slot pointing at an appended tail.
async function outerSafeSignature(issued) {
  const inner = await Promise.all(OWNERS.map((o) => o.signTypedData(issued.domain, issued.types, issued.message)));
  const innerBytes = Buffer.from(inner.map((sig) => sig.slice(2)).join(""), "hex");
  const eoaSlot = Buffer.from((await OUTER_EOA_OWNER.signTypedData(issued.domain, issued.types, issued.message)).slice(2), "hex");
  const offset = 2 * 65;
  const contractSlot = Buffer.from(AbiCoder.defaultAbiCoder()
    .encode(["address", "uint256"], [NESTED_SAFE, offset]).slice(2) + "00", "hex");
  const ordered = BigInt(OUTER_EOA_OWNER.address) < BigInt(NESTED_SAFE)
    ? [eoaSlot, contractSlot] : [contractSlot, eoaSlot];
  const tail = Buffer.concat([
    Buffer.from(AbiCoder.defaultAbiCoder().encode(["uint256"], [innerBytes.length]).slice(2), "hex"),
    innerBytes,
  ]);
  return `0x${Buffer.concat([...ordered, tail]).toString("hex")}`;
}

function harness() {
  const store = new MemoryGateStore({ clock: () => new Date(NOW * 1000) });
  const verifierCalls = [];
  let nextByte = 0x21;
  // Stand-in for `isValidSignature` on each chain.
  const erc1271 = async ({ wallet, digest, signature, chainId }) => {
    verifierCalls.push({ wallet, chainId, bytes: (signature.length - 2) / 2 });
    if (wallet === SAFE) {
      // Safe threshold 2-of-2: concatenated 65-byte owner ECDSA signatures.
      const body = signature.slice(2);
      if (body.length !== 130 * OWNERS.length) return { code: "0x6000", magicValue: "0xffffffff" };
      const signers = new Set();
      for (let i = 0; i < body.length; i += 130) {
        signers.add(recoverAddress(digest, `0x${body.slice(i, i + 130)}`));
      }
      const ok = OWNERS.every((owner) => signers.has(owner.address));
      return { code: "0x6000", magicValue: ok ? "0x1626ba7e" : "0xffffffff" };
    }
    if (wallet === OUTER_SAFE) {
      const owners = [OUTER_EOA_OWNER.address, NESTED_SAFE].map((a) => getAddress(a));
      const ok = safeCheckSignatures(digest, signature, owners, 2, {
        // The nested Safe validates its own concatenated owner signatures.
        [getAddress(NESTED_SAFE)]: (inner) => concatenatedOwnersSigned(digest, inner),
      });
      return { code: "0x6002", magicValue: ok ? "0x1626ba7e" : "0xffffffff" };
    }
    if (wallet === BLOB_WALLET) {
      // A wallet whose own encoding happens to be exactly the maximum size.
      const ok = signature === hex(MAX_WALLET_SIGNATURE_BYTES, "c3");
      return { code: "0x6001", magicValue: ok ? "0x1626ba7e" : "0xffffffff" };
    }
    return { code: "0x", magicValue: "0x" };
  };
  const authService = createAuthService({
    repository: store, audience: AUDIENCE,
    base: { chainId: BASE_CHAIN_ID, verifier: `0x${"b".repeat(40)}` },
    dao: { chainId: 1, verifier: `0x${"d".repeat(40)}`, dao: "nouns" },
    clock: () => NOW,
    randomBytes: (length) => Buffer.alloc(length, nextByte++),
    chainVerifiers: { 1: erc1271, [BASE_CHAIN_ID]: erc1271 },
  });
  const profileService = createProfileService({
    repository: store, authService, baseChainId: BASE_CHAIN_ID,
    indexClient: { async getVotingPower() { return null; } },
    clock: () => new Date(NOW * 1000),
  });
  const server = createGateHttpServer({ authService, profileService, challengeLimiter: { allow: () => true } });
  return { store, authService, server, verifierCalls };
}

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function post(baseUrl, path, body, { method = "POST", token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

const challenge = (baseUrl, body) => post(baseUrl, "/v1/gate/auth/challenge", body).then((r) => r.body);
const sessionChallenge = (baseUrl, wallet, role) => challenge(baseUrl, { proofType: "WalletSession", wallet, role });
const sessionProof = (issued, signature) => ({
  proofType: "WalletSession",
  typedData: { primaryType: issued.primaryType, domain: issued.domain, message: issued.message },
  signature,
});
const operationProof = (issued, signature) => ({
  typedData: { primaryType: issued.primaryType, domain: issued.domain, message: issued.message },
  signature,
});
const safeSignature = async (issued) => `0x${(await Promise.all(OWNERS.map((owner) =>
  owner.signTypedData(issued.domain, issued.types, issued.message)))).map((s) => s.slice(2)).join("")}`;

const INVALID_SIGNATURE = {
  error: {
    code: "INVALID_SIGNATURE",
    message: `signature must be 0x-prefixed whole-byte hex of at most ${MAX_WALLET_SIGNATURE_BYTES} bytes`,
  },
};

test("the signature ceiling is 8 KiB and fits comfortably under the HTTP body cap", () => {
  const { DEFAULT_MAX_BODY_BYTES } = require("../src/gate/http");
  assert.equal(MAX_WALLET_SIGNATURE_BYTES, 8192);
  // Two proofs of maximum size, hex encoded, plus typed data, stay far below it.
  assert.ok(2 * (2 + MAX_WALLET_SIGNATURE_BYTES * 2) + 8192 < DEFAULT_MAX_BODY_BYTES);
});

test("EOA, Safe-style, and exact-limit ERC-1271 signatures still mint sessions over HTTP", async () => {
  const { server, store, verifierCalls } = harness();
  await withServer(server, async (baseUrl) => {
    // 1. Ordinary 65-byte EOA signature.
    const eoa = Wallet.createRandom();
    const eoaChallenge = await sessionChallenge(baseUrl, eoa.address, "base_sender");
    const eoaSig = await eoa.signTypedData(eoaChallenge.domain, eoaChallenge.types, eoaChallenge.message);
    const eoaResult = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(eoaChallenge, eoaSig));
    assert.equal(eoaResult.status, 200);
    assert.equal(eoaResult.body.session.wallet, eoa.address.toLowerCase());
    assert.equal(eoaResult.body.session.role, "base_sender");
    assert.equal(eoaResult.body.session.chainId, String(BASE_CHAIN_ID));
    assert.equal(verifierCalls.length, 0, "an EOA signature never reaches ERC-1271");

    // 2. Safe-style 130-byte payload: two owner signatures, verified by recovery.
    const safeChallenge = await sessionChallenge(baseUrl, SAFE, "dao_inbox");
    const safeResult = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(safeChallenge, await safeSignature(safeChallenge)));
    assert.equal(safeResult.status, 200);
    assert.equal(safeResult.body.session.wallet, SAFE);
    assert.equal(safeResult.body.session.chainId, "1");
    assert.deepEqual(verifierCalls.at(-1), { wallet: SAFE, chainId: "1", bytes: 130 });

    // 3. A payload of exactly MAX bytes is passed through intact and accepted.
    const blobChallenge = await sessionChallenge(baseUrl, BLOB_WALLET, "dao_profile");
    const atLimit = hex(MAX_WALLET_SIGNATURE_BYTES, "c3");
    const blobResult = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(blobChallenge, atLimit));
    assert.equal(blobResult.status, 200);
    assert.equal(blobResult.body.session.wallet, BLOB_WALLET);
    assert.deepEqual(verifierCalls.at(-1), { wallet: BLOB_WALLET, chainId: "1", bytes: MAX_WALLET_SIGNATURE_BYTES });
    assert.equal((await store.getNonceByHash(blobChallenge.nonceHash)).consumedAt, String(NOW));
  });
});

test("oversized and malformed signatures fail with a fixed 400 before nonce, ECDSA, or ERC-1271 work", async () => {
  const { server, store, verifierCalls } = harness();
  await withServer(server, async (baseUrl) => {
    const issued = await sessionChallenge(baseUrl, BLOB_WALLET, "dao_profile");
    const rejected = [
      hex(MAX_WALLET_SIGNATURE_BYTES + 1, "c3"), // one byte over the limit
      hex(100_000, "c3"), // pathological, but still under the 256 KiB body cap
      "0xabc", // odd length
      `0x${"zz".repeat(65)}`, // not hex
      "ab".repeat(65), // missing 0x
      "",
    ];
    for (const signature of rejected) {
      const result = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(issued, signature));
      assert.equal(result.status, 400, `signature of length ${signature.length}`);
      assert.deepEqual(result.body, INVALID_SIGNATURE);
      assert.ok(result.text.length < 200, "the response never echoes the payload");
    }
    // A non-string signature keeps the existing coarse proof failure.
    assert.equal((await post(baseUrl, "/v1/gate/auth/verify", sessionProof(issued, 12))).status, 401);

    assert.equal(verifierCalls.length, 0, "no ERC-1271 RPC was attempted");
    assert.equal((await store.getNonceByHash(issued.nonceHash)).consumedAt, null, "the nonce survives, so no session was minted");

    // The same unconsumed challenge still succeeds with a legitimate payload.
    const ok = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(issued, hex(MAX_WALLET_SIGNATURE_BYTES, "c3")));
    assert.equal(ok.status, 200);
  });
});

test("the auth service rejects oversized signatures even when HTTP is bypassed entirely", async () => {
  const { authService, store, verifierCalls } = harness();
  const issued = await authService.issueChallenge({ proofType: "WalletSession", wallet: BLOB_WALLET, role: "dao_inbox" });
  await assert.rejects(
    authService.verifyProof(sessionProof(issued, hex(MAX_WALLET_SIGNATURE_BYTES + 1, "c3"))),
    (error) => error.code === "INVALID_SIGNATURE" && !/c3c3/.test(error.message),
  );
  await assert.rejects(
    authService.verifyProfileProofs({
      session: { wallet: BLOB_WALLET, role: "dao_profile", audience: AUDIENCE, chainId: "1" },
      gateEnrollmentProof: operationProof(issued, hex(MAX_WALLET_SIGNATURE_BYTES + 1, "c3")),
      transaction: { getNonceByHash: async () => { throw new Error("nonce must not be read"); } },
    }),
    (error) => error.code === "INVALID_SIGNATURE",
  );
  assert.equal(verifierCalls.length, 0);
  assert.equal((await store.getNonceByHash(issued.nonceHash)).consumedAt, null);
});

test("Safe enrollment with Base payout proof is accepted; an oversized payout proof is refused without side effects", async () => {
  const { server, store, verifierCalls } = harness();
  await withServer(server, async (baseUrl) => {
    const sessionIssued = await sessionChallenge(baseUrl, SAFE, "dao_profile");
    const { body: { token } } = await post(baseUrl, "/v1/gate/auth/verify",
      sessionProof(sessionIssued, await safeSignature(sessionIssued)));
    const enrollmentChallenge = () => challenge(baseUrl, {
      proofType: "GateEnrollment", wallet: SAFE, availability: "accepting_now", dao: "nouns", daoChainId: 1,
      acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
    });
    const payoutChallenge = () => challenge(baseUrl, { proofType: "BasePayoutControl", wallet: SAFE, dao: "nouns" });

    // Oversized Base payout proof alongside a legitimate enrollment proof.
    const enrollment = await enrollmentChallenge();
    const payout = await payoutChallenge();
    const callsBefore = verifierCalls.length;
    const refused = await post(baseUrl, "/v1/gate/me/profile", {
      gateEnrollmentProof: operationProof(enrollment, await safeSignature(enrollment)),
      basePayoutControlProof: operationProof(payout, hex(MAX_WALLET_SIGNATURE_BYTES + 1)),
    }, { method: "PUT", token });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, INVALID_SIGNATURE);
    assert.equal(verifierCalls.length, callsBefore, "neither proof reached ERC-1271");
    assert.equal((await store.getNonceByHash(enrollment.nonceHash)).consumedAt, null);
    assert.equal((await store.getNonceByHash(payout.nonceHash)).consumedAt, null);
    assert.equal(await store.getProfileByWallet(SAFE), null);

    // Oversized enrollment proof is refused the same way.
    const oversizedEnrollment = await post(baseUrl, "/v1/gate/me/profile", {
      gateEnrollmentProof: operationProof(enrollment, hex(MAX_WALLET_SIGNATURE_BYTES + 1)),
    }, { method: "PUT", token });
    assert.equal(oversizedEnrollment.status, 400);
    assert.deepEqual(oversizedEnrollment.body, INVALID_SIGNATURE);

    // The same Safe, with real owner signatures on both chains, enrolls.
    const accepted = await post(baseUrl, "/v1/gate/me/profile", {
      gateEnrollmentProof: operationProof(enrollment, await safeSignature(enrollment)),
      basePayoutControlProof: operationProof(payout, await safeSignature(payout)),
    }, { method: "PUT", token });
    assert.equal(accepted.status, 200);
    const persisted = await store.getProfileByWallet(SAFE);
    assert.equal(persisted.walletKind, "contract");
    assert.deepEqual(verifierCalls.slice(-2).map(({ chainId }) => chainId), ["1", String(BASE_CHAIN_ID)]);
  });
});

test("wallet authority is unchanged: a well-formed signature by the wrong key is still rejected", async () => {
  const { server, store } = harness();
  await withServer(server, async (baseUrl) => {
    const owner = Wallet.createRandom();
    const intruder = Wallet.createRandom();
    const issued = await sessionChallenge(baseUrl, owner.address, "base_sender");
    const forged = await intruder.signTypedData(issued.domain, issued.types, issued.message);
    const result = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(issued, forged));
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, "INVALID_AUTH_PROOF");

    // A Safe signed by only one owner is also refused (threshold not met).
    const safeIssued = await sessionChallenge(baseUrl, SAFE, "dao_inbox");
    const one = await OWNERS[0].signTypedData(safeIssued.domain, safeIssued.types, safeIssued.message);
    assert.equal((await post(baseUrl, "/v1/gate/auth/verify", sessionProof(safeIssued, one))).status, 401);
    assert.equal((await store.getNonceByHash(issued.nonceHash)).consumedAt, null);
    assert.equal((await store.getNonceByHash(safeIssued.nonceHash)).consumedAt, null);
  });
});

test("a Safe with a contract owner (v=0 slot + appended dynamic signature) is accepted under the ceiling", async () => {
  const { server, store, verifierCalls } = harness();
  await withServer(server, async (baseUrl) => {
    const issued = await sessionChallenge(baseUrl, OUTER_SAFE, "dao_profile");
    const signature = await outerSafeSignature(issued);
    const bytes = (signature.length - 2) / 2;
    // 2 static slots (130) + length word (32) + nested 2-of-2 owner signatures (130).
    assert.equal(bytes, 292);
    assert.ok(bytes !== 65 && bytes < MAX_WALLET_SIGNATURE_BYTES);

    const result = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(issued, signature));
    assert.equal(result.status, 200);
    assert.equal(result.body.session.wallet, OUTER_SAFE);
    assert.deepEqual(verifierCalls.at(-1), { wallet: OUTER_SAFE, chainId: "1", bytes: 292 });
    assert.equal((await store.getNonceByHash(issued.nonceHash)).consumedAt, String(NOW));

    // The fixture is load-bearing: a tampered dynamic tail is refused by the
    // Safe-style validator, so acceptance above was not a rubber stamp.
    const again = await sessionChallenge(baseUrl, OUTER_SAFE, "dao_profile");
    const good = await outerSafeSignature(again);
    // Flip one byte inside the nested owner's `r` (tail offset 130 + 32-byte
    // length word + 5), never the `v` byte, so the change is always material.
    const at = 2 + (130 + 32 + 5) * 2;
    const flipped = (parseInt(good.slice(at, at + 2), 16) ^ 0xff).toString(16).padStart(2, "0");
    const tampered = `${good.slice(0, at)}${flipped}${good.slice(at + 2)}`;
    const refused = await post(baseUrl, "/v1/gate/auth/verify", sessionProof(again, tampered));
    assert.equal(refused.status, 401);
    assert.equal((await store.getNonceByHash(again.nonceHash)).consumedAt, null);
  });
});
