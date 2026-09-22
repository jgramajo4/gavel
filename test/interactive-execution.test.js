"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface, getAddress } = require("ethers");

const {
  ExecutionMode,
  ExecutionState,
  InteractiveWalletExecutionAdapter,
  ReadOnlyWalletProvider,
  WalletConnectProvider,
  WalletErrorCode,
  createVoteIntent,
  createExecutionIntent,
  getExecutionMode,
  listExecutionModes,
  validateExecutionIntent,
} = require("../packages/core");

const voteInterface = new Interface([
  "function castRefundableVoteWithReason(uint256 proposalId,uint8 support,string reason,uint32 clientId)",
]);
const SELECTOR = voteInterface.getFunction("castRefundableVoteWithReason").selector;

const VOTER = getAddress("0x0000000000000000000000000000000000000001");
const GOVERNOR = getAddress("0x0000000000000000000000000000000000000010");
const ATTACKER = getAddress("0x00000000000000000000000000000000000000ff");
const NOW = new Date("2026-09-02T00:00:00.000Z");

function voteCalldata(support = "FOR", reason = "Consistent with prior votes.") {
  const code = { AGAINST: 0, FOR: 1, ABSTAIN: 2 }[support];
  return voteInterface.encodeFunctionData("castRefundableVoteWithReason", [42, code, reason, 38]);
}

function dao() {
  return {
    id: "nouns",
    chainId: 1,
    adapterVersion: "nouns@2.0.0",
    governanceContracts: { governor: GOVERNOR },
    governanceTargets: [GOVERNOR],
    governanceSelectors: { CAST_VOTE: [SELECTOR] },
    capabilities: { prepareVote: true, eoaSupervised: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    decodeGovernanceCall(action, data) {
      const decoded = voteInterface.decodeFunctionData("castRefundableVoteWithReason", data);
      return {
        proposalId: decoded[0].toString(),
        support: ["AGAINST", "FOR", "ABSTAIN"][Number(decoded[1])],
        reason: decoded[2] === "" ? null : decoded[2],
      };
    },
    validateProposal() {}, getVotingPower() {}, getCurrentDelegate() {}, hasVoted() {}, prepareVote() {},
  };
}

function validated(actor = VOTER) {
  const voteIntent = createVoteIntent({
    dao: "nouns",
    chainId: 1,
    voterAddress: VOTER,
    proposalId: "42",
    support: "FOR",
    reason: "Consistent with prior votes.",
    createdAt: NOW.toISOString(),
  });
  return validateExecutionIntent({
    adapter: dao(),
    voteIntent,
    intent: createExecutionIntent({ voteIntent, actor, target: GOVERNOR, value: 0n, data: voteCalldata() }),
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
    },
  });
}

function walletProvider(options = {}) {
  const requests = [];
  const transport = {
    async connect() {
      return {
        topic: "topic-abcdef012345",
        account: options.account || VOTER,
        chainId: options.chainId ?? 1,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    },
    async request(payload) {
      requests.push(payload);
      if (options.reject) {
        const error = new Error("User rejected");
        error.code = "4001";
        throw error;
      }
      return "0xfeed";
    },
    async disconnect() {},
  };
  const provider = new WalletConnectProvider({ transport, chainId: options.chainId ?? 1 });
  provider.requests = requests;
  return provider;
}

test("interactive approval is a registered, implemented, identity-free mode", () => {
  const mode = getExecutionMode(ExecutionMode.EOA_SUPERVISED);
  assert.equal(mode.implemented, true);
  assert.equal(mode.kind, "SUPERVISED");
  assert.equal(mode.capability, "eoaSupervised");
  // No Gavel credential is involved: the key lives in the user's wallet, so
  // there is nothing here to store, leak or revoke.
  assert.equal(mode.identityRole, null);
  assert.ok(listExecutionModes().some((entry) => entry.mode === ExecutionMode.EOA_SUPERVISED));
});

test("a human approving in their wallet executes the validated intent", async () => {
  const wallet = walletProvider();
  await wallet.connect();
  const adapter = new InteractiveWalletExecutionAdapter({ wallet, chainId: 1 });
  assert.equal(await adapter.getExecutionAddress(), VOTER);

  const preparation = await adapter.prepare(validated());
  assert.equal(preparation.mode, ExecutionMode.EOA_SUPERVISED);
  assert.equal(preparation.providerData.providerStatus, "awaiting-human-approval");
  // Nothing has left the process yet.
  assert.equal(wallet.requests.length, 0);

  const result = await adapter.submit(preparation);
  assert.equal(result.state, ExecutionState.EXECUTING);
  assert.equal(result.providerData.transactionHash, "0xfeed");
  assert.deepEqual(
    result.events.map((event) => event.name),
    ["execution.authorized", "execution.submitted"],
  );
  assert.equal(wallet.requests[0].method, "eth_sendTransaction");
  assert.equal(getAddress(wallet.requests[0].params[0].to), GOVERNOR);
});

test("a declined request is a normal outcome, not a failure", async () => {
  const wallet = walletProvider({ reject: true });
  await wallet.connect();
  const adapter = new InteractiveWalletExecutionAdapter({ wallet, chainId: 1 });
  const result = await adapter.submit(await adapter.prepare(validated()));
  assert.equal(result.state, ExecutionState.CANCELLED);
  assert.equal(result.providerData.providerStatus, "rejected-by-human");
  assert.match(result.events[0].detail.message, /declined this vote/);
});

test("a wallet on the wrong chain is refused before anything is presented", async () => {
  const wallet = walletProvider({ chainId: 8453 });
  await wallet.connect();
  const adapter = new InteractiveWalletExecutionAdapter({ wallet, chainId: 8453 });
  await assert.rejects(adapter.prepare(validated()), /is for chain 1, not 8453/);
  assert.equal(wallet.requests.length, 0);
});

test("a wallet holding a different account cannot sign this voter's intent", async () => {
  const wallet = walletProvider({ account: ATTACKER });
  await wallet.connect();
  const adapter = new InteractiveWalletExecutionAdapter({ wallet, chainId: 1 });
  await assert.rejects(adapter.prepare(validated()), (error) => {
    assert.equal(error.code, WalletErrorCode.WRONG_ACCOUNT);
    return true;
  });
});

test("read-only cannot be given an interactive executor", () => {
  const wallet = new ReadOnlyWalletProvider({ address: VOTER, chainId: 1 });
  assert.throws(() => new InteractiveWalletExecutionAdapter({ wallet, chainId: 1 }), (error) => {
    assert.equal(error.code, WalletErrorCode.UNSUPPORTED);
    assert.match(error.message, /prepares votes but cannot cast them/);
    return true;
  });
});

test("the wallet transport is not an arbitrary-call bypass", async () => {
  const wallet = walletProvider();
  await wallet.connect();
  const adapter = new InteractiveWalletExecutionAdapter({ wallet, chainId: 1 });

  // Nothing but a ValidatedExecutionIntent can be prepared.
  await assert.rejects(
    adapter.prepare({ intent: { chainId: 1, actor: VOTER, target: ATTACKER, data: "0xdead", operation: "CALL" } }),
    /accepts only a ValidatedExecutionIntent/,
  );

  // A look-alike preparation carrying a genuine intent beside an
  // attacker-chosen request is submitted from the intent, not the payload.
  const genuine = await adapter.prepare(validated());
  const forged = {
    mode: genuine.mode,
    intentHash: genuine.intentHash,
    validated: genuine.validated,
    payload: { request: { chainId: 1, from: VOTER, to: ATTACKER, value: "0", data: "0xdeadbeef" } },
  };
  await adapter.submit(forged);
  assert.equal(getAddress(wallet.requests.at(-1).params[0].to), GOVERNOR);
  assert.notEqual(getAddress(wallet.requests.at(-1).params[0].to), ATTACKER);

  // And a preparation from another mode is refused outright.
  await assert.rejects(adapter.submit({ ...genuine, mode: "safe-supervised" }), /built for safe-supervised/);
});

test("every DAO adapter declares whether interactive approval works for it", () => {
  const { createDaoAdapter } = require("@gavel/daos");
  const provider = { getNetwork: async () => ({ chainId: 1n }) };
  for (const id of ["nouns", "ens", "railgun-eth"]) {
    // A DAO vote is an ordinary transaction from the voter, so all three
    // support it -- but each says so itself rather than being assumed.
    assert.equal(createDaoAdapter(id, { provider }).capabilities.eoaSupervised, true, id);
  }
});
