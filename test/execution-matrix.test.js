"use strict";

/**
 * The DAO adapter x execution adapter matrix.
 *
 * Every other execution test uses a stub on one side or the other. This one
 * uses the real adapters on both, so it is the test that actually proves the
 * boundary holds: a real Nouns or ENS adapter produces a validated intent, and
 * a real Safe or WaaP execution adapter consumes it, with no DAO code below the
 * boundary and no provider code above it.
 */

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { TypedDataEncoder, Wallet, getAddress } = require("ethers");

const { NounsDaoAdapter } = require("../packages/nouns-adapter");
const { ENS_GOVERNOR_ADDRESS, EnsDaoAdapter } = require("../packages/ens-adapter");
const { RailgunDaoAdapter } = require("../packages/railgun-adapter");
const { assertCanonicalGovernanceAdapter } = require("../packages/core/src/dao/contract");
const { assertModeSupported } = require("../packages/core/src/dao/registry");
const { ExecutionEngine } = require("../packages/core/src/execution/engine");
const { ExecutionState } = require("../packages/core/src/execution/lifecycle");
const { InMemoryExecutionRecordStore } = require("../packages/core/src/execution/records");
const { InMemoryEventSink } = require("../packages/core/src/execution/events");
const { SafeSupervisedExecutionAdapter } = require("../packages/core/src/execution/executors/safe-supervised");
const { WaapAutonomousExecutionAdapter } = require("../packages/core/src/execution/executors/waap-autonomous");
const {
  createExecutionIdentity,
  createProposalIdentity,
} = require("../packages/core/src/execution/identity/roles");
const { prediction, proposal, security, VOTER } = require("./helpers/nouns-preparation");

const SAFE = "0x0000000000000000000000000000000000000003";
const NOW = new Date("2026-09-02T00:00:00.000Z");
const proposerWallet = new Wallet(`0x${"11".repeat(32)}`);
const executorWallet = new Wallet(`0x${"22".repeat(32)}`);

const SAFE_TX_TYPES = Object.freeze({
  SafeTx: [
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
  ],
});

function walletSigner(wallet) {
  return {
    async address() {
      return wallet.address;
    },
    async signTypedData(domain, types, message) {
      return wallet.signTypedData(domain, types, message);
    },
  };
}

/** A prediction whose review has cleared, so autonomy can be exercised. */
function autonomousPrediction(overrides = {}) {
  return prediction({
    predictionReview: { requiresHumanReview: false, autonomyAllowed: true, reasonCodes: [], backtest: null },
    ...overrides,
  });
}

// ---------------------------------------------------------------- Nouns

function nounsAdapter(overrides = {}) {
  const actor = overrides.actor || SAFE;
  return new NounsDaoAdapter({
    provider: {
      getNetwork: async () => ({ chainId: BigInt(overrides.chainId ?? 1) }),
      getBlockNumber: async () => 150,
      getCode: async () => "0x6000",
      call: async () => "0x",
      estimateGas: async () => 123456n,
    },
    governance: {
      state: async () => BigInt(overrides.state ?? 1),
      proposals: async () => ({ id: 42n, startBlock: 100n, endBlock: 200n }),
      getActions: async () => ({
        targets: ["0x2222222222222222222222222222222222222222"],
        values: [0n],
        signatures: ["ping()"],
        calldatas: ["0x"],
      }),
      getReceipt: async () => ({ hasVoted: overrides.hasVoted ?? false, support: 0n, votes: 0n }),
    },
    nounsToken: {
      getPriorVotes: async () => overrides.votingPower ?? 3n,
      getCurrentVotes: async () => overrides.votingPower ?? 3n,
      delegates: async () => overrides.delegatee ?? actor,
    },
    now: () => NOW,
    freshnessVerifier: async () => ({
      version: 1,
      latestEvent: "ProposalCreated",
      latestBlock: "90",
      eventDigest: "0xfeed",
      description: "Untrusted proposal prose",
    }),
  });
}

async function nounsIntent(overrides = {}) {
  const adapter = nounsAdapter(overrides);
  const { validated, blockers } = await adapter.prepareValidatedIntent({
    prediction: overrides.autonomous ? autonomousPrediction() : prediction(),
    proposal: proposal(),
    selectedSupport: overrides.support || "FOR",
    executionAddress: overrides.actor || SAFE,
    assetOwnerAddress: VOTER,
    acknowledgeSecurityReview: true,
    acknowledgePredictionReview: true,
  });
  return { adapter, validated, blockers };
}

// ------------------------------------------------------------------ ENS

const ENS_DESCRIPTION = "Fund the ENS public goods round";
const ENS_ACTION = { index: 0, target: "0x2222222222222222222222222222222222222222", valueWei: "0", signature: "ping()", calldata: "0x" };

function ensProposal() {
  // The ENS adapter recomputes the content hash from canonical material and
  // refuses a proposal whose stated hash disagrees, so the fixture has to
  // derive it the same way rather than assert a constant.
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        description: ENS_DESCRIPTION,
        targets: [ENS_ACTION.target],
        values: [ENS_ACTION.valueWei],
        signatures: [ENS_ACTION.signature],
        calldatas: [ENS_ACTION.calldata],
      }),
    )
    .digest("hex");
  return {
    id: "77",
    contentHash,
    title: "ENS public goods",
    description: ENS_DESCRIPTION,
    proposer: "0x3333333333333333333333333333333333333333",
    state: "ACTIVE",
    outcome: "ACTIVE",
    createdBlock: "90",
    createdAt: "2026-01-01T00:00:00.000Z",
    startBlock: "100",
    endBlock: "300",
    quorumVotes: "10",
    forVotes: "2",
    againstVotes: "1",
    abstainVotes: "0",
    actions: [ENS_ACTION],
    dao: "ens",
    chainId: 1,
  };
}

function ensAdapter(overrides = {}) {
  const actor = overrides.actor || SAFE;
  return new EnsDaoAdapter({
    provider: {
      getNetwork: async () => ({ chainId: 1n }),
      getBlockNumber: async () => 150,
      getCode: async () => "0x6000",
      call: async () => "0x",
      estimateGas: async () => 123456n,
    },
    governor: {
      state: async () => BigInt(overrides.state ?? 1),
      proposalSnapshot: async () => 100n,
      proposalDeadline: async () => 300n,
      hasVoted: async () => overrides.hasVoted ?? false,
      getVotes: async () => overrides.votingPower ?? 5n,
      hashProposal: async () => 77n,
      quorum: async () => 10n,
      proposalVotes: async () => ({ againstVotes: 1n, forVotes: 2n, abstainVotes: 0n }),
    },
    token: {
      getVotes: async () => overrides.votingPower ?? 5n,
      getPastVotes: async () => overrides.votingPower ?? 5n,
      delegates: async () => overrides.delegatee ?? actor,
    },
    now: () => NOW,
  });
}

async function ensIntent(overrides = {}) {
  const adapter = ensAdapter(overrides);
  const ens = ensProposal();
  const { validated, blockers, preparation } = await adapter.prepareValidatedIntent({
    prediction: prediction({
      dao: "ens",
      proposalId: ens.id,
      proposalContentHash: ens.contentHash,
      security: security({ proposalId: ens.id, proposalContentHash: ens.contentHash }),
    }),
    proposal: ens,
    selectedSupport: "FOR",
    executionAddress: overrides.actor || SAFE,
    assetOwnerAddress: VOTER,
    acknowledgeSecurityReview: true,
    acknowledgePredictionReview: true,
  });
  return { adapter, validated, blockers, preparation, proposal: ens };
}

// ------------------------------------------------------ execution adapters

function safeExecution(options = {}) {
  const proposals = [];
  const proposed = new Map();
  const proposalIdentity = createProposalIdentity({
    signer: walletSigner(proposerWallet),
    safeAddress: SAFE,
    chainId: 1,
    label: "safe-proposer-main",
  });
  const service = options.transactionService || {
    async getNextNonce() {
      return 11;
    },
    async proposeTransaction(input) {
      proposals.push(input);
      proposed.set(input.safeTxHash, input.safeTransactionData);
      return { safeTxHash: input.safeTxHash, confirmationsRequired: 2, confirmations: [] };
    },
    async getTransaction(safeTxHash) {
      const body = proposed.get(safeTxHash);
      if (!body) return null;
      return {
        safeTxHash,
        safe: SAFE,
        chainId: 1,
        to: body.to,
        data: body.data,
        value: body.value,
        operation: body.operation,
        safeTxGas: body.safeTxGas,
        baseGas: body.baseGas,
        gasPrice: body.gasPrice,
        gasToken: body.gasToken,
        refundReceiver: body.refundReceiver,
        nonce: String(body.nonce),
        confirmations: [],
        confirmationsRequired: 2,
        isExecuted: false,
      };
    },
  };
  const readOwners = options.safeInfo?.getOwners
    ? () => options.safeInfo.getOwners(SAFE)
    : async () => ["0x00000000000000000000000000000000000000a1"];
  const assertAuthorized = async () => {
    const owners = await readOwners();
    if (!Array.isArray(owners) || owners.length === 0) throw new Error("Safe owner reader returned no owners");
    if (owners.map(getAddress).includes(getAddress(await proposalIdentity.address()))) {
      throw new Error("Gavel must not be a Safe owner");
    }
  };
  const build = async (validated, nonce) => {
    const safeTransactionData = {
      to: getAddress(validated.intent.target),
      value: String(validated.intent.value),
      data: validated.intent.data,
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: String(nonce),
    };
    const domain = { chainId: 1, verifyingContract: SAFE };
    const safeTxHash = TypedDataEncoder.hash(domain, SAFE_TX_TYPES, safeTransactionData);
    return {
      safeAddress: SAFE,
      chainId: 1,
      safeNonce: String(nonce),
      safeTransactionData,
      safeTxHash,
      senderAddress: await proposalIdentity.address(),
      senderSignature: await proposalIdentity.proposeSafeTransaction({ domain, types: SAFE_TX_TYPES, message: safeTransactionData }),
    };
  };
  const proposalProvider = {
    proposalIdentity,
    async prepare(validated) {
      await assertAuthorized();
      return build(validated, await service.getNextNonce(SAFE));
    },
    async submit(validated, preparation, submitOptions = {}) {
      await assertAuthorized();
      const proposal = await build(validated, preparation.safeNonce);
      if (String(preparation.safeTxHash).toLowerCase() !== proposal.safeTxHash.toLowerCase()) {
        throw new Error("The Safe preparation was altered between prepare and submit");
      }
      const response = await service.proposeTransaction({
        safeAddress: SAFE,
        chainId: 1,
        safeTransactionData: proposal.safeTransactionData,
        safeTxHash: proposal.safeTxHash,
        senderAddress: proposal.senderAddress,
        senderSignature: proposal.senderSignature,
        origin: submitOptions.origin,
      });
      if (response?.safeTxHash && response.safeTxHash.toLowerCase() !== proposal.safeTxHash.toLowerCase()) {
        throw new Error("The Safe Transaction Service returned a different safeTxHash than Gavel computed");
      }
      const transaction = await service.getTransaction(proposal.safeTxHash);
      if (!transaction) throw new Error("The Safe proposal could not be read back and verified");
      return { proposal, transaction };
    },
    getTransaction: (safeTxHash) => service.getTransaction(safeTxHash),
  };
  const adapter = new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity,
    proposalProvider,
  });
  adapter.proposals = proposals;
  return adapter;
}

function waapExecution(options = {}) {
  const broadcasts = [];
  const adapter = new WaapAutonomousExecutionAdapter({
    chainId: 1,
    executionIdentity: createExecutionIdentity({
      signer: walletSigner(executorWallet),
      chainId: 1,
      policyId: "governance-only",
      broadcaster: {
        async broadcast(request) {
          broadcasts.push(request);
          return { transactionHash: `0x${"cd".repeat(32)}`, confirmed: true };
        },
      },
    }),
    policy: options.policy || (async () => ({ allowed: true, policyId: "governance-only" })),
  });
  adapter.broadcasts = broadcasts;
  return adapter;
}

function engine(adapters, store = new InMemoryExecutionRecordStore(), events = new InMemoryEventSink()) {
  return { engine: new ExecutionEngine({ adapters, store, events, now: () => NOW }), store, events };
}

/** Every submit needs a block number: a block deadline is unverifiable without one. */
const AT_BLOCK = { blockNumber: 150 };

// ------------------------------------------------------------------ tests

test("every DAO adapter satisfies the canonical governance contract", () => {
  for (const adapter of [nounsAdapter(), ensAdapter(), new RailgunDaoAdapter({ provider: {} })]) {
    assertCanonicalGovernanceAdapter(adapter);
    assert.match(adapter.adapterVersion, /^[a-z-]+@\d+\.\d+\.\d+$/, adapter.id);
    assert.ok(Array.isArray(adapter.governanceTargets), adapter.id);
    assert.ok(adapter.governanceSelectors.CAST_VOTE.length > 0, adapter.id);
  }
});

test("Nouns x SafeSupervised: a validated vote becomes a Safe proposal", async () => {
  const { validated, blockers } = await nounsIntent();
  assert.deepEqual(blockers, []);
  assert.equal(validated.dao, "nouns");
  // The deadline came from the proposal, so the execution layer can expire it.
  assert.deepEqual(validated.validation.deadline, { kind: "block", value: "200" });

  const safe = safeExecution();
  const { engine: runner, events } = engine([safe]);
  const result = await runner.submit(validated, { mode: "safe-supervised", ...AT_BLOCK });

  assert.equal(result.record.state, ExecutionState.SUBMITTED);
  assert.equal(result.record.providerData.safeNonce, "11");
  const [proposed] = safe.proposals;
  // The exact calldata the Nouns adapter built, unchanged.
  assert.equal(proposed.safeTransactionData.data, validated.intent.data);
  assert.equal(getAddress(proposed.safeTransactionData.to), getAddress(validated.intent.target));
  assert.equal(JSON.parse(proposed.origin).dao, "nouns");
  assert.ok(events.names().includes("safe.proposed"));
});

test("Nouns x WaapAutonomous: the same governance path, a different backend", async () => {
  const { validated } = await nounsIntent({ actor: executorWallet.address, autonomous: true });
  assert.equal(validated.validation.autonomyAllowed, true);

  const waap = waapExecution();
  const { engine: runner } = engine([waap]);
  const result = await runner.submit(validated, { mode: "waap-autonomous", ...AT_BLOCK });

  assert.equal(result.record.state, ExecutionState.EXECUTED);
  assert.equal(waap.broadcasts[0].data, validated.intent.data);
  assert.equal(waap.broadcasts[0].intentHash, validated.intentHash);

  // No DAO code ran below the boundary: the execution adapter never saw the
  // adapter, the proposal, or a governor ABI.
  assert.equal(Object.prototype.hasOwnProperty.call(waap, "adapter"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(waap, "governanceContracts"), false);
});

test("ENS x SafeSupervised: a second DAO over the same execution adapter", async () => {
  const { validated, blockers } = await ensIntent();
  assert.deepEqual(blockers, []);
  assert.equal(validated.dao, "ens");
  assert.equal(getAddress(validated.intent.target), ENS_GOVERNOR_ADDRESS);
  assert.equal(validated.validation.selector, "0x7b3c71d3");
  assert.deepEqual(validated.validation.deadline, { kind: "block", value: "300" });

  const safe = safeExecution();
  const { engine: runner } = engine([safe]);
  const result = await runner.submit(validated, { mode: "safe-supervised", ...AT_BLOCK });

  assert.equal(result.record.state, ExecutionState.SUBMITTED);
  assert.equal(result.record.dao, "ens");
  assert.equal(result.record.proposalId, "77");
  // The Safe adapter is the same code that handled Nouns, with no ENS branch.
  assert.equal(JSON.parse(safe.proposals[0].origin).dao, "ens");
});

test("ENS x WaapAutonomous is refused by adapter capability, not by the executor", async () => {
  const ens = ensAdapter();
  assert.equal(ens.capabilities.waapAutonomous, false);
  assert.throws(() => assertModeSupported(ens, "waap-autonomous"), /ens does not support waap-autonomous/);
  assert.equal(assertModeSupported(ens, "safe-supervised"), ens);
});

test("Railgun is an adapter limitation, not an execution-layer exception", async () => {
  const railgun = new RailgunDaoAdapter({ provider: {} });

  // Railgun's voting-key model is not the delegate model `execution-status`
  // verifies, so the adapter declares that it supports neither remote mode.
  // That is a fact the adapter states about itself.
  assert.equal(railgun.capabilities.prepareVote, true);
  assert.equal(railgun.capabilities.safeSupervised, false);
  assert.equal(railgun.capabilities.waapAutonomous, false);
  assert.throws(() => assertModeSupported(railgun, "safe-supervised"), /railgun-eth does not support/);

  // The limitation lives in the adapter's capabilities, never as a branch in
  // the execution layer. No execution-layer module mentions any DAO.
  const fs = require("node:fs");
  const path = require("node:path");
  const executionRoot = path.resolve(__dirname, "..", "packages", "core", "src", "execution");
  const walk = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(target) : entry.name.endsWith(".js") ? [target] : [];
    });
  for (const file of walk(executionRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const dao of ["railgun", "nouns", "Nouns", "Railgun", "ENS"]) {
      // Doc comments may name DAOs to explain why a rule exists; code may not.
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(withoutComments, new RegExp(dao), `${file} contains DAO-specific code for ${dao}`);
    }
  }

  // Railgun still declares its real semantics, so if it ever gains an
  // execution mode, replay protection is already correct for it.
  assert.deepEqual(railgun.getExecutionSemantics(), { canVoteMultipleTimes: true, canReplaceVote: false });
});

test("the matrix fails closed on every documented failure case", async () => {
  // Mutation after validation: the intent is frozen, so the calldata a Safe
  // proposal carries cannot be changed after the fact.
  const { validated } = await nounsIntent();
  assert.throws(() => {
    validated.intent.data = "0xdeadbeef";
  }, TypeError);

  // Wrong chain.
  const wrongChain = await nounsIntent({ chainId: 8453 });
  assert.equal(wrongChain.validated, null);
  assert.ok(wrongChain.blockers.some((blocker) => blocker.code === "WRONG_CHAIN"));

  // Wrong actor: delegation points somewhere other than the execution address.
  const wrongActor = await nounsIntent({ delegatee: "0x00000000000000000000000000000000000000ff" });
  assert.equal(wrongActor.validated, null);
  assert.ok(wrongActor.blockers.some((blocker) => blocker.code === "DELEGATION_MISMATCH"));

  // A Safe adapter configured for a different Safe than the intent's actor.
  const otherSafe = await nounsIntent({ actor: executorWallet.address, delegatee: executorWallet.address });
  await assert.rejects(
    engine([safeExecution()]).engine.submit(otherSafe.validated, { mode: "safe-supervised", ...AT_BLOCK }),
    /not the configured Safe/,
  );

  // Expired governance proposal: nothing is submitted.
  const safe = safeExecution();
  await assert.rejects(
    engine([safe]).engine.submit(validated, { mode: "safe-supervised", blockNumber: 201 }),
    (error) => error.code === "GOVERNANCE_WINDOW_CLOSED",
  );
  assert.equal(safe.proposals.length, 0);

  // Duplicate submission returns the existing execution.
  const duplicating = safeExecution();
  const { engine: runner } = engine([duplicating]);
  const first = await runner.submit(validated, { mode: "safe-supervised", ...AT_BLOCK });
  const second = await runner.submit(validated, { mode: "safe-supervised", ...AT_BLOCK });
  assert.equal(duplicating.proposals.length, 1);
  assert.equal(second.deduplicated, true);
  assert.equal(second.record.id, first.record.id);

  // Safe delegate revoked: an explicit authorization error, not a silent skip.
  const revoked = safeExecution({
    transactionService: {
      async getNextNonce() {
        return 11;
      },
      async proposeTransaction() {
        throw new Error("403 Client Error: delegate is not authorized for this Safe");
      },
      async getTransaction() {
        return null;
      },
    },
  });
  await assert.rejects(
    engine([revoked]).engine.submit(validated, { mode: "safe-supervised", ...AT_BLOCK }),
    /delegate is not authorized/,
  );

  // WaaP policy rejection: no broadcast.
  const autonomous = await nounsIntent({ actor: executorWallet.address, autonomous: true });
  const blocked = waapExecution({ policy: async () => ({ allowed: false, reason: "daily cap" }) });
  await assert.rejects(
    engine([blocked]).engine.submit(autonomous.validated, { mode: "waap-autonomous", ...AT_BLOCK }),
    /daily cap/,
  );
  assert.equal(blocked.broadcasts.length, 0);

  // An advisory recommendation is never executed autonomously.
  const advisory = await nounsIntent({ actor: executorWallet.address });
  const advisoryWaap = waapExecution();
  await assert.rejects(
    engine([advisoryWaap]).engine.submit(advisory.validated, { mode: "waap-autonomous", ...AT_BLOCK }),
    (error) => error.code === "AUTONOMY_NOT_AUTHORIZED",
  );
  assert.equal(advisoryWaap.broadcasts.length, 0);
});

test("one intent hash links the whole audit chain across both DAOs", async () => {
  for (const build of [nounsIntent, ensIntent]) {
    const { validated } = await build();
    const safe = safeExecution();
    const { engine: runner, events } = engine([safe]);
    const result = await runner.submit(validated, { mode: "safe-supervised", ...AT_BLOCK });

    // proposal -> recommendation -> VoteIntent -> ExecutionIntent -> validation
    // -> intentHash -> Safe proposal -> safeTxHash -> status.
    assert.equal(result.record.intentHash, validated.intentHash);
    assert.equal(result.record.voteIntentHash, validated.intent.source.voteIntentHash);
    assert.equal(result.record.audit.adapterVersion, validated.validation.adapterVersion);
    assert.equal(result.record.audit.proposalState, "ACTIVE");
    assert.ok(result.record.providerData.safeTxHash);
    assert.equal(JSON.parse(safe.proposals[0].origin).intentHash, validated.intentHash);
    for (const event of events.events) {
      assert.equal(event.intentHash, validated.intentHash, event.event);
    }
  }
});
