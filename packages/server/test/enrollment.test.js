const assert = require("node:assert/strict");
const test = require("node:test");
const { Wallet, TypedDataEncoder, keccak256 } = require("ethers");
const { hashTypedDataPayload } = require("@gavel/gate");

const {
  AUTH_TYPES,
  AuthRequestError,
  MemoryAuthRepository,
  createAuthService,
} = require("../src/gate/auth");

const BASE_VERIFIER = `0x${"b".repeat(40)}`;
const DAO_VERIFIER = `0x${"d".repeat(40)}`;
const AUDIENCE = "https://gate.example";
const NOW = 2_000_000_000;

function deterministicBytes(byte) {
  let next = byte;
  return (length) => {
    const value = Buffer.alloc(length, next);
    next = (next + 1) & 0xff;
    return value;
  };
}

function makeHarness(overrides = {}) {
  const repository = overrides.repository || new MemoryAuthRepository();
  const service = createAuthService({
    repository,
    audience: AUDIENCE,
    base: { chainId: 8453, verifier: BASE_VERIFIER },
    dao: { chainId: 1, verifier: DAO_VERIFIER, dao: "nouns" },
    clock: () => NOW,
    randomBytes: deterministicBytes(0x11),
    ...overrides,
  });
  return { repository, service };
}

function operationProof(challenge, signature, typedData = {}) {
  return {
    typedData: {
      primaryType: challenge.primaryType,
      domain: challenge.domain,
      message: challenge.message,
      ...typedData,
    },
    signature,
  };
}

function walletSessionProof(challenge, signature, overrides = {}) {
  return {
    proofType: "WalletSession",
    typedData: {
      primaryType: "WalletSession",
      domain: challenge.domain,
      message: challenge.message,
      ...(overrides.typedData || {}),
    },
    signature,
    ...(overrides.proof || {}),
  };
}

test("WalletSession challenge freezes ordered fields and exact persisted binding", async () => {
  const wallet = Wallet.createRandom().address;
  const { repository, service } = makeHarness();

  const challenge = await service.issueChallenge({ proofType: "WalletSession", wallet, role: "dao_profile" });

  assert.deepEqual(challenge.types.WalletSession, [
    { name: "wallet", type: "address" },
    { name: "role", type: "string" },
    { name: "audience", type: "string" },
    { name: "purpose", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "version", type: "uint256" },
  ]);
  assert.deepEqual(challenge.domain, {
    name: "GavelGate", version: "1", chainId: 1, verifyingContract: DAO_VERIFIER,
  });
  assert.deepEqual(challenge.message, {
    wallet,
    role: "dao_profile",
    audience: AUDIENCE,
    purpose: "wallet_session",
    nonce: `0x${"11".repeat(32)}`,
    issuedAt: String(NOW),
    expiry: String(NOW + 300),
    version: "1",
  });
  assert.equal(challenge.payloadHash, hashTypedDataPayload(challenge));
  const row = await repository.getNonceByHash(challenge.nonceHash);
  assert.deepEqual(row, {
    proofType: "WalletSession",
    purpose: "wallet_session",
    role: "dao_profile",
    wallet: wallet.toLowerCase(),
    audience: AUDIENCE,
    chainId: "1",
    verifier: DAO_VERIFIER,
    nonceHash: challenge.nonceHash,
    payloadHash: challenge.payloadHash,
    issuedAt: String(NOW),
    expiry: String(NOW + 300),
    consumedAt: null,
  });
  assert.deepEqual(AUTH_TYPES.WalletSession, challenge.types.WalletSession);
});

test("challenge issues only the three exact proof schemas and rejects domain or purpose overrides", async () => {
  const wallet = Wallet.createRandom().address;
  const { repository, service } = makeHarness();
  const enrollment = await service.issueChallenge({
    proofType: "GateEnrollment", wallet, availability: "accepting_now", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  assert.deepEqual(Object.keys(enrollment.message), AUTH_TYPES.GateEnrollment.map(({ name }) => name));
  assert.equal(enrollment.message.purpose, "enrollment");
  assert.equal(enrollment.message.daoChainId, "1");
  assert.equal(enrollment.domain.chainId, 1);

  const payout = await service.issueChallenge({ proofType: "BasePayoutControl", wallet, dao: "nouns" });
  assert.deepEqual(Object.keys(payout.message), AUTH_TYPES.BasePayoutControl.map(({ name }) => name));
  assert.equal(payout.message.purpose, "base_payout_control");
  assert.equal(payout.domain.chainId, 8453);

  for (const input of [
    { proofType: "Unknown", wallet },
    { proofType: "WalletSession", wallet, role: "admin" },
    { proofType: "WalletSession", wallet, role: "dao_profile", chainId: 8453 },
    { proofType: "WalletSession", wallet, role: "dao_profile", verifier: BASE_VERIFIER },
    { proofType: "WalletSession", wallet, role: "dao_profile", purpose: "enrollment" },
    { proofType: "WalletSession", wallet, role: "dao_profile", payoutWallet: wallet },
    { proofType: "GateEnrollment", wallet, availability: "paused", dao: "nouns", daoChainId: 1,
      acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000", purpose: "wallet_session" },
  ]) await assert.rejects(service.issueChallenge(input));

  assert.equal((await repository.listNonces()).length, 2);
  assert.throws(() => makeHarness({ challengeLifetimeSeconds: 601 }), /maximum/i);
});

test("GateEnrollment challenge requires a canonical decimal attention amount string", async () => {
  const wallet = Wallet.createRandom().address;
  const { repository, service } = makeHarness();
  for (const attentionAmount of [1000000, "01000000", "+1000000", "1000000.0", " 1000000"]) {
    await assert.rejects(service.issueChallenge({
      proofType: "GateEnrollment", wallet, availability: "paused", dao: "nouns", daoChainId: 1,
      acceptPreVote: false, acceptVoting: true, attentionAmount,
    }));
  }
  assert.equal((await repository.listNonces()).length, 0);
});

test("GateEnrollment challenge rejects zero accepted stages before persisting a nonce", async () => {
  const wallet = Wallet.createRandom().address;
  const { repository, service } = makeHarness();

  await assert.rejects(service.issueChallenge({
    proofType: "GateEnrollment", wallet, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: false, attentionAmount: "1000000",
  }), /VOTING|stages/i);

  assert.deepEqual(await repository.listNonces(), []);
});

test("auth service requires the canonical Nouns DAO literal on Ethereum mainnet", () => {
  assert.throws(() => makeHarness({
    dao: { chainId: 5, verifier: DAO_VERIFIER, dao: "nouns" },
  }), /Nouns.*chain 1/i);
  assert.throws(() => makeHarness({
    dao: { chainId: 1, verifier: DAO_VERIFIER, dao: "Nouns" },
  }), /canonical Nouns/i);
});

test("EOA WalletSession verification atomically consumes the nonce and mints an opaque bound session", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();
  const challenge = await service.issueChallenge({ proofType: "WalletSession", wallet: signer.address, role: "base_sender" });
  const signature = await signer.signTypedData(challenge.domain, challenge.types, challenge.message);

  const result = await service.verifyProof(walletSessionProof(challenge, signature));

  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(result.session, {
    wallet: signer.address.toLowerCase(), role: "base_sender", chainId: "8453", audience: AUDIENCE,
    issuedAt: String(NOW), expiry: String(NOW + 900),
  });
  const nonce = await repository.getNonceByHash(challenge.nonceHash);
  assert.equal(nonce.consumedAt, String(NOW));
  assert.deepEqual(await service.authenticateSession(result.token, { role: "base_sender", audience: AUDIENCE }), result.session);
  const [storedSession] = await repository.listSessions();
  assert.equal("token" in storedSession, false);
  assert.match(storedSession.tokenHash, /^0x[0-9a-f]{64}$/);
});

test("WalletSession verification persists through one combined repository operation", async () => {
  const signer = Wallet.createRandom();
  const backing = new MemoryAuthRepository();
  let combinedCalls = 0;
  const repository = {
    insertNonce: (...args) => backing.insertNonce(...args),
    getSessionByTokenHash: (...args) => backing.getSessionByTokenHash(...args),
    transaction: (callback) => backing.transaction((transaction) => callback({
      getNonceByHash: transaction.getNonceByHash,
      consumeAuthNonceAndInsertSession: async (input) => {
        combinedCalls += 1;
        return transaction.consumeAuthNonceAndInsertSession(input);
      },
    })),
  };
  const { service } = makeHarness({ repository });
  const challenge = await service.issueChallenge({ proofType: "WalletSession", wallet: signer.address, role: "base_sender" });
  const signature = await signer.signTypedData(challenge.domain, challenge.types, challenge.message);

  await service.verifyProof(walletSessionProof(challenge, signature));

  assert.equal(combinedCalls, 1);
  assert.equal((await backing.getNonceByHash(challenge.nonceHash)).consumedAt, String(NOW));
  assert.equal((await backing.listSessions()).length, 1);
});

test("WalletSession verification accepts only the exact documented request shape", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();

  async function fresh() {
    const challenge = await service.issueChallenge({
      proofType: "WalletSession", wallet: signer.address, role: "dao_profile",
    });
    const signature = await signer.signTypedData(challenge.domain, challenge.types, challenge.message);
    return { challenge, signature };
  }

  for (const malformed of [
    ({ challenge, signature }) => ({ ...challenge, signature }),
    ({ challenge, signature }) => walletSessionProof(challenge, signature, {
      typedData: { primaryType: "GateEnrollment" },
    }),
    ({ challenge, signature }) => walletSessionProof(challenge, signature, {
      proof: { proofType: "GateEnrollment" },
    }),
    ({ challenge, signature }) => walletSessionProof(challenge, signature, {
      typedData: { types: challenge.types },
    }),
    ({ challenge, signature }) => walletSessionProof(challenge, signature, {
      proof: { nonceHash: challenge.nonceHash },
    }),
  ]) {
    const value = await fresh();
    await assert.rejects(service.verifyProof(malformed(value)), AuthRequestError);
    assert.equal((await repository.getNonceByHash(value.challenge.nonceHash)).consumedAt, null);
    assert.equal((await repository.listSessions()).length, 0);
  }

  const valid = await fresh();
  const result = await service.verifyProof(walletSessionProof(valid.challenge, valid.signature));
  assert.equal(result.session.wallet, signer.address.toLowerCase());
  assert.equal((await repository.getNonceByHash(valid.challenge.nonceHash)).consumedAt, String(NOW));
  assert.equal((await repository.listSessions()).length, 1);
});

test("mutations, same-chain role substitution, other types, and replay fail without extra consumption or sessions", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();

  async function fresh(role = "dao_profile") {
    const challenge = await service.issueChallenge({ proofType: "WalletSession", wallet: signer.address, role });
    return { challenge, signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message) };
  }

  const attacks = [
    async ({ challenge }) => ({ ...challenge, message: { ...challenge.message, role: "dao_inbox" } }),
    async ({ challenge }) => ({ ...challenge, message: { ...challenge.message, audience: "https://evil.example" } }),
    async ({ challenge }) => ({ ...challenge, message: { ...challenge.message, purpose: "enrollment" } }),
    async ({ challenge }) => ({ ...challenge, message: { ...challenge.message, version: "2" } }),
    async ({ challenge }) => ({ ...challenge, message: { ...challenge.message, version: 1 } }),
    async ({ challenge }) => ({ ...challenge, message: { ...challenge.message, issuedAt: NOW } }),
    async ({ challenge }) => ({ ...challenge, message: { ...challenge.message, expiry: String(NOW + 299) } }),
    async ({ challenge }) => ({ ...challenge, domain: { ...challenge.domain, chainId: 8453 } }),
    async ({ challenge }) => ({ ...challenge, domain: { ...challenge.domain, chainId: "1" } }),
    async ({ challenge }) => ({ ...challenge, domain: { ...challenge.domain, verifyingContract: BASE_VERIFIER } }),
  ];
  for (const mutate of attacks) {
    const valid = await fresh();
    const attacked = await mutate(valid);
    attacked.signature = await signer.signTypedData(attacked.domain, attacked.types, attacked.message);
    await assert.rejects(service.verifyProof(walletSessionProof(attacked, attacked.signature)));
    assert.equal((await repository.getNonceByHash(valid.challenge.nonceHash)).consumedAt, null);
  }

  const wrongSigner = await fresh();
  wrongSigner.signature = await Wallet.createRandom().signTypedData(
    wrongSigner.challenge.domain, wrongSigner.challenge.types, wrongSigner.challenge.message,
  );
  await assert.rejects(service.verifyProof(walletSessionProof(wrongSigner.challenge, wrongSigner.signature)));
  assert.equal((await repository.getNonceByHash(wrongSigner.challenge.nonceHash)).consumedAt, null);

  const operationProof = await service.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const operationSignature = await signer.signTypedData(operationProof.domain, operationProof.types, operationProof.message);
  await assert.rejects(service.verifyProof({
    ...walletSessionProof(operationProof, operationSignature, {
      typedData: { primaryType: operationProof.primaryType },
    }),
    proofType: operationProof.proofType,
  }), /WalletSession only/);
  assert.equal((await repository.getNonceByHash(operationProof.nonceHash)).consumedAt, null);

  const valid = await fresh("base_sender");
  await service.verifyProof(walletSessionProof(valid.challenge, valid.signature));
  await assert.rejects(service.verifyProof(walletSessionProof(valid.challenge, valid.signature)));
  assert.equal((await repository.listSessions()).length, 1);
});

test("ERC-1271 verification is role-chain-specific, bounded, and requires deployed code plus exact magic", async () => {
  const contractWallet = Wallet.createRandom().address;
  const calls = [];
  const chainVerifiers = {
    1: async (request) => {
      calls.push(request);
      return { code: "0x6000", magicValue: "0x1626ba7e" };
    },
    8453: async () => { throw new Error("wrong chain verifier called"); },
  };
  const { repository, service } = makeHarness({ chainVerifiers, contractVerificationTimeoutMs: 20 });
  const challenge = await service.issueChallenge({ proofType: "WalletSession", wallet: contractWallet, role: "dao_inbox" });
  const result = await service.verifyProof(walletSessionProof(challenge, "0x1234"));
  assert.equal(result.session.wallet, contractWallet.toLowerCase());
  assert.deepEqual(calls, [{
    wallet: contractWallet.toLowerCase(),
    digest: TypedDataEncoder.hash(challenge.domain, challenge.types, challenge.message),
    signature: "0x1234",
    chainId: "1",
    verifier: DAO_VERIFIER,
  }]);

  for (const chainVerifier of [
    async () => ({ code: "0x6000", magicValue: "0xffffffff" }),
    async () => ({ code: "0x", magicValue: "0x1626ba7e" }),
    async () => ({ code: null, magicValue: "0x1626ba7e" }),
    async () => { throw new Error("RPC reverted"); },
    async () => new Promise(() => {}),
  ]) {
    const failed = makeHarness({ chainVerifiers: { 1: chainVerifier }, contractVerificationTimeoutMs: 5 });
    const proof = await failed.service.issueChallenge({ proofType: "WalletSession", wallet: contractWallet, role: "dao_profile" });
    await assert.rejects(failed.service.verifyProof(walletSessionProof(proof, "0x1234")), /invalid|unavailable/i);
    assert.equal((await failed.repository.getNonceByHash(proof.nonceHash)).consumedAt, null);
    assert.equal((await failed.repository.listSessions()).length, 0);
  }
  assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, String(NOW));
});

test("nonce-row mismatch and session-write failure roll back, while concurrent replay has one winner", async () => {
  const signer = Wallet.createRandom();
  const backing = new MemoryAuthRepository();
  const mismatchedRepository = {
    insertNonce: (...args) => backing.insertNonce(...args),
    getSessionByTokenHash: (...args) => backing.getSessionByTokenHash(...args),
    transaction: (callback) => backing.transaction((transaction) => callback({
      ...transaction,
      getNonceByHash: async (hash) => ({ ...(await transaction.getNonceByHash(hash)), role: "dao_inbox" }),
    })),
  };
  const mismatch = makeHarness({ repository: mismatchedRepository });
  const mismatchProof = await mismatch.service.issueChallenge({
    proofType: "WalletSession", wallet: signer.address, role: "dao_profile",
  });
  const mismatchSignature = await signer.signTypedData(mismatchProof.domain, mismatchProof.types, mismatchProof.message);
  await assert.rejects(mismatch.service.verifyProof(walletSessionProof(mismatchProof, mismatchSignature)));
  assert.equal((await backing.getNonceByHash(mismatchProof.nonceHash)).consumedAt, null);

  const failedBacking = new MemoryAuthRepository();
  const failingRepository = {
    insertNonce: (...args) => failedBacking.insertNonce(...args),
    getSessionByTokenHash: (...args) => failedBacking.getSessionByTokenHash(...args),
    transaction: (callback) => failedBacking.transaction((transaction) => callback({
      ...transaction,
      consumeAuthNonceAndInsertSession: async () => { throw new Error("injected session write failure"); },
    })),
  };
  const failed = makeHarness({ repository: failingRepository });
  const failedProof = await failed.service.issueChallenge({ proofType: "WalletSession", wallet: signer.address, role: "base_sender" });
  const failedSignature = await signer.signTypedData(failedProof.domain, failedProof.types, failedProof.message);
  await assert.rejects(failed.service.verifyProof(walletSessionProof(failedProof, failedSignature)), /injected session write failure/);
  assert.equal((await failedBacking.getNonceByHash(failedProof.nonceHash)).consumedAt, null);
  assert.equal((await failedBacking.listSessions()).length, 0);

  const concurrent = makeHarness();
  const proof = await concurrent.service.issueChallenge({ proofType: "WalletSession", wallet: signer.address, role: "base_sender" });
  const signature = await signer.signTypedData(proof.domain, proof.types, proof.message);
  const outcomes = await Promise.allSettled([
    concurrent.service.verifyProof(walletSessionProof(proof, signature)),
    concurrent.service.verifyProof(walletSessionProof(proof, signature)),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  assert.equal((await concurrent.repository.listSessions()).length, 1);
});

test("profile integration verifies operation proofs without consuming until the caller transaction commits consumption", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();
  const challenge = await service.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const gateEnrollmentProof = operationProof(
    challenge,
    await signer.signTypedData(challenge.domain, challenge.types, challenge.message),
  );

  const verified = await repository.transaction(async (transaction) => {
    const result = await service.verifyProfileProofs({
      session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof,
      transaction,
    });
    assert.equal((await transaction.getNonceByHash(challenge.nonceHash)).consumedAt, null);
    await service.consumeProfileProofs({ ...result, transaction });
    return result;
  });

  assert.deepEqual(verified, {
    wallet: signer.address.toLowerCase(), walletKind: "eoa", proofIds: [challenge.nonceHash],
  });
  assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, String(NOW));
});

test("profile verification accepts the documented operation proof typedData shape", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();
  const challenge = await service.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const gateEnrollmentProof = operationProof(
    challenge,
    await signer.signTypedData(challenge.domain, challenge.types, challenge.message),
  );

  await repository.transaction(async (transaction) => {
    const verified = await service.verifyProfileProofs({
      session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof,
      transaction,
    });
    assert.deepEqual(verified, {
      wallet: signer.address.toLowerCase(), walletKind: "eoa", proofIds: [challenge.nonceHash],
    });
  });
  assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, null);
});

test("operation proofs reject ambiguous challenge artifacts with a stable client-safe classification", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();
  const challenge = await service.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const signature = await signer.signTypedData(challenge.domain, challenge.types, challenge.message);

  for (const artifact of [
    { proofType: "GateEnrollment" }, { types: challenge.types },
    { nonceHash: challenge.nonceHash }, { payloadHash: challenge.payloadHash },
  ]) {
    await repository.transaction(async (transaction) => {
      await assert.rejects(service.verifyProfileProofs({
        session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: AUDIENCE },
        gateEnrollmentProof: operationProof(challenge, signature, artifact),
        transaction,
      }), (error) => {
        assert.ok(error instanceof AuthRequestError);
        assert.equal(error.code, "INVALID_AUTH_PROOF");
        return true;
      });
    });
    assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, null);
  }
});

test("malformed operation proof values use the stable client-safe error classification", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();
  const challenge = await service.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const gateEnrollmentProof = operationProof(
    challenge,
    await signer.signTypedData(challenge.domain, challenge.types, challenge.message),
    { domain: { ...challenge.domain, verifyingContract: "not-an-address" } },
  );

  await repository.transaction(async (transaction) => {
    await assert.rejects(service.verifyProfileProofs({
      session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof,
      transaction,
    }), (error) => error instanceof AuthRequestError && error.code === "INVALID_AUTH_PROOF");
  });
  assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, null);
});

test("operation proofs reject noncanonical decimal representations without consuming the nonce", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();
  const challenge = await service.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const signature = await signer.signTypedData(challenge.domain, challenge.types, challenge.message);
  const mutations = [
    { daoChainId: 1 }, { daoChainId: "01" },
    { attentionAmount: 1000000 }, { attentionAmount: "01000000" },
    { issuedAt: NOW }, { issuedAt: `0${NOW}` },
    { expiry: NOW + 300 }, { expiry: `0${NOW + 300}` },
    { version: 1 }, { version: "01" },
  ];

  const typedDataMutations = [
    ...mutations.map((mutation) => ({ message: { ...challenge.message, ...mutation } })),
    { domain: { ...challenge.domain, chainId: "1" } },
    { domain: { ...challenge.domain, chainId: "01" } },
  ];
  for (const typedData of typedDataMutations) {
    const gateEnrollmentProof = operationProof(challenge, signature, typedData);
    await repository.transaction(async (transaction) => {
      await assert.rejects(service.verifyProfileProofs({
        session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: AUDIENCE },
        gateEnrollmentProof,
        transaction,
      }));
    });
    assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, null);
  }
});

test("operation proofs reject mutated persisted bindings and mismatched profile sessions without consumption", async () => {
  const signer = Wallet.createRandom();
  const { repository, service } = makeHarness();
  const challenge = await service.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const mutated = { ...challenge, message: { ...challenge.message, availability: "closed" } };
  const gateEnrollmentProof = operationProof(
    mutated,
    await signer.signTypedData(mutated.domain, mutated.types, mutated.message),
  );

  await repository.transaction(async (transaction) => {
    await assert.rejects(service.verifyProfileProofs({
      session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof,
      transaction,
    }), /unavailable|binding/i);
  });
  assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, null);

  const exactProof = operationProof(
    challenge,
    await signer.signTypedData(challenge.domain, challenge.types, challenge.message),
  );
  await repository.transaction(async (transaction) => {
    await assert.rejects(service.verifyProfileProofs({
      session: { wallet: signer.address, role: "dao_inbox", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof: exactProof,
      transaction,
    }), /dao_profile|session/i);
  });
  assert.equal((await repository.getNonceByHash(challenge.nonceHash)).consumedAt, null);
});

test("existing contract profile can make a non-accepting update without Base proof", async () => {
  const wallet = Wallet.createRandom().address;
  const calls = [];
  const { repository, service } = makeHarness({
    chainVerifiers: {
      1: async (request) => { calls.push(request); return { code: "0x6000", magicValue: "0x1626ba7e" }; },
      8453: async () => { throw new Error("Base verifier must not be called"); },
    },
  });
  const enrollment = await service.issueChallenge({
    proofType: "GateEnrollment", wallet, availability: "closed", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  await repository.transaction(async (transaction) => {
    const verified = await service.verifyProfileProofs({
      session: { wallet, role: "dao_profile", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof: operationProof(enrollment, "0x1234"),
      existingProfile: { wallet: wallet.toLowerCase(), walletKind: "contract", availability: "paused" },
      transaction,
    });
    assert.deepEqual(verified, {
      wallet: wallet.toLowerCase(), walletKind: "contract", proofIds: [enrollment.nonceHash],
    });
  });
  assert.deepEqual(calls.map(({ chainId }) => chainId), ["1"]);
});

test("contract profile authority requires separate ERC-1271 proofs on the DAO and Base chains", async () => {
  const wallet = Wallet.createRandom().address;
  const calls = [];
  const { repository, service } = makeHarness({
    chainVerifiers: {
      1: async (request) => { calls.push(request); return { code: "0x6000", magicValue: "0x1626ba7e" }; },
      8453: async (request) => { calls.push(request); return { code: "0x6001", magicValue: "0x1626ba7e" }; },
    },
  });
  const enrollment = await service.issueChallenge({
    proofType: "GateEnrollment", wallet, availability: "accepting_now", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const payout = await service.issueChallenge({ proofType: "BasePayoutControl", wallet, dao: "nouns" });
  const gateEnrollmentProof = operationProof(enrollment, "0x1234");

  await repository.transaction(async (transaction) => {
    await assert.rejects(service.verifyProfileProofs({
      session: { wallet, role: "dao_profile", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof,
      transaction,
    }), /BasePayoutControl proof is required/);
  });
  assert.equal((await repository.getNonceByHash(enrollment.nonceHash)).consumedAt, null);

  await repository.transaction(async (transaction) => {
    const verified = await service.verifyProfileProofs({
      session: { wallet, role: "dao_profile", chainId: "1", audience: AUDIENCE },
      gateEnrollmentProof,
      basePayoutControlProof: operationProof(payout, "0x5678"),
      transaction,
    });
    assert.deepEqual(verified, {
      wallet: wallet.toLowerCase(), walletKind: "contract", proofIds: [enrollment.nonceHash, payout.nonceHash],
      basePayoutChainId: "8453",
      basePayoutCodeHash: keccak256("0x6001"),
    });
    await service.consumeProfileProofs({ ...verified, transaction });
  });
  assert.deepEqual(calls.map(({ chainId }) => chainId), ["1", "1", "8453"]);
  assert.equal((await repository.getNonceByHash(enrollment.nonceHash)).consumedAt, String(NOW));
  assert.equal((await repository.getNonceByHash(payout.nonceHash)).consumedAt, String(NOW));
});
