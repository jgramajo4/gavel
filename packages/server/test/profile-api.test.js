const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { Wallet } = require("ethers");

const { createAuthService } = require("../src/gate/auth");
const { MemoryGateStore } = require("../src/gate/store-memory");
const { createReadOnlyApi } = require("../../governance-index/src/api");
const { MemoryGovernanceStore } = require("../../governance-index/src/memory-store");

const WALLET = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const BASE_CHAIN_ID = 8453;
const ENROLLMENT_TYPES = [
  ["wallet", "address"], ["purpose", "string"], ["availability", "string"], ["dao", "string"],
  ["daoChainId", "uint256"], ["acceptPreVote", "bool"], ["acceptVoting", "bool"],
  ["attentionAmount", "uint256"], ["nonce", "bytes32"], ["issuedAt", "uint256"],
  ["expiry", "uint256"], ["version", "uint256"],
].map(([name, type]) => ({ name, type }));

function loadIndexClient() { return require("../src/gate/index-client"); }
function loadProfileService() { return require("../src/gate/profile-service"); }
function loadHttp() { return require("../src/gate/http"); }

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try { return await callback(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

function enrollmentProof(overrides = {}) {
  return {
    typedData: {
      primaryType: "GateEnrollment",
      domain: { name: "GavelGate", version: "1", chainId: 1, verifyingContract: `0x${"d".repeat(40)}` },
      message: {
        wallet: WALLET, purpose: "enrollment", availability: "accepting_now", dao: "nouns", daoChainId: "1",
        acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000", nonce: HASH,
        issuedAt: "1789344000", expiry: "1789344600", version: "1", ...overrides,
      },
    },
    signature: "0xsigned",
  };
}

function baseProof(overrides = {}) {
  return {
    typedData: {
      primaryType: "BasePayoutControl",
      domain: { name: "GavelGate", version: "1", chainId: BASE_CHAIN_ID, verifyingContract: `0x${"b".repeat(40)}` },
      message: { wallet: WALLET, dao: "nouns", purpose: "base_payout_control", nonce: BLOCK_HASH,
        issuedAt: "1789344000", expiry: "1789344600", version: "1", ...overrides },
    },
    signature: "0xbase",
  };
}

test("Nouns index client returns a complete fresh canonical proposal snapshot", async () => {
  const { createNounsIndexClient } = loadIndexClient();
  const now = new Date("2026-09-14T00:10:00.000Z");
  const source = {
    async getHealth() { return { healthy: true, refreshedAt: "2026-09-14T00:00:01.000Z" }; },
    async getProposal() {
      return {
        dao: "nouns", proposalId: "42", nativeState: "ACTIVE", effectiveStatus: "ACTIVE",
        refreshedAt: "2026-09-14T00:00:01.000Z",
        sourceBlock: "123", sourceBlockHash: BLOCK_HASH, contentHash: HASH,
        actions: [{ actionIndex: 0, target: WALLET, valueWei: "0", signature: "", calldata: "0x" }],
      };
    },
  };
  const client = createNounsIndexClient({ source, clock: () => now });

  assert.deepEqual(await client.getProposalSnapshot("42"), {
    dao: "nouns", proposalId: "42", nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1",
    refreshedAt: "2026-09-14T00:00:01.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH,
    contentHash: HASH, canonicalActions: [{ actionIndex: 0, target: WALLET, valueWei: "0", signature: "", calldata: "0x" }],
  });
});

test("Nouns index client rejects malformed or non-canonical proposal actions", async () => {
  const { createNounsIndexClient, IndexUnavailableError } = loadIndexClient();
  const now = new Date("2026-09-14T00:10:00.000Z");
  const base = {
    dao: "nouns", proposalId: "42", effectiveStatus: "ACTIVE",
    refreshedAt: "2026-09-14T00:00:01.000Z", sourceBlock: "123",
    sourceBlockHash: BLOCK_HASH, contentHash: HASH,
  };
  const invalid = [
    { actionIndex: 0, target: "not-an-address", valueWei: "0", signature: "", calldata: "0x" },
    { actionIndex: 0, target: WALLET, valueWei: "-1", signature: "", calldata: "0x" },
    { actionIndex: 0, target: WALLET, valueWei: "0", signature: 17, calldata: "0x" },
    { actionIndex: 0, target: WALLET, valueWei: "0", signature: "", calldata: "not-hex" },
    { actionIndex: 0, target: WALLET, valueWei: "0", signature: "", calldata: "0x", privateDestination: "secret" },
  ];
  for (const action of invalid) {
    const source = {
      async getHealth() { return { healthy: true, refreshedAt: base.refreshedAt }; },
      async getProposal() { return { ...base, actions: [action] }; },
    };
    const client = createNounsIndexClient({ source, clock: () => now });
    await assert.rejects(client.getProposalSnapshot("42"), IndexUnavailableError);
  }
  const valid = (actionIndex) => ({ actionIndex, target: WALLET, valueWei: "0", signature: "", calldata: "0x" });
  for (const actions of [
    [valid(1), valid(0)],
    [valid(0), valid(0)],
    [valid(0), valid(2)],
    [{ ...valid(0), actionIndex: 2_147_483_648 }],
    new Array(1),
  ]) {
    const source = {
      async getHealth() { return { healthy: true, refreshedAt: base.refreshedAt }; },
      async getProposal() { return { ...base, actions }; },
    };
    await assert.rejects(
      createNounsIndexClient({ source, clock: () => now }).getProposalSnapshot("42"),
      IndexUnavailableError,
    );
  }
});

test("dedicated governance HTTP projection preserves every field required by Gate", async () => {
  const refreshedAt = "2026-09-14T00:00:01.000Z";
  const store = new MemoryGovernanceStore({ clock: () => new Date(refreshedAt) });
  const normalized = { id: "42", state: "ACTIVE", effectiveStatus: "ACTIVE", actions: [] };
  store.ingest({
    raw: {
      daoId: "nouns", sourceId: "nouns-subgraph", sourceRecordKey: "proposal:42",
      chainId: 1, contractAddress: WALLET, transactionHash: null, logIndex: null,
      blockNumber: "123", blockHash: BLOCK_HASH, observedHead: "130", recordType: "proposal",
      proposalId: "42", contentHash: HASH.slice(2), payload: { id: "42" },
      sourceKind: "nouns-subgraph", sourceEndpoint: "https://index.example",
    },
    proposal: { daoId: "nouns", proposalId: "42", contentHash: HASH.slice(2), normalized,
      actions: [{ index: 0, target: WALLET, valueWei: "0", signature: "", calldata: "0x" }] },
  });

  await withServer(createReadOnlyApi({ store }), async (baseUrl) => {
    const ordinary = await requestJson(baseUrl, "/v1/daos/nouns/proposals/42");
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body.sourceBlock, undefined);

    store.proposals.push({ ...store.proposals[0], proposalId: "43", normalized: { ...normalized, id: "43" } });
    const missingProvenance = await requestJson(baseUrl, "/v1/gate/daos/nouns/proposals/43");
    assert.deepEqual({ status: missingProvenance.status, body: missingProvenance.body }, {
      status: 404, body: { error: "proposal_not_found" },
    });

    const source = {
      async getHealth() { return { healthy: true, refreshedAt }; },
      async getProposal(dao, proposalId) {
        const response = await requestJson(baseUrl, `/v1/gate/daos/nouns/proposals/${proposalId}`);
        assert.equal(response.status, 200);
        assert.deepEqual(Object.keys(response.body).sort(), [
          "actions", "contentHash", "effectiveStatus", "proposalId", "refreshedAt", "sourceBlock", "sourceBlockHash",
        ]);
        return { dao, ...response.body };
      },
    };
    const client = loadIndexClient().createNounsIndexClient({ source, clock: () => new Date("2026-09-14T00:10:00.000Z") });
    assert.deepEqual(await client.getProposalSnapshot("42"), {
      dao: "nouns", proposalId: "42", nativeState: "ACTIVE", eligibility: "VOTING", mappingVersion: "nouns-lifecycle/1",
      refreshedAt, sourceBlock: "123", sourceBlockHash: BLOCK_HASH, contentHash: HASH,
      canonicalActions: [{ actionIndex: 0, target: WALLET, valueWei: "0", signature: "", calldata: "0x" }],
    });
  });
});

test("Nouns index client reports aggregate freshness age and health without source details", async () => {
  const { createNounsIndexClient, IndexUnavailableError } = loadIndexClient();
  const gauges = [];
  const source = {
    async getHealth() { return { healthy: true, refreshedAt: "2026-09-14T00:00:00.000Z" }; },
    async getProposal() { return {
      dao: "nouns", proposalId: "42", effectiveStatus: "ACTIVE", refreshedAt: "2026-09-14T00:00:00.000Z",
      sourceBlock: "123", sourceBlockHash: BLOCK_HASH, contentHash: HASH, actions: [],
    }; },
  };
  const observability = { gauge(...args) { gauges.push(args); } };
  const healthy = createNounsIndexClient({ source, observability,
    clock: () => new Date("2026-09-14T00:00:12.500Z") });
  await healthy.getProposalSnapshot("42");
  assert.deepEqual(gauges, [
    ["gate_dao_freshness_age_seconds", 12.5, { health: "healthy" }],
    ["gate_dao_freshness_age_seconds", 12.5, { health: "healthy" }],
  ]);

  gauges.length = 0;
  const stale = createNounsIndexClient({ source, observability, freshnessMs: 1_000,
    clock: () => new Date("2026-09-14T00:00:12.500Z") });
  await assert.rejects(stale.getProposalSnapshot("42"), IndexUnavailableError);
  assert.deepEqual(gauges, [["gate_dao_freshness_age_seconds", 12.5, { health: "stale" }]]);
});

test("Nouns index client never exposes stale ACTIVE as VOTING after canonical terminalization", async () => {
  const { createNounsIndexClient } = loadIndexClient();
  const source = {
    async getHealth() { return { healthy: true, refreshedAt: "2026-09-14T00:00:01.000Z" }; },
    async getProposal() {
      return {
        dao: "nouns", proposalId: "42", nativeState: "ACTIVE", sourceState: "ACTIVE",
        effectiveStatus: "DEFEATED", trackingState: "FINAL", refreshedAt: "2026-09-14T00:00:01.000Z",
        sourceBlock: "123", sourceBlockHash: BLOCK_HASH, contentHash: HASH, actions: [],
      };
    },
  };
  const client = createNounsIndexClient({ source, clock: () => new Date("2026-09-14T00:10:00.000Z") });

  const snapshot = await client.getProposalSnapshot("42");
  assert.equal(snapshot.nativeState, "DEFEATED");
  assert.equal(snapshot.eligibility, "CLOSED");
  assert.notEqual(snapshot.eligibility, "VOTING");
  const { requireNounsIssuanceLifecycle } = require("../src/gate/semantic-contract");
  assert.throws(
    () => requireNounsIssuanceLifecycle(snapshot.nativeState, snapshot.eligibility),
    /quote issuance requires canonical ACTIVE to VOTING/,
  );
});

test("Nouns index client returns exact current power with canonical provenance", async () => {
  const { createNounsIndexClient } = loadIndexClient();
  const source = {
    async getHealth() { return { healthy: true, refreshedAt: "2026-09-14T00:00:01.000Z" }; },
    async getProposal() { throw new Error("unused"); },
    async getVotingPower(dao, wallet) {
      assert.equal(dao, "nouns"); assert.equal(wallet, WALLET);
      return { dao, wallet, amount: "0", asOf: "2026-09-14T00:00:00.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH };
    },
  };
  const client = createNounsIndexClient({ source, clock: () => new Date("2026-09-14T00:10:00.000Z") });
  assert.deepEqual(await client.getVotingPower(WALLET), {
    dao: "nouns", amount: "0", asOf: "2026-09-14T00:00:00.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH,
  });
});

test("Nouns index client rejects stale power records even when aggregate health is fresh", async () => {
  const { createNounsIndexClient, IndexUnavailableError } = loadIndexClient();
  const source = {
    async getHealth(dao) { assert.equal(dao, "nouns"); return { healthy: true, refreshedAt: "2026-09-14T00:09:59.000Z" }; },
    async getProposal() { throw new Error("unused"); },
    async getVotingPower(dao, wallet) {
      assert.deepEqual([dao, wallet], ["nouns", WALLET]);
      return { dao, wallet, amount: "1", asOf: "2026-09-13T23:00:00.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH };
    },
  };
  const client = createNounsIndexClient({ source, clock: () => new Date("2026-09-14T00:10:00.000Z") });
  await assert.rejects(client.getVotingPower(WALLET), IndexUnavailableError);
});

test("Nouns index client bounds every source operation and aborts timed-out work", async () => {
  const { createNounsIndexClient, IndexUnavailableError } = loadIndexClient();
  let aborted = false;
  const client = createNounsIndexClient({
    source: {
      getHealth(_dao, { signal }) {
        return new Promise((_, reject) => signal.addEventListener("abort", () => {
          aborted = true; reject(signal.reason);
        }, { once: true }));
      },
      getProposal() { return new Promise(() => {}); },
      getVotingPower() { return new Promise(() => {}); },
    },
    requestTimeoutMs: 5,
  });
  await assert.rejects(client.getVotingPower(WALLET), IndexUnavailableError);
  assert.equal(aborted, true);
});

test("Nouns index client fails closed for stale data and never interprets numeric lifecycle codes", async () => {
  const { createNounsIndexClient, IndexUnavailableError } = loadIndexClient();
  const proposal = {
    dao: "nouns", proposalId: "42", nativeState: 1, effectiveStatus: 1,
    refreshedAt: "2026-09-14T00:00:01.000Z",
    sourceBlock: "123", sourceBlockHash: BLOCK_HASH, contentHash: HASH, actions: [],
  };
  const source = {
    async getHealth() { return { healthy: true, refreshedAt: "2026-09-14T00:00:01.000Z" }; },
    async getProposal() { return proposal; },
  };
  const client = createNounsIndexClient({ source, clock: () => new Date("2026-09-14T00:10:00.000Z") });
  assert.equal((await client.getProposalSnapshot("42")).eligibility, "CLOSED");
  proposal.effectiveStatus = "1";
  assert.equal((await client.getProposalSnapshot("42")).eligibility, "CLOSED");

  const stale = createNounsIndexClient({ source, clock: () => new Date("2026-09-14T00:15:01.001Z") });
  await assert.rejects(stale.getProposalSnapshot("42"), IndexUnavailableError);
});

test("Nouns index client normalizes source failures and unhealthy state to unavailable", async () => {
  const { createNounsIndexClient, IndexUnavailableError } = loadIndexClient();
  const failedSource = {
    async getHealth() { throw new Error("private database connection details"); },
    async getProposal() { throw new Error("unused"); },
  };
  const failed = createNounsIndexClient({ source: failedSource });
  await assert.rejects(failed.getProposalSnapshot("42"), IndexUnavailableError);

  const unhealthySource = {
    async getHealth() { return { healthy: false, refreshedAt: "2026-09-14T00:00:00.000Z", lastError: "private RPC URL" }; },
    async getProposal() { throw new Error("must not read while unhealthy"); },
  };
  const unhealthy = createNounsIndexClient({ source: unhealthySource, clock: () => new Date("2026-09-14T00:01:00.000Z") });
  await assert.rejects(unhealthy.getProposalSnapshot("42"), (error) => {
    assert.ok(error instanceof IndexUnavailableError);
    assert.equal(error.message.includes("private"), false);
    return true;
  });
});

test("profile service requires an explicit configured Base chain", () => {
  const { createProfileService } = loadProfileService();
  assert.throws(() => createProfileService({
    repository: { withProfileTransaction() {} },
    authService: { verifyProfileProofs() {}, consumeProfileProofs() {} },
    indexClient: { getVotingPower() {} },
  }), /baseChainId/);
});

test("real auth and profile services accept the documented GateEnrollment operation proof shape", async () => {
  const signer = Wallet.createRandom();
  const nowSeconds = 2_000_000_000;
  const store = new MemoryGateStore({ clock: () => new Date(nowSeconds * 1000) });
  const authService = createAuthService({
    repository: store,
    audience: "https://gate.example",
    base: { chainId: BASE_CHAIN_ID, verifier: `0x${"b".repeat(40)}` },
    dao: { chainId: 1, verifier: `0x${"d".repeat(40)}`, dao: "nouns" },
    clock: () => nowSeconds,
    randomBytes: () => Buffer.alloc(32, 0x44),
  });
  const profileService = loadProfileService().createProfileService({
    repository: store,
    authService,
    indexClient: { async getVotingPower() { return { amount: "1", asOf: "2033-05-18T03:33:20.000Z" }; } },
    baseChainId: BASE_CHAIN_ID,
  });
  const challenge = await authService.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const proof = {
    typedData: { primaryType: challenge.primaryType, domain: challenge.domain, message: challenge.message },
    signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message),
  };

  const result = await profileService.updateProfile({
    session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: "https://gate.example" },
    gateEnrollmentProof: proof,
  });

  assert.equal(result.wallet, signer.address.toLowerCase());
  assert.equal(result.availability, "paused");
  assert.equal((await store.getNonceByHash(challenge.nonceHash)).consumedAt, String(nowSeconds));
  assert.equal((await store.getProfileByWallet(signer.address)).walletKind, "eoa");
});

test("Base payout proof and persisted hash bind to the verifier's exact observed runtime code", async () => {
  const { keccak256 } = require("ethers");
  const contractWallet = Wallet.createRandom().address;
  const nowSeconds = 2_000_000_000;
  const store = new MemoryGateStore({ clock: () => new Date(nowSeconds * 1000) });
  const authService = createAuthService({
    repository: store,
    audience: "https://gate.example",
    base: { chainId: BASE_CHAIN_ID, verifier: `0x${"b".repeat(40)}` },
    dao: { chainId: 1, verifier: `0x${"d".repeat(40)}`, dao: "nouns" },
    clock: () => nowSeconds,
    randomBytes: (() => {
      let byte = 0x61;
      return () => Buffer.alloc(32, byte++);
    })(),
    chainVerifiers: {
      1: async () => ({ code: "0x6000", magicValue: "0x1626ba7e" }),
      8453: async () => ({ code: "0x6001", magicValue: "0x1626ba7e" }),
    },
  });
  let independentReads = 0;
  const profileService = loadProfileService().createProfileService({
    repository: store,
    authService,
    indexClient: { async getVotingPower() { return { amount: "1", asOf: "2033-05-18T03:33:20.000Z" }; } },
    baseChainId: BASE_CHAIN_ID,
    baseCodeReader: async () => {
      independentReads += 1;
      return { chainId: String(BASE_CHAIN_ID), code: "0x6002" };
    },
    clock: () => new Date(nowSeconds * 1000),
  });
  const enrollment = await authService.issueChallenge({
    proofType: "GateEnrollment", wallet: contractWallet, availability: "accepting_now", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const payout = await authService.issueChallenge({ proofType: "BasePayoutControl", wallet: contractWallet, dao: "nouns" });

  await profileService.updateProfile({
    session: { wallet: contractWallet, role: "dao_profile", chainId: "1", audience: "https://gate.example" },
    gateEnrollmentProof: { typedData: { primaryType: enrollment.primaryType, domain: enrollment.domain, message: enrollment.message }, signature: "0x1234" },
    basePayoutControlProof: { typedData: { primaryType: payout.primaryType, domain: payout.domain, message: payout.message }, signature: "0x5678" },
  });

  const persisted = await store.getProfileByWallet(contractWallet);
  assert.equal(persisted.basePayoutCodeHash, keccak256("0x6001"));
  assert.equal(independentReads, 0);
});

test("real profile writes reject extra operation-proof artifacts without consuming the nonce", async () => {
  const signer = Wallet.createRandom();
  const nowSeconds = 2_000_000_000;
  const store = new MemoryGateStore({ clock: () => new Date(nowSeconds * 1000) });
  const authService = createAuthService({
    repository: store,
    audience: "https://gate.example",
    base: { chainId: BASE_CHAIN_ID, verifier: `0x${"b".repeat(40)}` },
    dao: { chainId: 1, verifier: `0x${"d".repeat(40)}`, dao: "nouns" },
    clock: () => nowSeconds,
    randomBytes: () => Buffer.alloc(32, 0x55),
  });
  const profileService = loadProfileService().createProfileService({
    repository: store,
    authService,
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
  });
  const challenge = await authService.issueChallenge({
    proofType: "GateEnrollment", wallet: signer.address, availability: "paused", dao: "nouns", daoChainId: 1,
    acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000",
  });
  const documentedProof = {
    typedData: { primaryType: challenge.primaryType, domain: challenge.domain, message: challenge.message },
    signature: await signer.signTypedData(challenge.domain, challenge.types, challenge.message),
  };

  for (const proof of [
    { ...documentedProof, nonceHash: challenge.nonceHash },
    { ...documentedProof, typedData: { ...documentedProof.typedData, types: challenge.types } },
  ]) {
    await assert.rejects(profileService.updateProfile({
      session: { wallet: signer.address, role: "dao_profile", chainId: "1", audience: "https://gate.example" },
      gateEnrollmentProof: proof,
    }), /shape/i);

    assert.equal((await store.getNonceByHash(challenge.nonceHash)).consumedAt, null);
    assert.equal(await store.getProfileByWallet(signer.address), null);
  }
});

test("profile update verifies and consumes enrollment inside the shared profile transaction", async () => {
  const { createProfileService } = loadProfileService();
  const events = [];
  const row = { id: "profile-1", wallet: WALLET, walletKind: "eoa", availability: "accepting_now",
    display: { ens: "noun.eth", message: "Reviewing public goods", destination: "private" }, profileVersion: 1,
    updatedAt: new Date("2026-09-14T00:00:00.000Z") };
  const repository = {
    async withProfileTransaction(wallet, callback) {
      events.push(["lock", wallet]);
      return callback({
        async getProfileByWallet() { events.push(["read"]); return null; },
        async mutateProfile(input) { events.push(["mutate", input]); return row; },
      });
    },
    async getPolicy() { return { dao: "nouns", enabled: true, acceptPreVote: false, acceptVoting: true,
      attentionAmount: "1000000", tags: ["public-goods"], secretCapacity: 25 }; },
    async isProfileAccepting() { return true; },
  };
  const authService = {
    async verifyProfileProofs(input) { events.push(["verify", input.transaction != null]); return { wallet: WALLET, walletKind: "eoa", proofIds: ["nonce-1"] }; },
    async consumeProfileProofs(input) { events.push(["consume", input.transaction != null, input.proofIds]); },
  };
  const indexClient = { async getVotingPower() { return { dao: "nouns", amount: "0", asOf: "2026-09-14T00:00:00.000Z", sourceBlock: "123", sourceBlockHash: BLOCK_HASH }; } };
  const service = createProfileService({ repository, authService, indexClient, baseChainId: BASE_CHAIN_ID });

  const proof = enrollmentProof();
  proof.publicTags = ["public-goods"];
  const result = await service.updateProfile({
    session: { wallet: WALLET, role: "dao_profile" },
    gateEnrollmentProof: proof,
  });

  assert.deepEqual(events.map((event) => event[0]), ["lock", "read", "verify", "mutate", "consume"]);
  assert.equal(events[2][1], true);
  assert.equal(events[4][1], true);
  assert.deepEqual(result, {
    wallet: WALLET, ens: "noun.eth", availability: "accepting_now", acceptingSubmissions: true,
    message: "Reviewing public goods",
    policies: [{ dao: "nouns", supportedStages: ["VOTING"], acceptedStages: ["VOTING"],
      attentionAmount: "1000000", gavelFeeAmount: "250000", tags: ["public-goods"] }],
    governancePower: { dao: "nouns", amount: "0", asOf: "2026-09-14T00:00:00.000Z" },
  });
});

test("profile update derives EIP-712 types server-side without depending on message key insertion order", async () => {
  const { createProfileService } = loadProfileService();
  let mutations = 0;
  const service = createProfileService({
    repository: { async withProfileTransaction(_wallet, callback) {
      return callback({ getProfileByWallet: async () => null, mutateProfile: async ({ profile }) => {
        mutations += 1; return { ...profile, display: {}, profileVersion: 1 };
      } });
    } },
    authService: { async verifyProfileProofs() { return { wallet: WALLET, walletKind: "eoa", proofIds: [HASH] }; }, async consumeProfileProofs() {} },
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
  });
  const reordered = enrollmentProof();
  reordered.typedData.message = Object.fromEntries(Object.entries(reordered.typedData.message).reverse());
  await service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: reordered });
  assert.equal(mutations, 1);

  const callerControlledTypes = enrollmentProof();
  callerControlledTypes.typedData.types = { GateEnrollment: structuredClone(ENROLLMENT_TYPES).reverse() };
  await assert.rejects(service.updateProfile({
    session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: callerControlledTypes,
  }), /typed data.*shape/i);
  assert.equal(mutations, 1);
});

test("profile update persists only allowlisted scalar public display fields", async () => {
  const { createProfileService } = loadProfileService();
  let mutation;
  const service = createProfileService({
    repository: { async withProfileTransaction(_wallet, callback) {
      return callback({ getProfileByWallet: async () => null, mutateProfile: async (value) => {
        mutation = value; return { ...value.profile, profileVersion: 1 };
      } });
    } },
    authService: { async verifyProfileProofs() { return { wallet: WALLET, walletKind: "eoa", proofIds: [HASH] }; }, async consumeProfileProofs() {} },
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
  });
  const proof = enrollmentProof();
  proof.publicDisplay = { ens: "noun.eth", message: null, destination: { email: "secret@example.com" }, session: "private" };
  await service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: proof });
  assert.deepEqual(mutation.profile.display, { ens: "noun.eth", message: null });

  const nested = enrollmentProof();
  nested.publicDisplay = { ens: { destination: "secret@example.com" } };
  await assert.rejects(service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: nested }), /publicDisplay\.ens/);
});

test("authenticated profile update encrypts a private top-level delivery destination and stores only its envelope transactionally", async () => {
  const { createProfileService } = loadProfileService();
  const events = [];
  const plaintext = "private-voter@example.com";
  const envelope = "gg1.primary.AAAAAAAAAAAAAAAA.ciphertext.AAAAAAAAAAAAAAAAAAAAAA";
  const service = createProfileService({
    repository: { async withProfileTransaction(_wallet, callback) {
      return callback({
        getProfileByWallet: async () => null,
        mutateProfile: async ({ profile }) => ({ ...profile, display: {}, profileVersion: 1 }),
        async setDeliverySetting(profileId, ciphertext) { events.push(["store", profileId, ciphertext]); },
      });
    } },
    authService: {
      async verifyProfileProofs() { return { wallet: WALLET, walletKind: "eoa", proofIds: [HASH] }; },
      async consumeProfileProofs() { events.push(["consume"]); },
    },
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
    encryptDestination(profileId, destination) {
      events.push(["encrypt", profileId, destination]);
      return envelope;
    },
  });
  const result = await service.updateProfile({
    session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof(),
    deliveryDestination: plaintext,
  });
  assert.deepEqual(events, [
    ["encrypt", WALLET, plaintext],
    ["store", WALLET, envelope],
    ["consume"],
  ]);
  assert.equal(JSON.stringify(result).includes(plaintext), false);
  assert.equal(JSON.stringify(result).includes(envelope), false);
});

test("delivery destination fails closed without encryption and is never accepted inside signed or public display data", async () => {
  const { createProfileService } = loadProfileService();
  const service = createProfileService({
    repository: { async withProfileTransaction(_wallet, callback) {
      return callback({ getProfileByWallet: async () => null, mutateProfile: async ({ profile }) => ({ ...profile, display: {}, profileVersion: 1 }) });
    } },
    authService: { async verifyProfileProofs() { return { wallet: WALLET, walletKind: "eoa", proofIds: [HASH] }; }, async consumeProfileProofs() {} },
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
  });
  await assert.rejects(service.updateProfile({
    session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof(),
    deliveryDestination: "private-voter@example.com",
  }), /delivery encryption unavailable/i);
});

test("profile update returns a safe committed projection when post-commit index decoration fails", async () => {
  const { createProfileService } = loadProfileService();
  let committed = false;
  const profile = { id: "p", wallet: WALLET, walletKind: "eoa", availability: "paused",
    display: { ens: "noun.eth", destination: "private" } };
  const policy = { dao: "nouns", enabled: true, acceptVoting: true, attentionAmount: "1000000", tags: [] };
  const repository = {
    async withProfileTransaction(_wallet, callback) {
      const result = await callback({ getProfileByWallet: async () => null, mutateProfile: async () => profile });
      committed = true;
      return result;
    },
  };
  const service = createProfileService({ repository,
    authService: {
      async verifyProfileProofs() { return { wallet: WALLET, walletKind: "eoa", proofIds: [HASH] }; },
      async consumeProfileProofs() {},
    },
    indexClient: { async getVotingPower() { throw new Error("index down after commit"); } },
    baseChainId: BASE_CHAIN_ID,
  });

  const result = await service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof({ availability: "paused" }) });
  assert.equal(committed, true);
  assert.deepEqual(result, {
    wallet: WALLET, ens: "noun.eth", availability: "paused", acceptingSubmissions: false,
    message: "Not currently accepting new submissions",
    policies: [{ dao: "nouns", supportedStages: ["VOTING"], acceptedStages: ["VOTING"],
      attentionAmount: "1000000", gavelFeeAmount: "250000", tags: [] }],
  });
});

test("contract profile update rejects missing verifier code evidence before mutation", async () => {
  const { createProfileService, ProfileRequestError } = loadProfileService();
  let mutations = 0;
  const repository = {
    async withProfileTransaction(_wallet, callback) {
      return callback({ getProfileByWallet: async () => null, mutateProfile: async () => { mutations += 1; return {}; } });
    },
  };
  const service = createProfileService({ repository,
    authService: {
      async verifyProfileProofs() { return { wallet: WALLET, walletKind: "contract", proofIds: [HASH] }; },
      async consumeProfileProofs() {},
    },
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
  });

  await assert.rejects(
    service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof(), basePayoutControlProof: baseProof() }),
    (error) => error instanceof ProfileRequestError && error.code === "SERVICE_UNAVAILABLE",
  );
  assert.equal(mutations, 0);
});

test("profile proof verification failures are coarse client errors and roll back", async () => {
  const { createProfileService, ProfileRequestError } = loadProfileService();
  let mutated = false;
  const service = createProfileService({
    repository: {
      async withProfileTransaction(_wallet, callback) {
        return callback({ getProfileByWallet: async () => null, mutateProfile: async () => { mutated = true; } });
      },
    },
    authService: {
      async verifyProfileProofs() { throw Object.assign(new Error("private nonce row and RPC URL"), { code: "INVALID_AUTH_PROOF" }); },
      async consumeProfileProofs() {},
    },
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
  });
  await assert.rejects(
    service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof() }),
    (error) => error instanceof ProfileRequestError && error.statusCode === 403
      && error.code === "FORBIDDEN" && !error.message.includes("private"),
  );
  assert.equal(mutated, false);
});

test("profile update rejects wrong role, wallet, and enrollment purpose before consuming a nonce", async () => {
  const { createProfileService } = loadProfileService();
  let transactions = 0; let verifies = 0; let consumes = 0;
  const repository = {
    async withProfileTransaction(_wallet, callback) { transactions += 1; return callback({ getProfileByWallet: async () => null, mutateProfile: async () => ({}) }); },
    async getPolicy() { return null; },
  };
  const authService = {
    async verifyProfileProofs() { verifies += 1; return { wallet: WALLET, walletKind: "eoa", proofIds: [] }; },
    async consumeProfileProofs() { consumes += 1; },
  };
  const service = createProfileService({ repository, authService, indexClient: { getVotingPower: async () => ({}) }, baseChainId: BASE_CHAIN_ID });

  await assert.rejects(service.updateProfile({ session: { wallet: WALLET, role: "dao_inbox" }, gateEnrollmentProof: enrollmentProof() }), /dao_profile/);
  await assert.rejects(service.updateProfile({ session: { wallet: OTHER_WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof() }), /wallet mismatch/);
  await assert.rejects(service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof({ purpose: "wallet_session" }) }), /policy is invalid/);
  await assert.rejects(service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof({ acceptVoting: false }) }), /policy is invalid/);
  await assert.rejects(service.updateProfile({
    session: { wallet: WALLET, role: "dao_profile" },
    gateEnrollmentProof: enrollmentProof(),
    basePayoutControlProof: baseProof({ wallet: OTHER_WALLET }),
  }), /BasePayoutControl\.wallet|profile wallet mismatch/);
  assert.deepEqual({ transactions, verifies, consumes }, { transactions: 0, verifies: 0, consumes: 0 });
});

test("existing paused contract profile can close without Base proof or code read", async () => {
  const { createProfileService } = loadProfileService();
  let mutation; let reads = 0;
  const existing = {
    id: "profile-1", wallet: WALLET, walletKind: "contract", availability: "paused",
    basePayoutCodeHash: HASH, basePayoutVerifiedAt: "2026-09-13T23:00:00.000Z", display: {},
  };
  const service = createProfileService({
    repository: {
      async withProfileTransaction(_wallet, callback) {
        return callback({
          getProfileByWallet: async () => existing,
          mutateProfile: async (value) => { mutation = value; return { ...existing, ...value.profile }; },
        });
      },
    },
    authService: {
      async verifyProfileProofs() { return { wallet: WALLET, walletKind: "contract", proofIds: [HASH] }; },
      async consumeProfileProofs() {},
    },
    indexClient: { async getVotingPower() { return null; } },
    baseChainId: BASE_CHAIN_ID,
    baseCodeReader: async () => { reads += 1; throw new Error("must not read Base code"); },
  });

  const result = await service.updateProfile({
    session: { wallet: WALLET, role: "dao_profile" },
    gateEnrollmentProof: enrollmentProof({ availability: "closed" }),
  });
  assert.equal(reads, 0);
  assert.equal(Object.hasOwn(mutation.profile, "basePayoutCodeHash"), false);
  assert.equal(Object.hasOwn(mutation.profile, "basePayoutVerifiedAt"), false);
  assert.equal(result.acceptingSubmissions, false);
});

test("contract profile writes require a same-wallet Base proof and persist fresh nonempty code hash", async () => {
  const { keccak256 } = require("ethers");
  const { createProfileService } = loadProfileService();
  let mutation;
  let reportedChainId = "8453";
  const codeHash = keccak256("0x60016000");
  const repository = {
    async withProfileTransaction(_wallet, callback) {
      return callback({ getProfileByWallet: async () => null, mutateProfile: async (value) => {
        mutation = value;
        return { ...value.profile, display: {}, profileVersion: 1 };
      } });
    },
  };
  const authService = {
    async verifyProfileProofs() {
      return { wallet: WALLET, walletKind: "contract", proofIds: ["enrollment", "base"],
        basePayoutChainId: reportedChainId, basePayoutCodeHash: codeHash };
    },
    async consumeProfileProofs() {},
  };
  const indexClient = { getVotingPower: async () => ({ dao: "nouns", amount: "1", asOf: "2026-09-14T00:00:00.000Z" }) };
  const service = createProfileService({ repository, authService, indexClient,
    baseChainId: 8453,
    clock: () => new Date("2026-09-14T00:05:00.000Z") });

  await service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof(), basePayoutControlProof: baseProof() });
  assert.equal(mutation.profile.basePayoutCodeHash, codeHash);
  assert.equal(mutation.profile.basePayoutVerifiedAt, "2026-09-14T00:05:00.000Z");

  reportedChainId = "1";
  await assert.rejects(
    service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof(), basePayoutControlProof: baseProof() }),
    (error) => error.code === "SERVICE_UNAVAILABLE",
  );

  await assert.rejects(service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof() }), /BasePayoutControl/);
  await assert.rejects(service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof(), basePayoutControlProof: baseProof({ wallet: OTHER_WALLET }) }), /BasePayoutControl\.wallet|Base payout proof|profile wallet mismatch/);
});

test("profile transaction rollback leaves staged mutation uncommitted when nonce consumption fails", async () => {
  const { createProfileService } = loadProfileService();
  let profile = null;
  const repository = {
    async withProfileTransaction(_wallet, callback) {
      const transaction = {
        staged: null,
        async getProfileByWallet() { return null; },
        async mutateProfile(value) { this.staged = { ...value.profile, display: {} }; return this.staged; },
      };
      const result = await callback(transaction);
      profile = transaction.staged;
      return result;
    },
  };
  const authService = {
    async verifyProfileProofs() { return { wallet: WALLET, walletKind: "eoa", proofIds: ["nonce"] }; },
    async consumeProfileProofs() { throw new Error("nonce store failed"); },
  };
  const service = createProfileService({ repository, authService, indexClient: { getVotingPower: async () => ({}) }, baseChainId: BASE_CHAIN_ID });
  await assert.rejects(service.updateProfile({ session: { wallet: WALLET, role: "dao_profile" }, gateEnrollmentProof: enrollmentProof() }), /nonce store failed/);
  assert.equal(profile, null);
});

test("public acceptance fails closed for disabled or exhausted policy while direct profiles remain public", async () => {
  const { createProfileService } = loadProfileService();
  const profile = { id: "p", wallet: WALLET, availability: "accepting_now", updatedAt: new Date(), display: {} };
  const policy = { dao: "nouns", enabled: true, acceptPreVote: false, acceptVoting: true, attentionAmount: "1000000", tags: [] };
  for (const { accepting, enabled } of [
    { accepting: false, enabled: true },
    { accepting: null, enabled: true },
    { accepting: true, enabled: false },
  ]) {
    const repository = {
      async withProfileTransaction() { throw new Error("unused"); },
      async listProfiles() { return [profile]; },
      async getProfileByWallet() { return profile; },
      async getPolicy() { return { ...policy, enabled }; },
      async isProfileAccepting() { return accepting; },
    };
    const service = createProfileService({
      repository,
      authService: { verifyProfileProofs() {}, consumeProfileProofs() {} },
      indexClient: { async getVotingPower() { return { amount: "1", asOf: "2026-09-14T00:00:00.000Z" }; } },
      baseChainId: 8453,
    });
    assert.deepEqual(await service.listPublicProfiles(), []);
    const direct = await service.getPublicProfile(WALLET);
    assert.equal(direct.acceptingSubmissions, false);
    assert.equal(direct.message, "Not currently accepting new submissions");
    const serialized = JSON.stringify(direct).toLowerCase();
    for (const secret of ["capacity", "remaining", "reset", "count"]) assert.equal(serialized.includes(secret), false);
  }
});

test("public directory keeps zero-power accepting profiles, sorts safely, and direct lookup exposes unavailable profiles", async () => {
  const { createProfileService } = loadProfileService();
  const accepting = { id: "a", wallet: WALLET, walletKind: "eoa", availability: "accepting_now",
    updatedAt: new Date("2026-09-14T00:00:00.000Z"), display: { ens: "noun.eth", message: null, destination: "secret@example.com" },
    signature: "private", nonce: "private", session: "private", capacity: 25, notificationChannel: "email" };
  const paused = { id: "b", wallet: OTHER_WALLET, walletKind: "contract", availability: "paused",
    updatedAt: new Date("2026-09-14T00:01:00.000Z"), display: { ens: null, message: "hidden state" }, basePayoutCodeHash: HASH };
  const policy = { dao: "nouns", enabled: true, acceptPreVote: false, acceptVoting: true,
    attentionAmount: "1000000", tags: ["public-goods"], pendingReservationCapacity: 12, settledCapacity: 25,
    destination: "private", notification: "private" };
  const repository = {
    async withProfileTransaction() { throw new Error("unused"); },
    async listProfiles() { return [paused, accepting]; },
    async getProfileByWallet(wallet) { return wallet === OTHER_WALLET ? paused : null; },
    async getPolicy() { return policy; },
    async isProfileAccepting() { return true; },
  };
  const powers = new Map([[WALLET, "0"], [OTHER_WALLET, "9"]]);
  const service = createProfileService({ repository,
    authService: { verifyProfileProofs() {}, consumeProfileProofs() {} },
    indexClient: { async getVotingPower(wallet) { return { dao: "nouns", amount: powers.get(wallet), asOf: "2026-09-14T00:00:00.000Z", privateHash: HASH }; } },
    baseChainId: BASE_CHAIN_ID,
  });

  const directory = await service.listPublicProfiles({ dao: "nouns", availability: "accepting_now", sort: "recent" });
  assert.equal(directory.length, 1);
  assert.equal(directory[0].wallet, WALLET);
  assert.equal(directory[0].governancePower.amount, "0");
  assert.deepEqual(await service.listPublicProfiles({ dao: "nouns", minVotingPower: "1", sort: "power" }), []);

  const direct = await service.getPublicProfile(OTHER_WALLET);
  assert.equal(direct.availability, "paused");
  assert.equal(direct.acceptingSubmissions, false);
  assert.equal(direct.message, "Not currently accepting new submissions");

  const serialized = JSON.stringify({ directory, direct }).toLowerCase();
  for (const privateName of ["destination", "signature", "nonce", "session", "capacity", "notification", "basepayout", "sourceblock", "privatehash"]) {
    assert.equal(serialized.includes(privateName), false, `leaked ${privateName}`);
  }
});

test("public directory bounds repository rows and performs enrichment concurrently", async () => {
  const { createProfileService } = loadProfileService();
  let listOptions; let reads = 0; let active = 0; let peak = 0;
  const profiles = Array.from({ length: 50 }, (_, index) => ({
    id: `p-${index}`, wallet: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    availability: "accepting_now", display: {}, updatedAt: new Date(index),
  }));
  const repository = {
    async withProfileTransaction() { throw new Error("unused"); },
    async listProfiles(options) { listOptions = options; return profiles; },
    async getPolicy() { reads += 1; return { dao: "nouns", enabled: true, acceptVoting: true, attentionAmount: "1000000", tags: [] }; },
    async isProfileAccepting() { reads += 1; return true; },
  };
  const service = createProfileService({ repository,
    authService: { verifyProfileProofs() {}, consumeProfileProofs() {} },
    indexClient: { async getVotingPower() {
      reads += 1; active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve)); active -= 1;
      return { amount: "1", asOf: "2026-09-14T00:00:00.000Z" };
    } },
    baseChainId: BASE_CHAIN_ID,
  });
  assert.equal((await service.listPublicProfiles()).length, 50);
  assert.deepEqual(listOptions, { dao: "nouns", availability: "accepting_now", limit: 50, offset: 0 });
  assert.equal(reads, 150);
  assert.ok(peak > 1, "directory enrichment should not serialize external power reads");
});

test("power sorting and minimum filtering scan beyond the first response page before limiting", async () => {
  const { createProfileService } = loadProfileService();
  const profiles = Array.from({ length: 51 }, (_, index) => ({
    id: `p-${index.toString().padStart(2, "0")}`,
    wallet: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    availability: "accepting_now",
    display: {},
    updatedAt: new Date(51 - index),
  }));
  const listCalls = [];
  const repository = {
    async withProfileTransaction() { throw new Error("unused"); },
    async listProfiles(options) {
      listCalls.push(options);
      return profiles.slice(options.offset, options.offset + options.limit);
    },
    async getPolicy() { return { dao: "nouns", enabled: true, acceptVoting: true, attentionAmount: "1000000", tags: [] }; },
    async isProfileAccepting() { return true; },
  };
  const service = createProfileService({
    repository,
    authService: { verifyProfileProofs() {}, consumeProfileProofs() {} },
    indexClient: { async getVotingPower(wallet) {
      return { amount: wallet === profiles[50].wallet ? "999" : "1", asOf: "2026-09-14T00:00:00.000Z" };
    } },
    baseChainId: BASE_CHAIN_ID,
  });

  const byPower = await service.listPublicProfiles({ sort: "power" });
  assert.equal(byPower.length, 50);
  assert.equal(byPower[0].wallet, profiles[50].wallet);
  assert.deepEqual(listCalls.map(({ limit, offset }) => ({ limit, offset })), [
    { limit: 50, offset: 0 }, { limit: 50, offset: 50 },
  ]);

  listCalls.length = 0;
  const filtered = await service.listPublicProfiles({ sort: "power", minVotingPower: "999" });
  assert.deepEqual(filtered.map(({ wallet }) => wallet), [profiles[50].wallet]);
  assert.deepEqual(listCalls.map(({ offset }) => offset), [0, 50]);
});

test("public serializer cannot leak nested private objects through display fields or tags", () => {
  const { publicProfile } = loadProfileService();
  const result = publicProfile({
    wallet: WALLET,
    availability: "accepting_now",
    acceptingSubmissions: true,
    display: {
      ens: { destination: "secret@example.com" },
      message: { signature: "0xprivate" },
    },
  }, {
    dao: "nouns", enabled: true, acceptVoting: true, attentionAmount: "1000000",
    tags: ["public-goods", { notification: "private" }],
  }, { amount: "1", asOf: "2026-09-14T00:00:00.000Z", privateHash: HASH });

  assert.deepEqual(result, {
    wallet: WALLET,
    availability: "accepting_now",
    acceptingSubmissions: true,
    policies: [{
      dao: "nouns", supportedStages: ["VOTING"], acceptedStages: ["VOTING"],
      attentionAmount: "1000000", gavelFeeAmount: "250000", tags: ["public-goods"],
    }],
    governancePower: { dao: "nouns", amount: "1", asOf: "2026-09-14T00:00:00.000Z" },
  });
});

test("Node HTTP server delegates auth and exposes only the profile service routes", async () => {
  const { createGateHttpServer } = loadHttp();
  const calls = [];
  const authService = {
    async issueChallenge(body) {
      calls.push(["challenge", body]);
      if (body.chainId !== undefined) throw new TypeError("chainId override rejected");
      return { proofType: body.proofType, challenge: true };
    },
    async verifyProof(body) {
      calls.push(["verify", body]);
      if (body.proofType !== "WalletSession" || body.typedData?.primaryType !== "WalletSession"
          || !body.typedData.domain || !body.typedData.message
          || Object.keys(body).some((key) => !["proofType", "typedData", "signature"].includes(key))
          || Object.keys(body.typedData).some((key) => !["primaryType", "domain", "message"].includes(key))) {
        throw new Error("verify accepts exact WalletSession proof only");
      }
      return { token: "session-token", session: { wallet: WALLET, role: "dao_profile" } };
    },
    async authenticateSession(token, requirements) {
      calls.push(["session", token, requirements]);
      return { wallet: WALLET, role: "dao_profile", audience: "gavel" };
    },
  };
  const profileService = {
    async updateProfile(input) { calls.push(["update", input]); return { wallet: WALLET, availability: "accepting_now" }; },
    async listPublicProfiles(filters) { calls.push(["list", filters]); return [{ wallet: WALLET, availability: "accepting_now" }]; },
    async getPublicProfile(wallet) { calls.push(["get", wallet]); return wallet === WALLET ? { wallet, availability: "accepting_now" } : null; },
  };
  const server = createGateHttpServer({ authService, profileService });

  await withServer(server, async (baseUrl) => {
    const challenge = await requestJson(baseUrl, "/v1/gate/auth/challenge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proofType: "WalletSession", wallet: WALLET, role: "dao_profile" }),
    });
    assert.deepEqual({ status: challenge.status, body: challenge.body }, { status: 200, body: { proofType: "WalletSession", challenge: true } });
    assert.equal((await requestJson(baseUrl, "/v1/gate/auth/challenge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proofType: "WalletSession", wallet: WALLET, role: "dao_profile", chainId: 1 }),
    })).status, 400);

    const verifyRequest = {
      proofType: "WalletSession",
      typedData: { primaryType: "WalletSession", domain: { chainId: 1 }, message: { wallet: WALLET } },
      signature: "0xsigned",
    };
    const verify = await requestJson(baseUrl, "/v1/gate/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(verifyRequest),
    });
    assert.equal(verify.status, 200);
    assert.deepEqual(calls.find((call) => call[0] === "verify"), ["verify", verifyRequest]);
    assert.equal((await requestJson(baseUrl, "/v1/gate/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...verifyRequest, typedData: { ...verifyRequest.typedData, primaryType: "GateEnrollment" } }),
    })).status, 401);
    assert.equal((await requestJson(baseUrl, "/v1/gate/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...verifyRequest, nonceHash: HASH }),
    })).status, 401);
    assert.equal((await requestJson(baseUrl, "/v1/gate/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...verifyRequest, typedData: { ...verifyRequest.typedData, types: {} } }),
    })).status, 401);
    assert.equal((await requestJson(baseUrl, "/v1/gate/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proofType: "GateEnrollment" }),
    })).status, 401);

    const update = await requestJson(baseUrl, "/v1/gate/me/profile", {
      method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ gateEnrollmentProof: { proof: true } }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual(calls.find((call) => call[0] === "session"), ["session", "token", { role: "dao_profile" }]);
    assert.equal(calls.find((call) => call[0] === "update")[1].session.wallet, WALLET);

    const directory = await requestJson(baseUrl, "/v1/gates?dao=nouns&availability=accepting_now&minVotingPower=0&sort=power");
    assert.deepEqual(directory.body, { items: [{ wallet: WALLET, availability: "accepting_now" }] });
    assert.deepEqual(calls.find((call) => call[0] === "list")[1], {
      dao: "nouns", availability: "accepting_now", minVotingPower: "0", sort: "power",
    });

    const direct = await requestJson(baseUrl, `/v1/gates/${WALLET}`);
    assert.equal(direct.status, 200);
    assert.equal(direct.headers.get("cache-control"), "no-store");
    assert.equal(direct.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await requestJson(baseUrl, `/v1/gates/${OTHER_WALLET}`)).status, 404);
    assert.equal((await requestJson(baseUrl, "/v1/gate/me/profile", { method: "PUT", body: "{}" })).status, 401);
    assert.equal((await requestJson(baseUrl, "/https://attacker.invalid/", { method: "GET" })).status, 404);
  });
});

test("HTTP rejects network-path and authority-form request targets before routing", async () => {
  const { createGateHttpServer } = loadHttp();
  let calls = 0;
  const server = createGateHttpServer({
    authService: {
      async issueChallenge() { calls += 1; return {}; },
      async verifyProof() { calls += 1; return {}; },
      async authenticateSession() { calls += 1; return {}; },
    },
    profileService: {
      async updateProfile() { calls += 1; return {}; },
      async listPublicProfiles() { calls += 1; return []; },
      async getPublicProfile() { calls += 1; return null; },
    },
  });
  await withServer(server, async () => {
    const { port } = server.address();
    async function raw(path) {
      return new Promise((resolve, reject) => {
        const outgoing = http.request({ host: "127.0.0.1", port, method: "GET", path }, (response) => {
          response.resume(); response.on("end", () => resolve(response.statusCode));
        });
        outgoing.on("error", reject); outgoing.end();
      });
    }
    assert.equal(await raw("//attacker.invalid/v1/gates"), 404);
    assert.equal(await raw("attacker.invalid:443"), 400);
    assert.equal(calls, 0);
  });
});

test("HTTP challenge issuance is bounded by an injectable limiter", async () => {
  const { createGateHttpServer } = loadHttp();
  let issued = 0; let checks = 0;
  const server = createGateHttpServer({
    challengeLimiter: { allow() { checks += 1; return checks === 1; } },
    authService: {
      async issueChallenge() { issued += 1; return { challenge: true }; },
      async verifyProof() { return {}; }, async authenticateSession() { return {}; },
    },
    profileService: { async updateProfile() { return {}; }, async listPublicProfiles() { return []; }, async getPublicProfile() { return null; } },
  });
  await withServer(server, async (baseUrl) => {
    const options = { method: "POST", body: "{}" };
    assert.equal((await requestJson(baseUrl, "/v1/gate/auth/challenge", options)).status, 200);
    const limited = await requestJson(baseUrl, "/v1/gate/auth/challenge", options);
    assert.deepEqual({ status: limited.status, body: limited.body }, {
      status: 429, body: { error: { code: "RATE_LIMITED", message: "Too many authentication challenges" } },
    });
    assert.equal(issued, 1);
  });
});

test("HTTP auth failures are coarse and absolute-form or wrong-method targets do not route", async () => {
  const { ProfileRequestError } = loadProfileService();
  const { createGateHttpServer } = loadHttp();
  let profileCalls = 0;
  const server = createGateHttpServer({
    authService: {
      async issueChallenge() { throw new ProfileRequestError("nonce 0xprivate and verifier internals"); },
      async verifyProof() { throw new ProfileRequestError("signature 0xprivate and nonce row"); },
      async authenticateSession() { throw new Error("unused"); },
    },
    profileService: {
      async updateProfile() { profileCalls += 1; return {}; },
      async listPublicProfiles() { profileCalls += 1; return []; },
      async getPublicProfile() { profileCalls += 1; return null; },
    },
  });

  await withServer(server, async (baseUrl) => {
    const challenge = await requestJson(baseUrl, "/v1/gate/auth/challenge", { method: "POST", body: "{}" });
    assert.deepEqual(challenge.body, { error: { code: "INVALID_AUTH_CHALLENGE", message: "authentication challenge is invalid" } });
    const verify = await requestJson(baseUrl, "/v1/gate/auth/verify", { method: "POST", body: "{}" });
    assert.deepEqual(verify.body, { error: { code: "INVALID_AUTH_PROOF", message: "authentication proof is invalid" } });
    assert.equal((await requestJson(baseUrl, "/v1/gates", { method: "POST", body: "{}" })).status, 404);

    const { port } = server.address();
    const absolute = await new Promise((resolve, reject) => {
      const outgoing = http.request({ host: "127.0.0.1", port, method: "GET", path: "http://attacker.invalid/v1/gates" }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(absolute.status, 404);
    assert.equal(profileCalls, 0);
  });
});
