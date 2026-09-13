"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Interface, TypedDataEncoder, Wallet, ZeroAddress } = require("ethers");

const { ExecutionEngine } = require("../packages/core/src/execution/engine");
const { ExecutionState } = require("../packages/core/src/execution/lifecycle");
const { FileExecutionRecordStore } = require("../packages/core/src/execution/records");
const {
  SafeProposalAuthorization,
  SafeProposalProvider,
} = require("../packages/core/src/execution/providers/safe-proposal");
const { SafeSupervisedExecutionAdapter, safeStateFrom } = require("../packages/core/src/execution/executors/safe-supervised");
const { createProposalIdentity } = require("../packages/core/src/execution/identity/roles");
const { createVoteIntent } = require("../packages/core/src/intent/vote-intent");
const { createExecutionIntent } = require("../packages/core/src/intent/execution-intent");
const { validateExecutionIntent } = require("../packages/core/src/intent/validated");

const SAFE = "0x0000000000000000000000000000000000000003";
const OWNER = "0x00000000000000000000000000000000000000a1";
const TARGET = "0x0000000000000000000000000000000000000010";
const wallet = new Wallet(`0x${"11".repeat(32)}`);
const ATTACKER = "0x00000000000000000000000000000000000000ff";
const ZERO_PAYMENT_FIELDS = Object.freeze({
  safeTxGas: "0",
  baseGas: "0",
  gasPrice: "0",
  gasToken: ZeroAddress,
  refundReceiver: ZeroAddress,
});
const CANONICAL_BODY = Object.freeze({
  to: TARGET,
  value: "0",
  data: "0x12345678",
  operation: 0,
  ...ZERO_PAYMENT_FIELDS,
  nonce: 7,
});
const SAFE_TX_TYPES = Object.freeze({
  SafeTx: Object.freeze([
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ]),
});
const CANONICAL_DOMAIN = Object.freeze({ verifyingContract: SAFE, chainId: 1n });
const CANONICAL_HASH = TypedDataEncoder.hash(CANONICAL_DOMAIN, SAFE_TX_TYPES, CANONICAL_BODY);
const safeEvents = new Interface([
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
]);

function executionLog(name, safeTxHash) {
  const encoded = safeEvents.encodeEventLog(safeEvents.getEvent(name), [safeTxHash, 0n]);
  return { address: SAFE, topics: encoded.topics, data: encoded.data };
}

function identity(address = wallet.address, signingCalls = null) {
  return createProposalIdentity({
    safeAddress: SAFE,
    chainId: 1,
    signer: {
      address: async () => address,
      signTypedData: (...args) => {
        signingCalls?.push(args);
        return wallet.signTypedData(...args);
      },
    },
  });
}

function serviceTransaction(hash, overrides = {}) {
  return {
    safeTxHash: hash,
    proposedByDelegate: wallet.address,
    safe: SAFE,
    ...CANONICAL_BODY,
    nonce: "7",
    confirmations: [],
    confirmationsRequired: 2,
    isExecuted: false,
    ...overrides,
  };
}

function kits({ owners = [OWNER], delegates, delegateError, transaction, proposeError } = {}) {
  const calls = { created: [], proposed: [] };
  const safeTransaction = transaction || { data: { ...CANONICAL_BODY } };
  const protocolKit = {
    getOwners: async () => owners,
    getThreshold: async () => Math.min(2, owners.length),
    getNonce: async () => 7,
    getChainId: async () => 1n,
    getSafeProvider: () => ({
      getTransaction: async () => ({ to: SAFE }),
      getExternalProvider: () => ({
        getTransactionReceipt: async () => ({ status: "success" }),
      }),
    }),
    getContractVersion: () => "1.3.0",
    createTransaction: async (input) => {
      calls.created.push(input);
      return safeTransaction;
    },
    getTransactionHash: async () => CANONICAL_HASH,
  };
  const apiKit = {
    getSafeDelegates: async () => {
      if (delegateError) throw new Error(delegateError);
      return delegates ?? {
        count: 1,
        next: null,
        previous: null,
        results: [{ safe: SAFE, delegate: wallet.address, delegator: OWNER, label: "gavel", expiryDate: "2099-01-01T00:00:00Z" }],
      };
    },
    getNextNonce: async () => "7",
    proposeTransaction: async (input) => {
      calls.proposed.push(input);
      if (proposeError) throw new Error(proposeError);
    },
    getTransaction: async (hash) => {
      if (!calls.proposed.some((proposal) => proposal.safeTxHash.toLowerCase() === String(hash).toLowerCase())) {
        const error = new Error("not found");
        error.statusCode = 404;
        throw error;
      }
      return serviceTransaction(hash);
    },
  };
  return { protocolKit, apiKit, calls };
}

function provider(overrides = {}) {
  const dependencies = kits(overrides);
  return {
    dependencies,
    provider: new SafeProposalProvider({
      safeAddress: SAFE,
      chainId: 1,
      proposalIdentity: overrides.proposalIdentity || identity(),
      protocolKit: dependencies.protocolKit,
      apiKit: dependencies.apiKit,
      generateTypedData: overrides.generateTypedData,
    }),
  };
}

function validated() {
  const voteIntent = createVoteIntent({
    dao: "test-dao",
    chainId: 1,
    voterAddress: SAFE,
    proposalId: "42",
    support: "FOR",
    reason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const adapter = {
    id: "test-dao",
    chainId: 1,
    adapterVersion: "test@1.0.0",
    governanceContracts: { governor: TARGET },
    governanceTargets: [TARGET],
    governanceSelectors: { CAST_VOTE: ["0x12345678"] },
    capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: false },
    supportedActions: ["CAST_VOTE"],
    decodeGovernanceCall: () => ({ proposalId: "42", support: "FOR", reason: null }),
    validateProposal() {}, getVotingPower() {}, getCurrentDelegate() {}, hasVoted() {}, prepareVote() {},
  };
  return validateExecutionIntent({
    adapter,
    voteIntent,
    intent: createExecutionIntent({ voteIntent, actor: SAFE, target: TARGET, value: 0n, data: "0x12345678" }),
    evidence: {
      adapterVersion: "test@1.0.0",
      validatedAt: "2026-01-01T00:00:00.000Z",
      proposalState: "ACTIVE",
      proposalStateVotable: true,
      governanceTarget: TARGET,
      selector: "0x12345678",
      actorEligible: true,
      autonomyAllowed: false,
      deadline: { kind: "block", value: "100" },
      semantics: { canVoteMultipleTimes: false, canReplaceVote: false },
      checks: [{ code: "VALID", passed: true, detail: "ok" }],
    },
  });
}

test("authorization distinguishes an authorized delegate from denial, owner conflict, and service failure", async () => {
  assert.equal((await provider().provider.authorization()).status, SafeProposalAuthorization.AUTHORIZED);
  assert.equal(
    (await provider({ delegates: { count: 0, next: null, previous: null, results: [] } }).provider.authorization()).status,
    SafeProposalAuthorization.NOT_AUTHORIZED,
  );
  assert.equal(
    (await provider({ owners: [OWNER, wallet.address] }).provider.authorization()).status,
    SafeProposalAuthorization.OWNER_CONFLICT,
  );
  assert.equal(
    (await provider({ owners: [OWNER, wallet.address], delegateError: "offline" }).provider.authorization()).status,
    SafeProposalAuthorization.OWNER_CONFLICT,
  );
  assert.equal(
    (await provider({ delegateError: "offline" }).provider.authorization()).status,
    SafeProposalAuthorization.SERVICE_UNAVAILABLE,
  );
});

test("authorization requires the delegate entry delegator to be a current onchain owner", async () => {
  const staleOwner = "0x00000000000000000000000000000000000000b1";
  const setup = provider({
    owners: [OWNER],
    delegates: {
      count: 1,
      next: null,
      previous: null,
      results: [{
        safe: SAFE,
        delegate: wallet.address,
        delegator: staleOwner,
        label: "stale",
        expiryDate: "2099-01-01T00:00:00Z",
      }],
    },
  });

  assert.equal((await setup.provider.authorization()).status, SafeProposalAuthorization.NOT_AUTHORIZED);
});

test("authorization paginates delegate results before denying authorization", async () => {
  const setup = provider({ delegates: { count: 2, next: "https://safe.test/delegates?limit=1&offset=1", previous: null, results: [] } });
  const calls = [];
  setup.dependencies.apiKit.getSafeDelegates = async (query) => {
    calls.push(query);
    if (!query.offset) {
      return {
        count: 2,
        next: "https://safe.test/delegates?limit=1&offset=1",
        previous: null,
        results: [{
          safe: SAFE,
          delegate: wallet.address,
          delegator: "0x00000000000000000000000000000000000000b1",
          label: "stale",
          expiryDate: "2099-01-01T00:00:00Z",
        }],
      };
    }
    return {
      count: 2,
      next: null,
      previous: "https://safe.test/delegates?limit=1&offset=0",
      results: [{
        safe: SAFE,
        delegate: wallet.address,
        delegator: OWNER,
        label: "gavel",
        expiryDate: "2099-01-01T00:00:00Z",
      }],
    };
  };

  assert.equal((await setup.provider.authorization()).status, SafeProposalAuthorization.AUTHORIZED);
  assert.deepEqual(calls.map(({ offset }) => offset ?? 0), [0, 1]);
});

test("ProposalIdentity pins its normalized signer address at construction", async () => {
  let currentAddress = wallet.address;
  const proposalIdentity = createProposalIdentity({
    safeAddress: SAFE,
    chainId: 1,
    signer: {
      address: async () => currentAddress,
      signTypedData: async () => "0xsigned",
    },
  });

  const pinned = await proposalIdentity.address();
  currentAddress = Wallet.createRandom().address;

  assert.equal(await proposalIdentity.address(), pinned);
  assert.notEqual(await proposalIdentity.address(), currentAddress);
});

test("ProposalIdentity rejects chainless Safe typed-data domains even with trusted scope", async () => {
  const signed = [];
  const proposalIdentity = createProposalIdentity({
    safeAddress: SAFE,
    chainId: 1,
    signer: {
      address: async () => wallet.address,
      signTypedData: async (domain, types, message) => {
        signed.push({ domain, types, message });
        return `0x${"11".repeat(65)}`;
      },
    },
  });
  const payload = {
    domain: { verifyingContract: SAFE },
    types: { SafeTx: [{ name: "nonce", type: "uint256" }] },
    message: { nonce: 7 },
  };

  await assert.rejects(proposalIdentity.proposeSafeTransaction(payload), /scoped to this chain/i);
  await assert.rejects(proposalIdentity.proposeSafeTransaction(payload, { chainId: 8453 }), /scoped to this chain/i);
  await assert.rejects(proposalIdentity.proposeSafeTransaction(payload, { chainId: 1 }), /scoped to this chain/i);

  assert.equal(signed.length, 0);
});

test("prepare accepts only a validated intent and builds and signs through Protocol Kit", async () => {
  const setup = provider();
  await assert.rejects(setup.provider.prepare({ intent: validated().intent }), /ValidatedExecutionIntent/);

  const prepared = await setup.provider.prepare(validated());

  assert.equal(prepared.safeTxHash, CANONICAL_HASH);
  assert.equal(prepared.safeNonce, "7");
  assert.equal(prepared.safeTransactionData.to, TARGET);
  assert.equal(prepared.safeTransactionData.nonce, 7);
  assert.equal(prepared.senderAddress, wallet.address);
  assert.match(prepared.senderSignature, /^0x[0-9a-f]+$/i);
  assert.deepEqual(setup.dependencies.calls.created, [{
    transactions: [{ to: TARGET, value: "0", data: "0x12345678", operation: 0 }],
    options: { nonce: 7, ...ZERO_PAYMENT_FIELDS },
  }]);
});

test("prepare fails closed before transaction construction for every non-authorized status", async () => {
  for (const overrides of [
    { delegates: { count: 0, next: null, previous: null, results: [] } },
    { owners: [OWNER, wallet.address] },
    { delegateError: "offline" },
  ]) {
    const setup = provider(overrides);
    await assert.rejects(setup.provider.prepare(validated()), /not authorized|owner|unavailable/i);
    assert.equal(setup.dependencies.calls.created.length, 0);
  }
});

test("production provider rejects every non-zero Safe payment field before signing or POST", async () => {
  const cases = [
    ["gasPrice", "1"],
    ["refundReceiver", ATTACKER],
    ["gasToken", ATTACKER],
    ["safeTxGas", "1"],
    ["baseGas", "1"],
  ];
  for (const [field, value] of cases) {
    const signingCalls = [];
    const setup = provider({
      proposalIdentity: identity(wallet.address, signingCalls),
      transaction: { data: { ...CANONICAL_BODY, [field]: value } },
    });
    await assert.rejects(
      setup.provider.prepare(validated()),
      (error) => error.code === "UNSAFE_SAFE_PAYMENT_FIELDS" && error.message.includes(field),
      field,
    );
    assert.equal(signingCalls.length, 0, `${field} reached signing`);
    assert.equal(setup.dependencies.calls.proposed.length, 0, `${field} reached proposal POST`);
  }
});

test("production provider binds the SDK hash to the independently encoded typed-data digest", async () => {
  const signingCalls = [];
  const setup = provider({ proposalIdentity: identity(wallet.address, signingCalls) });
  setup.dependencies.protocolKit.getTransactionHash = async () => `0x${"ab".repeat(32)}`;

  await assert.rejects(
    setup.provider.prepare(validated()),
    (error) => error.code === "HASH_TYPED_DATA_MISMATCH",
  );
  assert.equal(signingCalls.length, 0);
  assert.equal(setup.dependencies.calls.proposed.length, 0);
});

test("production provider rejects legacy, unknown, and unreviewed patch Safe versions before typed-data signing", async () => {
  for (const version of ["1.1.1", "1.2.0", "1.3.1", "1.3.999", "1.4.0", "1.4.999", "1.5.0", "2.0.0", "99.0.0"]) {
    const signingCalls = [];
    const setup = provider({ proposalIdentity: identity(wallet.address, signingCalls) });
    setup.dependencies.protocolKit.getContractVersion = () => version;
    await assert.rejects(
      setup.provider.prepare(validated()),
      (error) => error.code === "UNSUPPORTED_SAFE_VERSION",
      version,
    );
    assert.equal(signingCalls.length, 0, `${version} reached signing`);
    assert.equal(setup.dependencies.calls.proposed.length, 0, `${version} reached POST`);
  }
});

test("production provider rejects missing or mismatched typed-data domain scope before signing", async () => {
  const domains = [
    ["missing-chain", { verifyingContract: SAFE }],
    ["wrong-chain", { verifyingContract: SAFE, chainId: 8453n }],
    ["wrong-safe", { verifyingContract: ATTACKER, chainId: 1n }],
  ];
  for (const [name, domain] of domains) {
    const signingCalls = [];
    const setup = provider({
      proposalIdentity: identity(wallet.address, signingCalls),
      generateTypedData: () => ({ domain, types: SAFE_TX_TYPES, message: { ...CANONICAL_BODY } }),
    });
    await assert.rejects(setup.provider.prepare(validated()), /SAFE_TYPED_DATA_DOMAIN_MISMATCH/);
    assert.equal(signingCalls.length, 0, `${name} reached signing`);
    assert.equal(setup.dependencies.calls.proposed.length, 0, `${name} reached POST`);
  }
});

test("production provider accepts only explicitly reviewed Safe versions with one canonical body", async () => {
  for (const version of ["1.3.0", "1.4.1"]) {
    const signingCalls = [];
    const setup = provider({ proposalIdentity: identity(wallet.address, signingCalls) });
    setup.dependencies.protocolKit.getContractVersion = () => version;
    const intent = validated();
    const prepared = await setup.provider.prepare(intent);
    const submitted = await setup.provider.submit(intent, prepared);
    assert.equal(signingCalls.length, 2);
    assert.equal(setup.dependencies.calls.proposed.length, 1);
    assert.deepEqual(prepared.safeTransactionData, CANONICAL_BODY);
    assert.deepEqual(setup.dependencies.calls.proposed[0].safeTransactionData, CANONICAL_BODY);
    assert.equal(prepared.safeTxHash, CANONICAL_HASH);
    assert.deepEqual(
      Object.fromEntries(Object.keys(CANONICAL_BODY).map((field) => [field, submitted.transaction[field]])),
      CANONICAL_BODY,
    );
  }
});

test("production readback requires and verifies every Safe payment field before status", async () => {
  for (const field of Object.keys(ZERO_PAYMENT_FIELDS)) {
    for (const mode of ["missing", "mismatch"]) {
      const setup = provider();
      setup.dependencies.apiKit.getTransaction = async (hash) => {
        const transaction = serviceTransaction(hash);
        if (mode === "missing") delete transaction[field];
        else transaction[field] = ["gasToken", "refundReceiver"].includes(field) ? ATTACKER : "1";
        transaction.isExecuted = true;
        transaction.isSuccessful = true;
        transaction.transactionHash = `0x${"cd".repeat(32)}`;
        return transaction;
      };
      await assert.rejects(
        setup.provider.getTransaction(CANONICAL_HASH),
        /malformed Safe service transaction|UNSAFE_SAFE_PAYMENT_FIELDS/,
        `${field}:${mode}`,
      );
    }
  }
});

test("prepare rejects malformed SDK transaction and hash output", async () => {
  const malformedTransaction = provider({ transaction: { data: { to: TARGET } } });
  await assert.rejects(malformedTransaction.provider.prepare(validated()), /SAFE_TRANSACTION_BODY_MALFORMED/);

  const malformedHash = provider();
  malformedHash.dependencies.protocolKit.getTransactionHash = async () => "not-a-hash";
  await assert.rejects(malformedHash.provider.prepare(validated()), /malformed Safe transaction hash/i);
});

test("getTransaction rejects readback with omitted confirmations", async () => {
  const setup = provider();
  setup.dependencies.apiKit.getTransaction = async (hash) => ({
    safeTxHash: hash,
    proposedByDelegate: wallet.address,
    safe: SAFE,
    ...ZERO_PAYMENT_FIELDS,
    to: TARGET,
    data: "0x12345678",
    value: "0",
    operation: 0,
    nonce: "7",
    confirmationsRequired: 2,
    isExecuted: false,
  });

  await assert.rejects(setup.provider.getTransaction(`0x${"ab".repeat(32)}`), /malformed Safe service transaction/i);
});

test("getTransaction rejects executed readback without definitive success and transaction hash", async () => {
  for (const executedFields of [
    { isSuccessful: null, transactionHash: `0x${"cd".repeat(32)}` },
    { isSuccessful: true, transactionHash: null },
    { isSuccessful: true, transactionHash: "not-a-hash" },
  ]) {
    const setup = provider();
    setup.dependencies.apiKit.getTransaction = async (hash) => ({
      safeTxHash: hash,
      proposedByDelegate: wallet.address,
      safe: SAFE,
      to: TARGET,
      data: "0x12345678",
      value: "0",
      operation: 0,
      nonce: "7",
      confirmations: [{ owner: OWNER }],
      confirmationsRequired: 1,
      isExecuted: true,
      ...executedFields,
    });

    await assert.rejects(
      setup.provider.getTransaction(`0x${"ab".repeat(32)}`),
      /malformed Safe service transaction/i,
    );
  }
});

test("status counts only unique confirmations from fresh onchain owners and uses the onchain threshold", async () => {
  const setup = provider({ owners: [OWNER, "0x00000000000000000000000000000000000000a2"] });
  setup.dependencies.protocolKit.getThreshold = async () => 2;
  setup.dependencies.apiKit.getTransaction = async (hash) => ({
    safeTxHash: hash, proposedByDelegate: wallet.address, safe: SAFE, ...ZERO_PAYMENT_FIELDS, to: TARGET, data: "0x12345678", value: "0", operation: 0, nonce: "7",
    confirmations: [{ owner: OWNER }, { owner: OWNER }], confirmationsRequired: 1, isExecuted: false,
  });

  const transaction = await setup.provider.getTransaction(`0x${"ab".repeat(32)}`);
  assert.equal(transaction.authoritativeConfirmations, 1);
  assert.equal(transaction.onchainThreshold, 2);
});

test("status rejects confirmations attributed to addresses outside the fresh onchain owner set", async () => {
  const setup = provider();
  setup.dependencies.apiKit.getTransaction = async (hash) => ({
    safeTxHash: hash, proposedByDelegate: wallet.address, safe: SAFE, ...ZERO_PAYMENT_FIELDS, to: TARGET, data: "0x12345678", value: "0", operation: 0, nonce: "7",
    confirmations: [{ owner: "0x00000000000000000000000000000000000000ff" }],
    confirmationsRequired: 1, isExecuted: false,
  });
  await assert.rejects(setup.provider.getTransaction(`0x${"ab".repeat(32)}`), /current onchain Safe owner/i);
});

test("provider fails closed when the configured chain differs from Protocol Kit", async () => {
  const setup = provider();
  setup.dependencies.protocolKit.getChainId = async () => 8453n;
  await assert.rejects(setup.provider.prepare(validated()), /configured chain.*RPC chain/i);
});

test("executed status requires an onchain receipt for a transaction sent to the Safe", async () => {
  const setup = provider();
  setup.dependencies.apiKit.getTransaction = async (hash) => ({
    safeTxHash: hash, proposedByDelegate: wallet.address, safe: SAFE, ...ZERO_PAYMENT_FIELDS, to: TARGET, data: "0x12345678", value: "0", operation: 0, nonce: "7",
    confirmations: [{ owner: OWNER }], confirmationsRequired: 1, isExecuted: true,
    isSuccessful: true, transactionHash: `0x${"cd".repeat(32)}`,
  });
  setup.dependencies.protocolKit.getSafeProvider = () => ({
    getTransaction: async () => ({ to: TARGET }),
    getExternalProvider: () => ({
      getTransactionReceipt: async () => ({ status: "success" }),
    }),
  });
  await assert.rejects(setup.provider.getTransaction(`0x${"ab".repeat(32)}`), /execution transaction.*Safe/i);
});

test("executed status rejects a successful unrelated Safe transaction without the expected execution event", async () => {
  const setup = provider();
  const expectedHash = `0x${"ab".repeat(32)}`;
  setup.dependencies.apiKit.getTransaction = async () => ({
    safeTxHash: expectedHash, proposedByDelegate: wallet.address, safe: SAFE, ...ZERO_PAYMENT_FIELDS, to: TARGET,
    data: "0x12345678", value: "0", operation: 0, nonce: "7",
    confirmations: [{ owner: OWNER }], confirmationsRequired: 1, isExecuted: true,
    isSuccessful: true, transactionHash: `0x${"cd".repeat(32)}`,
  });
  setup.dependencies.protocolKit.getSafeProvider = () => ({
    getTransaction: async () => ({ to: SAFE, data: "0xdeadbeef" }),
    getExternalProvider: () => ({ getTransactionReceipt: async () => ({ status: "success", logs: [] }) }),
  });

  await assert.rejects(setup.provider.getTransaction(expectedHash), /expected Safe execution event/i);
});

test("executed status accepts only a Safe execution event for the expected hash", async () => {
  const setup = provider();
  const expectedHash = `0x${"ab".repeat(32)}`;
  setup.dependencies.apiKit.getTransaction = async () => ({
    safeTxHash: expectedHash, proposedByDelegate: wallet.address, safe: SAFE, ...ZERO_PAYMENT_FIELDS, to: TARGET,
    data: "0x12345678", value: "0", operation: 0, nonce: "7",
    confirmations: [{ owner: OWNER }], confirmationsRequired: 1, isExecuted: true,
    isSuccessful: true, transactionHash: `0x${"cd".repeat(32)}`,
  });
  setup.dependencies.protocolKit.getSafeProvider = () => ({
    getTransaction: async () => ({ to: SAFE }),
    getExternalProvider: () => ({
      getTransactionReceipt: async () => ({ status: "success", logs: [executionLog("ExecutionSuccess", expectedHash)] }),
    }),
  });

  assert.equal((await setup.provider.getTransaction(expectedHash)).onchainExecutionStatus, "success");
});

test("status ignores injected rejection fields and cancels only after the onchain Safe nonce is consumed", async () => {
  const setup = provider();
  const expectedHash = `0x${"ab".repeat(32)}`;
  setup.dependencies.apiKit.getTransaction = async () => ({
    safeTxHash: expectedHash, proposedByDelegate: wallet.address, safe: SAFE, ...ZERO_PAYMENT_FIELDS, to: TARGET,
    data: "0x12345678", value: "0", operation: 0, nonce: "7", rejected: true,
    confirmations: [], confirmationsRequired: 2, isExecuted: false,
  });
  setup.dependencies.protocolKit.getNonce = async () => 7;
  assert.equal(safeStateFrom(await setup.provider.getTransaction(expectedHash)), ExecutionState.AWAITING_AUTHORIZATION);
  setup.dependencies.protocolKit.getNonce = async () => 8;
  assert.equal(safeStateFrom(await setup.provider.getTransaction(expectedHash)), ExecutionState.CANCELLED);
});

test("readback requires attribution to the configured proposal delegate", async () => {
  const setup = provider();
  const expectedHash = `0x${"ab".repeat(32)}`;
  setup.dependencies.apiKit.getTransaction = async () => ({
    safeTxHash: expectedHash, safe: SAFE, ...ZERO_PAYMENT_FIELDS, to: TARGET, data: "0x12345678", value: "0",
    operation: 0, nonce: "7", confirmations: [], confirmationsRequired: 2, isExecuted: false,
  });
  await assert.rejects(setup.provider.getTransaction(expectedHash), /proposal delegate/i);
});

test("provider getTransaction and submit bind readback to the expected Safe transaction", async () => {
  const expectedHash = `0x${"ab".repeat(32)}`;
  const wrongHash = `0x${"cd".repeat(32)}`;

  const wrongIdentity = provider();
  wrongIdentity.dependencies.apiKit.getTransaction = async () => ({
    safeTxHash: wrongHash,
    proposedByDelegate: wallet.address,
    safe: SAFE,
    ...ZERO_PAYMENT_FIELDS,
    to: TARGET,
    data: "0x12345678",
    value: "0",
    operation: 0,
    nonce: "7",
    confirmations: [],
    confirmationsRequired: 2,
    isExecuted: false,
  });
  await assert.rejects(wrongIdentity.provider.getTransaction(expectedHash), /different transaction|expected/i);

  const wrongIntent = provider();
  const intent = validated();
  const prepared = await wrongIntent.provider.prepare(intent);
  wrongIntent.dependencies.apiKit.getTransaction = async (hash) => ({
    safeTxHash: hash,
    proposedByDelegate: wallet.address,
    safe: SAFE,
    ...ZERO_PAYMENT_FIELDS,
    to: "0x00000000000000000000000000000000000000ff",
    data: "0x12345678",
    value: "0",
    operation: 0,
    nonce: "7",
    confirmations: [],
    confirmationsRequired: 2,
    isExecuted: false,
  });
  await assert.rejects(wrongIntent.provider.submit(intent, prepared), /different transaction|expected/i);
});

test("submit rebuilds from the validated intent, rechecks authorization, and normalizes readback chainId", async () => {
  const setup = provider();
  const intent = validated();
  const prepared = await setup.provider.prepare(intent);

  const result = await setup.provider.submit(intent, prepared, { origin: "gavel-test" });

  assert.equal(setup.dependencies.calls.created.length, 2);
  assert.equal(setup.dependencies.calls.proposed.length, 1);
  assert.deepEqual(setup.dependencies.calls.proposed[0], {
    safeAddress: SAFE,
    safeTransactionData: prepared.safeTransactionData,
    safeTxHash: prepared.safeTxHash,
    senderAddress: wallet.address,
    senderSignature: result.proposal.senderSignature,
    origin: "gavel-test",
  });
  assert.equal(result.transaction.chainId, 1);
  assert.equal(result.transaction.safeTxHash, prepared.safeTxHash);
  assert.equal(result.proposal.safeNonce, "7");
});

test("submit invokes write-ahead only after preflight and immediately before the Transaction Service POST", async () => {
  const setup = provider();
  const intent = validated();
  const prepared = await setup.provider.prepare(intent);
  const order = [];
  const propose = setup.dependencies.apiKit.proposeTransaction;
  setup.dependencies.apiKit.proposeTransaction = async (...args) => {
    order.push("post");
    return propose(...args);
  };

  await setup.provider.submit(intent, prepared, {
    beforeProviderDispatch: async () => { order.push("write-ahead"); },
  });

  assert.deepEqual(order, ["write-ahead", "post"]);
});

test("definitive Transaction Service rejection is classified as definitely not submitted", async () => {
  const setup = provider();
  const intent = validated();
  const prepared = await setup.provider.prepare(intent);
  setup.dependencies.apiKit.proposeTransaction = async () => {
    const error = new Error("invalid sender");
    error.statusCode = 422;
    throw error;
  };

  await assert.rejects(
    setup.provider.submit(intent, prepared, { beforeProviderDispatch: async () => {} }),
    (error) => error.submissionOutcome === "definitely-not-submitted",
  );
});

test("submit fails closed if the delegate becomes an owner after prepare", async () => {
  const setup = provider();
  const intent = validated();
  const prepared = await setup.provider.prepare(intent);
  setup.dependencies.protocolKit.getOwners = async () => [OWNER, wallet.address];

  await assert.rejects(setup.provider.submit(intent, prepared), /owner/i);
  assert.equal(setup.dependencies.calls.proposed.length, 0);
});

test("submit rejects altered preparations and malformed service readback", async () => {
  const altered = provider();
  const intent = validated();
  const prepared = await altered.provider.prepare(intent);
  await assert.rejects(
    altered.provider.submit(intent, { ...prepared, safeTxHash: `0x${"cd".repeat(32)}` }),
    /SAFE_PREPARATION_INTEGRITY_MISMATCH/,
  );
  assert.equal(altered.dependencies.calls.proposed.length, 0);

  const alteredBody = provider();
  const bodyPrepared = await alteredBody.provider.prepare(intent);
  await assert.rejects(
    alteredBody.provider.submit(intent, {
      ...bodyPrepared,
      safeTransactionData: { ...bodyPrepared.safeTransactionData, gasPrice: "1" },
    }),
    /SAFE_PREPARATION_INTEGRITY_MISMATCH/,
  );
  assert.equal(alteredBody.dependencies.calls.proposed.length, 0);

  const malformed = provider();
  const malformedPrepared = await malformed.provider.prepare(intent);
  malformed.dependencies.apiKit.getTransaction = async () => ({ safeTxHash: malformedPrepared.safeTxHash });
  await assert.rejects(malformed.provider.submit(intent, malformedPrepared), /malformed Safe service transaction/i);
});

test("SafeSupervisedExecutionAdapter requires the same immutable effective identity as its provider", () => {
  const setup = provider();
  const otherWallet = new Wallet(`0x${"22".repeat(32)}`);
  const otherIdentity = createProposalIdentity({
    safeAddress: SAFE,
    chainId: 1,
    signer: { address: async () => otherWallet.address, signTypedData: (...args) => otherWallet.signTypedData(...args) },
  });

  assert.throws(() => new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity: otherIdentity,
    proposalProvider: setup.provider,
  }), /same.*identity|identity.*provider/i);

  const adapter = new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity: setup.provider.proposalIdentity,
    proposalProvider: setup.provider,
  });
  assert.throws(() => { adapter.proposalIdentity = otherIdentity; }, /read only|getter|property/i);
  assert.strictEqual(adapter.getProposalIdentity(), setup.provider.proposalIdentity);
});

test("SafeSupervisedExecutionAdapter rejects the legacy hand-rolled transactionService path", () => {
  const setup = provider();
  assert.throws(
    () => new SafeSupervisedExecutionAdapter({
      safeAddress: SAFE,
      chainId: 1,
      proposalIdentity: setup.provider.proposalIdentity,
      transactionService: setup.dependencies.apiKit,
      safeInfo: { getOwners: async () => [OWNER] },
    }),
    /legacy|proposalProvider|unsupported/i,
  );
});

test("SafeSupervisedExecutionAdapter serializes nonce allocation per Safe", async () => {
  const setup = provider();
  const adapter = new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity: setup.provider.proposalIdentity,
    proposalProvider: setup.provider,
  });

  assert.deepEqual(adapter.lockKeys(), [`safe-nonce:1:${SAFE.toLowerCase()}`]);
});

test("SafeSupervisedExecutionAdapter consumes SafeProposalProvider without legacy clients", async () => {
  const setup = provider();
  const adapter = new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity: setup.provider.proposalIdentity,
    proposalProvider: setup.provider,
  });

  const preparation = await adapter.prepare(validated());
  const submitted = await adapter.submit(preparation);

  assert.equal(preparation.payload.safeTxHash, CANONICAL_HASH);
  assert.equal(submitted.providerData.safeNonce, "7");
  assert.equal(setup.dependencies.calls.proposed.length, 1);
});

test("a PREPARED record reconciles a definite miss before posting the persisted canonical transaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-safe-prepared-"));
  const setup = provider();
  const makeEngine = () => new ExecutionEngine({
    adapters: [new SafeSupervisedExecutionAdapter({
      safeAddress: SAFE,
      chainId: 1,
      proposalIdentity: setup.provider.proposalIdentity,
      proposalProvider: setup.provider,
    })],
    store: new FileExecutionRecordStore(root),
  });

  await makeEngine().prepare(validated(), { mode: "safe-supervised", blockNumber: 50 });
  const retried = await makeEngine().submit(validated(), { mode: "safe-supervised", blockNumber: 50 });

  assert.equal(setup.dependencies.calls.proposed.length, 1);
  assert.equal(retried.deduplicated, false);
  assert.equal(retried.record.state, ExecutionState.SUBMITTED);
  assert.deepEqual(setup.dependencies.calls.proposed[0].safeTransactionData, CANONICAL_BODY);
});

test("a definite service miss reuses the PREPARED Safe nonce instead of allocating another", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-safe-missing-"));
  const setup = provider();
  const makeEngine = () => new ExecutionEngine({
    adapters: [new SafeSupervisedExecutionAdapter({
      safeAddress: SAFE,
      chainId: 1,
      proposalIdentity: setup.provider.proposalIdentity,
      proposalProvider: setup.provider,
    })],
    store: new FileExecutionRecordStore(root),
  });

  await makeEngine().prepare(validated(), { mode: "safe-supervised", blockNumber: 50 });
  const getTransaction = setup.dependencies.apiKit.getTransaction;
  let reads = 0;
  setup.dependencies.apiKit.getTransaction = async (...args) => {
    reads += 1;
    return reads === 1 ? null : getTransaction(...args);
  };
  setup.dependencies.apiKit.getNextNonce = async () => "8";
  await makeEngine().submit(validated(), { mode: "safe-supervised", blockNumber: 50 });

  assert.equal(setup.dependencies.calls.proposed.length, 1);
  assert.equal(String(setup.dependencies.calls.proposed[0].safeTransactionData.nonce), "7");
});

test("a restart reconciles an accepted Safe proposal after the POST times out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-safe-restart-"));
  const setup = provider({ proposeError: "timeout after accepted POST" });
  const makeEngine = () => new ExecutionEngine({
    adapters: [new SafeSupervisedExecutionAdapter({
      safeAddress: SAFE,
      chainId: 1,
      proposalIdentity: setup.provider.proposalIdentity,
      proposalProvider: setup.provider,
    })],
    store: new FileExecutionRecordStore(root),
  });

  await assert.rejects(
    makeEngine().submit(validated(), { mode: "safe-supervised", blockNumber: 50 }),
    /timeout after accepted POST/,
  );
  const retried = await makeEngine().submit(validated(), { mode: "safe-supervised", blockNumber: 50 });

  assert.equal(setup.dependencies.calls.proposed.length, 1);
  assert.equal(retried.deduplicated, true);
  assert.equal(retried.record.state, ExecutionState.AWAITING_AUTHORIZATION);
  assert.equal(retried.record.providerData.providerStatus, "pending");
});

test("SafeProposalProvider is exported from @gavel/core", () => {
  const core = require("../packages/core");
  assert.strictEqual(core.SafeProposalProvider, SafeProposalProvider);
  assert.strictEqual(core.SafeProposalAuthorization, SafeProposalAuthorization);
});
