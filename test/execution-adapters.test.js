"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface, TypedDataEncoder, Wallet } = require("ethers");

const {
  SAFE_TX_TYPES,
  SafeSupervisedExecutionAdapter,
  safeStateFrom,
} = require("../packages/core/src/execution/executors/safe-supervised");
const {
  PolicyRejected,
  WaapAutonomousExecutionAdapter,
  assertPolicyApproval,
} = require("../packages/core/src/execution/executors/waap-autonomous");
const { ExecutionEngine } = require("../packages/core/src/execution/engine");
const { ExecutionState } = require("../packages/core/src/execution/lifecycle");
const { ExecutionEvent, InMemoryEventSink } = require("../packages/core/src/execution/events");
const { InMemoryExecutionRecordStore } = require("../packages/core/src/execution/records");
const {
  createExecutionIdentity,
  createProposalIdentity,
} = require("../packages/core/src/execution/identity/roles");
const { createVoteIntent } = require("../packages/core/src/intent/vote-intent");
const { createExecutionIntent } = require("../packages/core/src/intent/execution-intent");
const { validateExecutionIntent } = require("../packages/core/src/intent/validated");

// Real Nouns vote calldata, so the canonical boundary can bind the encoded
// proposal and support to the intent that claims them.
const voteInterface = new Interface([
  "function castRefundableVoteWithReason(uint256 proposalId,uint8 support,string reason,uint32 clientId)",
]);
const SELECTOR = voteInterface.getFunction("castRefundableVoteWithReason").selector;

function voteCalldata({ proposalId = 42, support = "FOR", reason = "Consistent with prior votes." } = {}) {
  const code = { AGAINST: 0, FOR: 1, ABSTAIN: 2 }[support];
  return voteInterface.encodeFunctionData("castRefundableVoteWithReason", [proposalId, code, reason ?? "", 38]);
}

const VOTER = "0x0000000000000000000000000000000000000001";
const SAFE = "0x0000000000000000000000000000000000000003";
const GOVERNOR = "0x0000000000000000000000000000000000000010";
const OWNER_A = "0x00000000000000000000000000000000000000a1";
const OWNER_B = "0x00000000000000000000000000000000000000a2";
const NOW = new Date("2026-09-02T00:00:00.000Z");

const proposerWallet = new Wallet(`0x${"11".repeat(32)}`);
const executorWallet = new Wallet(`0x${"22".repeat(32)}`);

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

function dao() {
  return {
    id: "nouns",
    chainId: 1,
    adapterVersion: "nouns@2.0.0",
    governanceContracts: { governor: GOVERNOR },
    governanceTargets: [GOVERNOR],
    decodeGovernanceCall(action, data) {
      const decoded = voteInterface.decodeFunctionData("castRefundableVoteWithReason", data);
      return {
        proposalId: decoded[0].toString(),
        support: ["AGAINST", "FOR", "ABSTAIN"][Number(decoded[1])],
        reason: decoded[2] === "" ? null : decoded[2],
      };
    },
    governanceSelectors: { CAST_VOTE: [SELECTOR] },
    capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    validateProposal() {}, getVotingPower() {}, getCurrentDelegate() {}, hasVoted() {}, prepareVote() {},
  };
}

function validated(overrides = {}) {
  const { actor = SAFE, support = "FOR", reason = "Consistent with prior votes.", ...evidence } = overrides;
  const voteIntent = createVoteIntent({
    dao: "nouns",
    chainId: 1,
    voterAddress: VOTER,
    proposalId: "42",
    support,
    reason,
    createdAt: NOW.toISOString(),
  });
  return validateExecutionIntent({
    adapter: dao(),
    voteIntent,
    intent: createExecutionIntent({ voteIntent, actor, target: GOVERNOR, value: 0n, data: voteCalldata({ support, reason }) }),
    evidence: {
      adapterVersion: "nouns@2.0.0",
      validatedAt: NOW.toISOString(),
      proposalState: "ACTIVE",
      proposalStateVotable: true,
      governanceTarget: GOVERNOR,
      selector: SELECTOR,
      actorEligible: true,
      autonomyAllowed: false,
      deadline: { kind: "block", value: "200" },
      semantics: { canVoteMultipleTimes: false, canReplaceVote: false },
      checks: [{ code: "PROPOSAL_STATE_VOTABLE", passed: true, detail: "ACTIVE" }],
      ...evidence,
    },
  });
}

/** A Safe Transaction Service double. */
function transactionService(overrides = {}) {
  const proposals = [];
  return {
    proposals,
    async getNextNonce() {
      return overrides.nonce ?? 7;
    },
    async proposeTransaction(input) {
      proposals.push(input);
      if (overrides.proposeError) throw new Error(overrides.proposeError);
      return {
        safeTxHash: overrides.returnedHash ?? input.safeTxHash,
        confirmations: overrides.confirmations,
        confirmationsRequired: overrides.confirmationsRequired ?? 2,
        ...overrides.proposeResponse,
      };
    },
    async getTransaction(safeTxHash) {
      if (overrides.missing) return null;
      return {
        safeTxHash: overrides.statusHash ?? safeTxHash,
        safe: overrides.statusSafe ?? SAFE,
        chainId: overrides.statusChainId ?? 1,
        to: overrides.statusTo ?? GOVERNOR,
        data: overrides.statusData ?? voteCalldata(),
        value: overrides.statusValue ?? "0",
        operation: overrides.statusOperation ?? 0,
        nonce: String(overrides.nonce ?? 7),
        confirmations: overrides.statusConfirmations ?? [],
        confirmationsRequired: overrides.confirmationsRequired ?? 2,
        isExecuted: overrides.isExecuted ?? false,
        isSuccessful: overrides.isSuccessful,
        transactionHash: overrides.transactionHash,
      };
    },
  };
}

function safeAdapter(options = {}) {
  return new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity:
      options.proposalIdentity ||
      createProposalIdentity({
        signer: walletSigner(proposerWallet),
        safeAddress: SAFE,
        chainId: 1,
        label: "safe-proposer-main",
      }),
    transactionService: options.transactionService || transactionService(options.service),
    safeInfo: options.safeInfo === null ? undefined : options.safeInfo || { getOwners: async () => [OWNER_A, OWNER_B] },
  });
}

function waapAdapter(options = {}) {
  const broadcasts = [];
  const adapter = new WaapAutonomousExecutionAdapter({
    chainId: 1,
    executionIdentity:
      options.executionIdentity ||
      createExecutionIdentity({
        signer: walletSigner(executorWallet),
        chainId: 1,
        policyId: "governance-only",
        broadcaster: {
          async broadcast(request) {
            broadcasts.push(request);
            if (options.broadcastError) throw new Error(options.broadcastError);
            return { transactionHash: `0x${"cd".repeat(32)}`, confirmed: options.confirmed ?? false };
          },
        },
      }),
    policy: options.policy || (async () => ({ allowed: true, policyId: "governance-only" })),
    client: options.client,
  });
  adapter.broadcasts = broadcasts;
  return adapter;
}

test("Safe supervised mode proposes a validated vote and never becomes a Safe owner", async () => {
  const events = new InMemoryEventSink();
  const service = transactionService();
  const adapter = safeAdapter({
    transactionService: service,
    safeInfo: { getOwners: async () => ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2"] },
  });
  const engine = new ExecutionEngine({ adapters: [adapter], events, store: new InMemoryExecutionRecordStore(), now: () => NOW });

  const result = await engine.submit(validated(), { mode: "safe-supervised", blockNumber: 150 });

  assert.equal(result.record.state, ExecutionState.SUBMITTED);
  assert.equal(result.record.providerData.safeNonce, "7");
  assert.equal(result.record.providerData.safeAddress, SAFE);

  // The Safe transaction is built from the validated intent, unchanged.
  const [proposal] = service.proposals;
  assert.equal(proposal.safeAddress, SAFE);
  assert.equal(proposal.safeTransactionData.to, GOVERNOR);
  assert.equal(proposal.safeTransactionData.data, voteCalldata());
  assert.equal(proposal.safeTransactionData.value, "0");
  assert.equal(proposal.safeTransactionData.operation, 0);
  assert.equal(proposal.safeTransactionData.nonce, "7");

  // The proposer signs as itself, and the Safe -- not the proposer -- is the
  // address the vote is cast from.
  assert.equal(proposal.senderAddress, proposerWallet.address);
  assert.equal(await adapter.getExecutionAddress(), SAFE);
  assert.notEqual(proposerWallet.address, SAFE);

  // The signature is a real SafeTx signature over the locally computed hash.
  const expectedHash = TypedDataEncoder.hash(
    { chainId: 1, verifyingContract: SAFE },
    SAFE_TX_TYPES,
    proposal.safeTransactionData,
  );
  assert.equal(proposal.safeTxHash, expectedHash);
  assert.equal(result.record.providerData.safeTxHash, expectedHash);

  // Governance provenance rides alongside the transaction, never in its calldata.
  const origin = JSON.parse(proposal.origin);
  assert.equal(origin.intentHash, result.record.intentHash);
  assert.equal(origin.dao, "nouns");
  assert.equal(origin.proposalId, "42");
  assert.equal(origin.support, "FOR");

  assert.ok(events.names().includes(ExecutionEvent.SAFE_PROPOSED));
  // No key material anywhere on the adapter.
  for (const leak of ["privateKey", "signer", "key"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(adapter, leak), false, leak);
  }
});

test("Safe supervised mode refuses to run with a proposer that is a Safe owner", async () => {
  const adapter = safeAdapter({
    safeInfo: { getOwners: async () => ["0x00000000000000000000000000000000000000a1", proposerWallet.address] },
  });
  const engine = new ExecutionEngine({ adapters: [adapter], store: new InMemoryExecutionRecordStore(), now: () => NOW });

  // If Gavel's key is an owner, its signature counts toward the threshold and
  // supervised mode is a fiction.
  await assert.rejects(
    engine.submit(validated(), { mode: "safe-supervised", blockNumber: 150 }),
    /must not be a Safe owner/,
  );
});

test("Safe supervised mode does not trust the Transaction Service", async () => {
  // A service returning a different safeTxHash is swapping the transaction
  // behind the proposal.
  const swapping = new ExecutionEngine({
    adapters: [safeAdapter({ service: { returnedHash: `0x${"ff".repeat(32)}` } })],
    store: new InMemoryExecutionRecordStore(),
    now: () => NOW,
  });
  await assert.rejects(
    swapping.submit(validated(), { mode: "safe-supervised", blockNumber: 150 }),
    /different safeTxHash than Gavel computed/,
  );

  // A service reporting Gavel's proposer as a confirming owner means the key is
  // an owner after all.
  const confirming = new ExecutionEngine({
    adapters: [safeAdapter({ service: { statusConfirmations: [{ owner: proposerWallet.address }] } })],
    store: new InMemoryExecutionRecordStore(),
    now: () => NOW,
  });
  await assert.rejects(
    confirming.submit(validated(), { mode: "safe-supervised", blockNumber: 150 }),
    /never count toward\s+the Safe threshold/,
  );
});

test("Safe status reports human authorization progress and re-verifies the proposal", async () => {
  const store = new InMemoryExecutionRecordStore();
  const submitted = await new ExecutionEngine({ adapters: [safeAdapter()], store, now: () => NOW }).submit(
    validated(),
    { mode: "safe-supervised", blockNumber: 150 },
  );
  const recordId = submitted.record.id;

  // One of two signatures: a human still has to act.
  const partly = new ExecutionEngine({
    adapters: [safeAdapter({ service: { statusConfirmations: [{ owner: "0x00000000000000000000000000000000000000a1" }] } })],
    store,
    now: () => NOW,
  });
  assert.equal((await partly.status(recordId)).state, ExecutionState.AWAITING_AUTHORIZATION);

  // Threshold met.
  const authorized = new ExecutionEngine({
    adapters: [
      safeAdapter({
        service: {
          statusConfirmations: [
            { owner: "0x00000000000000000000000000000000000000a1" },
            { owner: "0x00000000000000000000000000000000000000a2" },
          ],
        },
      }),
    ],
    store,
    now: () => NOW,
  });
  assert.equal((await authorized.status(recordId)).state, ExecutionState.AUTHORIZED);

  // Executed onchain.
  const executed = new ExecutionEngine({
    adapters: [safeAdapter({ service: { isExecuted: true, transactionHash: `0x${"ee".repeat(32)}` } })],
    store,
    now: () => NOW,
  });
  const done = await executed.status(recordId);
  assert.equal(done.state, ExecutionState.EXECUTED);
  assert.equal(done.providerData.transactionHash, `0x${"ee".repeat(32)}`);
  assert.deepEqual(done.history.map((entry) => entry.state), [
    ExecutionState.VALIDATED,
    ExecutionState.PREPARED,
    ExecutionState.SUBMITTED,
    ExecutionState.AWAITING_AUTHORIZATION,
    ExecutionState.AUTHORIZED,
    ExecutionState.EXECUTED,
  ]);

  // A service that starts describing a different transaction for a known hash
  // is the provider-compromise case, and it surfaces on every poll.
  for (const tampering of [{ statusTo: "0x00000000000000000000000000000000000000ff" }, { statusData: "0xdeadbeef" }]) {
    const tampered = new ExecutionEngine({ store: new InMemoryExecutionRecordStore(), adapters: [safeAdapter({ service: tampering })], store, now: () => NOW });
    await assert.rejects(tampered.status(recordId), /no longer matches the validated intent/);
  }
  const unknown = new ExecutionEngine({ adapters: [safeAdapter({ service: { missing: true } })], store, now: () => NOW });
  await assert.rejects(unknown.status(recordId), /does not know/);
});

test("Safe mode maps provider vocabulary onto the canonical lifecycle", () => {
  assert.equal(safeStateFrom({ isExecuted: true }), ExecutionState.EXECUTED);
  assert.equal(safeStateFrom({ isExecuted: true, isSuccessful: false }), ExecutionState.FAILED);
  assert.equal(safeStateFrom({ rejected: true }), ExecutionState.CANCELLED);
  assert.equal(safeStateFrom({ confirmations: [1, 2], confirmationsRequired: 2 }), ExecutionState.AUTHORIZED);
  assert.equal(safeStateFrom({ confirmations: [1], confirmationsRequired: 2 }), ExecutionState.AWAITING_AUTHORIZATION);
  assert.equal(safeStateFrom({}), ExecutionState.AWAITING_AUTHORIZATION);
});

test("the Safe adapter refuses mismatched Safes, chains, identities, and actors", async () => {
  const identity = createProposalIdentity({ signer: walletSigner(proposerWallet), safeAddress: SAFE, chainId: 1 });

  assert.throws(
    () =>
      new SafeSupervisedExecutionAdapter({
        safeAddress: "0x0000000000000000000000000000000000000005",
        chainId: 1,
        proposalIdentity: identity,
        transactionService: transactionService(),
      }),
    /scoped to a different Safe/,
  );
  assert.throws(
    () =>
      new SafeSupervisedExecutionAdapter({
        safeAddress: SAFE,
        chainId: 8453,
        proposalIdentity: identity,
        transactionService: transactionService(),
      }),
    /scoped to a different chain/,
  );
  // An execution identity cannot drive supervised mode.
  assert.throws(
    () =>
      new SafeSupervisedExecutionAdapter({
        safeAddress: SAFE,
        chainId: 1,
        proposalIdentity: createExecutionIdentity({
          signer: walletSigner(executorWallet),
          chainId: 1,
          broadcaster: { broadcast: async () => ({}) },
        }),
        transactionService: transactionService(),
      }),
    /A ProposalIdentity is required/,
  );
  assert.throws(
    () => new SafeSupervisedExecutionAdapter({ safeAddress: SAFE, chainId: 1, proposalIdentity: identity, transactionService: {} }),
    /missing getNextNonce/,
  );

  // An intent actored by someone other than the configured Safe.
  const engine = new ExecutionEngine({ store: new InMemoryExecutionRecordStore(), adapters: [safeAdapter()], now: () => NOW });
  await assert.rejects(
    engine.submit(validated({ actor: "0x0000000000000000000000000000000000000004" }), { mode: "safe-supervised", blockNumber: 150 }),
    /not the configured Safe/,
  );
});

test("autonomous mode executes only what the governance layer and the policy both allow", async () => {
  const events = new InMemoryEventSink();
  const adapter = waapAdapter({ confirmed: true });
  const engine = new ExecutionEngine({ adapters: [adapter], events, store: new InMemoryExecutionRecordStore(), now: () => NOW });

  const result = await engine.submit(
    validated({ actor: executorWallet.address, autonomyAllowed: true }),
    { mode: "waap-autonomous", blockNumber: 150 },
  );
  assert.equal(result.record.state, ExecutionState.EXECUTED);
  assert.equal(result.record.providerData.transactionHash, `0x${"cd".repeat(32)}`);
  assert.deepEqual(adapter.broadcasts[0].to, GOVERNOR);
  assert.equal(adapter.broadcasts[0].data, voteCalldata());
  assert.equal(adapter.broadcasts[0].intentHash, result.record.intentHash);
  for (const name of [ExecutionEvent.WAAP_AUTHORIZED, ExecutionEvent.WAAP_BROADCAST, ExecutionEvent.WAAP_CONFIRMED]) {
    assert.ok(events.names().includes(name), name);
  }
  // The submission walked through SUBMITTED even though the provider confirmed
  // in one call, so the history still records that something left the process.
  assert.ok(result.record.history.map((entry) => entry.state).includes(ExecutionState.SUBMITTED));
});

test("autonomous mode broadcasts nothing when autonomy or policy says no", async () => {
  // The governance gate: an advisory recommendation is never executed
  // autonomously, whatever the policy would have said.
  const advisory = waapAdapter({ policy: async () => ({ allowed: true }) });
  await assert.rejects(
    new ExecutionEngine({ store: new InMemoryExecutionRecordStore(), adapters: [advisory], now: () => NOW }).submit(
      validated({ actor: executorWallet.address, autonomyAllowed: false }),
      { mode: "waap-autonomous", blockNumber: 150 },
    ),
    (error) => error.code === "AUTONOMY_NOT_AUTHORIZED",
  );
  assert.equal(advisory.broadcasts.length, 0);

  // Every non-approval shape is a refusal, and none of them broadcast.
  for (const [policy, expected] of [
    [async () => ({ allowed: false, reason: "daily limit reached" }), "POLICY_REJECTED"],
    [async () => ({ allowed: false, reasonCode: "TARGET_NOT_ALLOWLISTED" }), "TARGET_NOT_ALLOWLISTED"],
    [async () => undefined, "POLICY_REJECTED"],
    [async () => false, "POLICY_REJECTED"],
    [async () => ({ ok: true }), "POLICY_REJECTED"],
    [async () => { throw new Error("policy service unreachable"); }, "POLICY_ERROR"],
  ]) {
    const adapter = waapAdapter({ policy });
    const store = new InMemoryExecutionRecordStore();
    await assert.rejects(
      new ExecutionEngine({ adapters: [adapter], store, now: () => NOW }).submit(
        validated({ actor: executorWallet.address, autonomyAllowed: true }),
        { mode: "waap-autonomous", blockNumber: 150 },
      ),
      (error) => error.code === expected,
    );
    assert.equal(adapter.broadcasts.length, 0, expected);
    // The refusal is recorded rather than silent.
    const [record] = await store.list();
    assert.equal(record.state, ExecutionState.FAILED);
  }

  assert.deepEqual(assertPolicyApproval(true), { allowed: true, reason: null, policyId: null });
  assert.throws(() => assertPolicyApproval({ allowed: "yes" }), PolicyRejected);
  assert.throws(
    () => new WaapAutonomousExecutionAdapter({ chainId: 1, executionIdentity: createExecutionIdentity({ signer: walletSigner(executorWallet), chainId: 1, broadcaster: { broadcast: async () => ({}) } }) }),
    /no default-allow policy/,
  );
});

test("autonomous mode cannot be given a Safe proposal identity", () => {
  assert.throws(
    () =>
      new WaapAutonomousExecutionAdapter({
        chainId: 1,
        policy: async () => true,
        executionIdentity: createProposalIdentity({
          signer: walletSigner(proposerWallet),
          safeAddress: SAFE,
          chainId: 1,
        }),
      }),
    /cannot become an\s+autonomous execution identity/,
  );
});

test("autonomous status believes the chain, not the provider's verdict", async () => {
  const store = new InMemoryExecutionRecordStore();
  const submitted = await new ExecutionEngine({
    store: new InMemoryExecutionRecordStore(), adapters: [waapAdapter({ confirmed: false })],
    store,
    now: () => NOW,
  }).submit(validated({ actor: executorWallet.address, autonomyAllowed: true }), { mode: "waap-autonomous", blockNumber: 150 });
  assert.equal(submitted.record.state, ExecutionState.EXECUTING);

  const reverted = new ExecutionEngine({
    store: new InMemoryExecutionRecordStore(), adapters: [waapAdapter({ client: { getTransactionStatus: async () => ({ status: "reverted", confirmed: true }) } })],
    store,
    now: () => NOW,
  });
  // Mined but reverted is a failure, even though the provider reports it
  // confirmed.
  assert.equal((await reverted.status(submitted.record.id)).state, ExecutionState.FAILED);
});

test("both modes are driven identically from one validated intent", async () => {
  // The same governance artifact, two execution backends, no DAO code involved
  // in either -- which is the whole point of the boundary.
  const intent = validated({ actor: SAFE });
  const autonomousIntent = validated({ actor: executorWallet.address, autonomyAllowed: true });
  assert.notEqual(intent.intentHash, autonomousIntent.intentHash, "a different actor is a different intent");

  const safe = await new ExecutionEngine({
    store: new InMemoryExecutionRecordStore(),
    adapters: [safeAdapter()],
    now: () => NOW,
  }).submit(intent, { mode: "safe-supervised", blockNumber: 150 });
  const waap = await new ExecutionEngine({ store: new InMemoryExecutionRecordStore(), adapters: [waapAdapter({ confirmed: true })], now: () => NOW }).submit(
    autonomousIntent,
    { mode: "waap-autonomous", blockNumber: 150 },
  );

  for (const record of [safe.record, waap.record]) {
    assert.equal(record.dao, "nouns");
    assert.equal(record.proposalId, "42");
    assert.equal(record.support, "FOR");
    assert.equal(record.target, GOVERNOR);
    assert.equal(record.audit.calldata, voteCalldata());
  }
  assert.equal(safe.record.state, ExecutionState.SUBMITTED);
  assert.equal(waap.record.state, ExecutionState.EXECUTED);
});
