"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Interface, Wallet } = require("ethers");

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
const safeEvents = new Interface([
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
]);

function executionLog(name, safeTxHash) {
  const encoded = safeEvents.encodeEventLog(safeEvents.getEvent(name), [safeTxHash, 0n]);
  return { address: SAFE, topics: encoded.topics, data: encoded.data };
}

function identity(address = wallet.address) {
  return createProposalIdentity({
    safeAddress: SAFE,
    chainId: 1,
    signer: {
      address: async () => address,
      signTypedData: (...args) => wallet.signTypedData(...args),
    },
  });
}

function kits({ owners = [OWNER], delegates, delegateError, transaction, proposeError } = {}) {
  const calls = { created: [], proposed: [] };
  const safeTransaction = transaction || {
    data: {
      to: TARGET,
      value: "0",
      data: "0x12345678",
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: 7,
    },
  };
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
    getTransactionHash: async () => `0x${"ab".repeat(32)}`,
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
    getTransaction: async (hash) => ({
      safeTxHash: hash,
      proposedByDelegate: wallet.address,
      safe: SAFE,
      to: TARGET,
      data: "0x12345678",
      value: "0",
      operation: 0,
      nonce: "7",
      confirmations: [],
      confirmationsRequired: 2,
      isExecuted: false,
    }),
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

test("ProposalIdentity accepts a legacy Safe domain only with explicit trusted chain scope", async () => {
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
  await proposalIdentity.proposeSafeTransaction(payload, { chainId: 1 });

  assert.deepEqual(signed[0].domain, { verifyingContract: SAFE });
  assert.equal("chainId" in signed[0].domain, false);
});

test("prepare accepts only a validated intent and builds and signs through Protocol Kit", async () => {
  const setup = provider();
  await assert.rejects(setup.provider.prepare({ intent: validated().intent }), /ValidatedExecutionIntent/);

  const prepared = await setup.provider.prepare(validated());

  assert.equal(prepared.safeTxHash, `0x${"ab".repeat(32)}`);
  assert.equal(prepared.safeNonce, "7");
  assert.equal(prepared.safeTransactionData.to, TARGET);
  assert.equal(prepared.safeTransactionData.nonce, 7);
  assert.equal(prepared.senderAddress, wallet.address);
  assert.match(prepared.senderSignature, /^0x[0-9a-f]+$/i);
  assert.deepEqual(setup.dependencies.calls.created, [{
    transactions: [{ to: TARGET, value: "0", data: "0x12345678", operation: 0 }],
    options: { nonce: 7 },
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

test("prepare rejects malformed SDK transaction and hash output", async () => {
  const malformedTransaction = provider({ transaction: { data: { to: TARGET } } });
  await assert.rejects(malformedTransaction.provider.prepare(validated()), /malformed Safe transaction/i);

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
    safeTxHash: hash, proposedByDelegate: wallet.address, safe: SAFE, to: TARGET, data: "0x12345678", value: "0", operation: 0, nonce: "7",
    confirmations: [{ owner: OWNER }, { owner: OWNER }], confirmationsRequired: 1, isExecuted: false,
  });

  const transaction = await setup.provider.getTransaction(`0x${"ab".repeat(32)}`);
  assert.equal(transaction.authoritativeConfirmations, 1);
  assert.equal(transaction.onchainThreshold, 2);
});

test("status rejects confirmations attributed to addresses outside the fresh onchain owner set", async () => {
  const setup = provider();
  setup.dependencies.apiKit.getTransaction = async (hash) => ({
    safeTxHash: hash, proposedByDelegate: wallet.address, safe: SAFE, to: TARGET, data: "0x12345678", value: "0", operation: 0, nonce: "7",
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
    safeTxHash: hash, proposedByDelegate: wallet.address, safe: SAFE, to: TARGET, data: "0x12345678", value: "0", operation: 0, nonce: "7",
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
    safeTxHash: expectedHash, proposedByDelegate: wallet.address, safe: SAFE, to: TARGET,
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
    safeTxHash: expectedHash, proposedByDelegate: wallet.address, safe: SAFE, to: TARGET,
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
    safeTxHash: expectedHash, proposedByDelegate: wallet.address, safe: SAFE, to: TARGET,
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
    safeTxHash: expectedHash, safe: SAFE, to: TARGET, data: "0x12345678", value: "0",
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
    /altered/i,
  );
  assert.equal(altered.dependencies.calls.proposed.length, 0);

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

  assert.equal(preparation.payload.safeTxHash, `0x${"ab".repeat(32)}`);
  assert.equal(submitted.providerData.safeNonce, "7");
  assert.equal(setup.dependencies.calls.proposed.length, 1);
});

test("a PREPARED record is reconciled before any Safe proposal POST", async () => {
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

  assert.equal(setup.dependencies.calls.proposed.length, 0);
  assert.equal(retried.deduplicated, true);
  assert.equal(retried.record.state, ExecutionState.AWAITING_AUTHORIZATION);
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
