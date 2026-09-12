"use strict";

/**
 * Attacks on the execution boundary.
 *
 * Every test here was written as a failing test first, from a reproduced
 * proof-of-concept. They are the tests whose absence let three critical holes
 * ship green: nested preparation payloads were mutable after `prepare()`,
 * omitted Safe Transaction Service fields read as success, and a valid vote
 * selector accepted swapped arguments.
 *
 * The rule this file encodes: an execution adapter must derive the onchain call
 * from `validated.intent` and from nothing else, and must treat every absent
 * provider field as a failure rather than a pass.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { Interface, TypedDataEncoder, Wallet, getAddress } = require("ethers");

const {
  SAFE_TX_TYPES,
  SafeSupervisedExecutionAdapter,
} = require("../packages/core/src/execution/executors/safe-supervised");
const { WaapAutonomousExecutionAdapter } = require("../packages/core/src/execution/executors/waap-autonomous");
const { ExecutionEngine } = require("../packages/core/src/execution/engine");
const { ExecutionState } = require("../packages/core/src/execution/lifecycle");
const { InMemoryExecutionRecordStore } = require("../packages/core/src/execution/records");
const {
  createExecutionIdentity,
  createProposalIdentity,
} = require("../packages/core/src/execution/identity/roles");
const { createVoteIntent } = require("../packages/core/src/intent/vote-intent");
const { createExecutionIntent } = require("../packages/core/src/intent/execution-intent");
const { validateExecutionIntent } = require("../packages/core/src/intent/validated");

const SAFE = "0x0000000000000000000000000000000000000003";
const GOVERNOR = "0x0000000000000000000000000000000000000010";
const TOKEN = "0x0000000000000000000000000000000000000011";
const ATTACKER = "0x00000000000000000000000000000000000000ff";
const OWNER_A = "0x00000000000000000000000000000000000000a1";
const OWNER_B = "0x00000000000000000000000000000000000000a2";
const NOW = new Date("2026-09-02T00:00:00.000Z");

const proposerWallet = new Wallet(`0x${"11".repeat(32)}`);
const executorWallet = new Wallet(`0x${"22".repeat(32)}`);

const voteInterface = new Interface([
  "function castRefundableVoteWithReason(uint256 proposalId,uint8 support,string reason,uint32 clientId)",
]);
const SELECTOR = voteInterface.getFunction("castRefundableVoteWithReason").selector;

function calldataFor({ proposalId = 42, support = 1, reason = "Consistent with prior votes." } = {}) {
  return voteInterface.encodeFunctionData("castRefundableVoteWithReason", [proposalId, support, reason, 38]);
}

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

/** A DAO adapter that decodes its own calldata, as the contract now requires. */
function dao(overrides = {}) {
  return {
    id: "nouns",
    chainId: 1,
    adapterVersion: "nouns@test",
    governanceContracts: { governor: GOVERNOR, token: TOKEN },
    governanceTargets: [GOVERNOR],
    governanceSelectors: { CAST_VOTE: [SELECTOR] },
    capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    decodeGovernanceCall(action, data) {
      const decoded = voteInterface.decodeFunctionData("castRefundableVoteWithReason", data);
      return {
        proposalId: decoded[0].toString(),
        support: ["AGAINST", "FOR", "ABSTAIN"][Number(decoded[1])],
        reason: decoded[2],
      };
    },
    validateProposal() {}, getVotingPower() {}, getCurrentDelegate() {}, hasVoted() {}, prepareVote() {},
    ...overrides,
  };
}

function validated(overrides = {}) {
  const { actor = SAFE, support = "FOR", reason = "Consistent with prior votes.", data, adapter, ...evidence } = overrides;
  const voteIntent = createVoteIntent({
    dao: "nouns", chainId: 1, voterAddress: executorWallet.address,
    proposalId: "42", support, reason, createdAt: NOW.toISOString(),
  });
  return validateExecutionIntent({
    adapter: adapter || dao(),
    voteIntent,
    intent: createExecutionIntent({
      voteIntent, actor, target: GOVERNOR, value: 0n,
      data: data || calldataFor({ support: support === "FOR" ? 1 : support === "AGAINST" ? 0 : 2, reason }),
    }),
    evidence: {
      adapterVersion: "nouns@test", validatedAt: NOW.toISOString(),
      proposalState: "ACTIVE", proposalStateVotable: true,
      governanceTarget: GOVERNOR, selector: SELECTOR, actorEligible: true,
      autonomyAllowed: true, deadline: { kind: "block", value: "200" },
      semantics: { canVoteMultipleTimes: false, canReplaceVote: false },
      checks: [{ code: "PROPOSAL_STATE_VOTABLE", passed: true, detail: "ACTIVE" }],
      ...evidence,
    },
  });
}

/** A Transaction Service double whose read-back can be selectively broken. */
function transactionService(overrides = {}) {
  const proposals = [];
  const stored = new Map();
  return {
    proposals,
    async getNextNonce() {
      return overrides.nonce ?? 7;
    },
    async proposeTransaction(input) {
      proposals.push(input);
      if (overrides.proposeError) throw new Error(overrides.proposeError);
      stored.set(input.safeTxHash, input.safeTransactionData);
      return overrides.proposeResponse === undefined ? { safeTxHash: input.safeTxHash } : overrides.proposeResponse;
    },
    async getTransaction(safeTxHash) {
      if (overrides.missing) return null;
      const body = stored.get(safeTxHash) || {};
      const full = {
        safeTxHash,
        safe: SAFE,
        chainId: 1,
        to: body.to ?? GOVERNOR,
        data: body.data ?? calldataFor(),
        value: body.value ?? "0",
        operation: body.operation ?? 0,
        nonce: body.nonce ?? String(overrides.nonce ?? 7),
        confirmations: overrides.confirmations ?? [],
        confirmationsRequired: overrides.confirmationsRequired ?? 2,
        isExecuted: overrides.isExecuted ?? false,
        isSuccessful: overrides.isSuccessful,
        transactionHash: overrides.transactionHash,
      };
      for (const omitted of overrides.omit || []) delete full[omitted];
      return { ...full, ...overrides.statusOverrides };
    },
  };
}

function safeAdapter(options = {}) {
  return new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity:
      options.proposalIdentity ||
      createProposalIdentity({ signer: walletSigner(proposerWallet), safeAddress: SAFE, chainId: 1 }),
    transactionService: options.transactionService || transactionService(options.service),
    safeInfo: options.safeInfo === null ? undefined : options.safeInfo || { getOwners: async () => [OWNER_A, OWNER_B] },
    ...options.extra,
  });
}

function waapAdapter(options = {}) {
  const broadcasts = [];
  const adapter = new WaapAutonomousExecutionAdapter({
    chainId: 1,
    policy: options.policy || (async () => ({ allowed: true })),
    executionIdentity: createExecutionIdentity({
      signer: walletSigner(executorWallet),
      chainId: 1,
      broadcaster: {
        async broadcast(request) {
          broadcasts.push(request);
          return { transactionHash: `0x${"cd".repeat(32)}`, confirmed: options.confirmed ?? false };
        },
      },
    }),
  });
  adapter.broadcasts = broadcasts;
  return adapter;
}

function engine(adapters, store = new InMemoryExecutionRecordStore()) {
  return new ExecutionEngine({ adapters, store, now: () => NOW });
}

// ─────────────────────────── Blocker 1: payload mutation

test("ATTACK: mutating the nested WaaP request after prepare() must not broadcast", async () => {
  const adapter = waapAdapter();
  const intent = validated({ actor: executorWallet.address });
  const preparation = await adapter.prepare(intent);

  // The reproduced proof-of-concept: `Object.freeze({ ...payload })` froze only
  // the top level, so `payload.request` stayed writable and submit() broadcast
  // it verbatim under the original intent hash.
  assert.throws(() => {
    preparation.payload.request.to = ATTACKER;
  }, TypeError, "the nested request is still mutable");
  assert.throws(() => {
    preparation.payload.request.data = "0xdeadbeef";
  }, TypeError);

  // Even given a forged preparation object, submit() must rebuild the call from
  // the validated intent rather than trust the payload.
  const forged = {
    ...preparation,
    payload: { ...preparation.payload, request: { ...preparation.payload.request, to: ATTACKER, data: "0xdeadbeef" } },
  };
  await adapter.submit(forged);
  assert.equal(adapter.broadcasts.length, 1);
  assert.equal(getAddress(adapter.broadcasts[0].to), getAddress(GOVERNOR), "broadcast the attacker's target");
  assert.equal(adapter.broadcasts[0].data, intent.intent.data, "broadcast the attacker's calldata");
});

test("ATTACK: mutating the nested Safe transaction after prepare() must not be proposed", async () => {
  const service = transactionService();
  const adapter = safeAdapter({ transactionService: service });
  const intent = validated();
  const preparation = await adapter.prepare(intent);

  for (const field of ["to", "data", "value", "operation", "nonce"]) {
    assert.throws(() => {
      preparation.payload.safeTransaction[field] = field === "to" ? ATTACKER : "1";
    }, TypeError, `safeTransaction.${field} is still mutable`);
  }

  // A forged preparation claiming a different body under the original hash must
  // be refused: the hash is recomputed at submit from the validated intent.
  const forged = {
    ...preparation,
    payload: {
      ...preparation.payload,
      safeTransaction: { ...preparation.payload.safeTransaction, to: ATTACKER, value: "1000000000000000000" },
    },
  };
  await adapter.submit(forged);
  const [proposed] = service.proposals;
  assert.equal(getAddress(proposed.safeTransactionData.to), getAddress(GOVERNOR));
  assert.equal(proposed.safeTransactionData.value, "0");
  // And the hash sent must match the body sent.
  assert.equal(
    proposed.safeTxHash,
    TypedDataEncoder.hash({ chainId: 1, verifyingContract: SAFE }, SAFE_TX_TYPES, proposed.safeTransactionData),
  );
});

// ─────────────────────────── Blocker 2: calldata binding

test("ATTACK: a valid selector with swapped arguments must not validate", () => {
  const code = (overrides) => {
    try {
      validated(overrides);
      return "NO_ERROR";
    } catch (error) {
      return error.code || error.message;
    }
  };

  // Same governor, same 0x8136730f selector, different proposal in the args.
  assert.equal(code({ data: calldataFor({ proposalId: 999 }) }), "CALLDATA_DOES_NOT_MATCH_INTENT");
  // Same proposal, flipped support.
  assert.equal(code({ data: calldataFor({ support: 0 }) }), "CALLDATA_DOES_NOT_MATCH_INTENT");
  // Same proposal and support, substituted reason.
  assert.equal(code({ data: calldataFor({ reason: "Bribed." }) }), "CALLDATA_DOES_NOT_MATCH_INTENT");
  // The honest case still validates.
  assert.equal(code({}), "NO_ERROR");
});

test("ATTACK: an adapter that cannot decode its own calldata cannot validate", () => {
  // Without a decoder there is no way to bind source.proposalId to the bytes,
  // so the contract requires one rather than silently skipping the check.
  const undecodable = dao({ decodeGovernanceCall: undefined });
  assert.throws(
    () => validated({ adapter: undecodable }),
    (error) => error.code === "ADAPTER_CANNOT_DECODE_GOVERNANCE_CALL",
  );
});

test("a fabricated adapter cannot bless calldata contradicting its own declarations", () => {
  // A duck-typed adapter must still be internally consistent: declaring the
  // attacker as the only governance target does not let a call to the real
  // governor through, and vice versa.
  const fake = dao({
    governanceTargets: [ATTACKER],
    governanceSelectors: { CAST_VOTE: ["0xdeadbeef"] },
    decodeGovernanceCall: () => ({ proposalId: "42", support: "FOR", reason: "Consistent with prior votes." }),
  });
  assert.throws(
    () => validated({ adapter: fake, data: "0xdeadbeef" }),
    (error) => error.code === "TARGET_NOT_GOVERNANCE_CONTRACT",
  );

  // The honest residual, asserted rather than hidden: `validateExecutionIntent`
  // takes the adapter as a parameter and performs no I/O, so an attacker with
  // arbitrary in-process code execution can supply a self-consistent fake
  // adapter and mint. The seal proves canonical validation ran -- not that a
  // registered adapter read chain state.
  const selfConsistent = dao({
    governanceTargets: [ATTACKER],
    governanceSelectors: { CAST_VOTE: ["0xdeadbeef"] },
    decodeGovernanceCall: () => ({ proposalId: "42", support: "FOR", reason: "Consistent with prior votes." }),
  });
  const voteIntent = createVoteIntent({
    dao: "nouns", chainId: 1, voterAddress: executorWallet.address,
    proposalId: "42", support: "FOR", reason: "Consistent with prior votes.", createdAt: NOW.toISOString(),
  });
  const minted = validateExecutionIntent({
    adapter: selfConsistent,
    voteIntent,
    intent: createExecutionIntent({
      voteIntent, actor: executorWallet.address, target: ATTACKER, value: 0n, data: "0xdeadbeef",
    }),
    evidence: {
      adapterVersion: "fake@1", validatedAt: NOW.toISOString(),
      proposalState: "ACTIVE", proposalStateVotable: true,
      governanceTarget: ATTACKER, selector: "0xdeadbeef", actorEligible: true,
      autonomyAllowed: true, deadline: { kind: "block", value: "200" },
      semantics: { canVoteMultipleTimes: false, canReplaceVote: false },
      checks: [{ code: "OK", passed: true, detail: null }],
    },
  });
  assert.equal(minted.intent.target, getAddress(ATTACKER));

  // What contains that residual is the boundary above: the CLI resolves DAO
  // adapters from a fixed registry of ids and never accepts a caller-supplied
  // adapter object, so there is no user-reachable path that supplies one.
  const cli = require("node:fs").readFileSync(
    require("node:path").resolve(__dirname, "..", "packages", "cli", "bin", "gavel.js"),
    "utf8",
  );
  assert.match(cli, /function createDaoAdapter\(dao, provider\)/);
  assert.match(cli, /throw new Error\(`Unsupported DAO: \$\{dao\}/);
});

test("ATTACK: validation requires the governance intent, not merely evidence", () => {
  // The vote-intent cross-check used to be optional, so nothing forced the
  // caller to show where the decision came from.
  assert.throws(
    () =>
      validateExecutionIntent({
        adapter: dao(),
        intent: validated().intent,
        evidence: validated().validation,
      }),
    (error) => error.code === "VOTE_INTENT_REQUIRED",
  );
});

test("ATTACK: declared targets and selectors are mandatory, with no permissive fallback", () => {
  // `governanceContracts` includes a token and (for ENS) a timelock. Falling
  // back to it widened the allowed target set beyond the governor.
  assert.throws(
    () => validated({ adapter: dao({ governanceTargets: undefined }) }),
    (error) => error.code === "ADAPTER_DECLARES_NO_GOVERNANCE_TARGETS",
  );
  assert.throws(
    () => validated({ adapter: dao({ governanceSelectors: undefined }) }),
    (error) => error.code === "ADAPTER_DECLARES_NO_SELECTORS_FOR_ACTION",
  );
});

// ─────────────────────────── Blocker 3: provider distrust

test("ATTACK: an omitted Transaction Service field must never read as success", async () => {
  const record = async (service) => {
    const store = new InMemoryExecutionRecordStore();
    const submitted = await engine([safeAdapter({ service: {} })], store).submit(validated(), {
      mode: "safe-supervised",
      blockNumber: 150,
    });
    return { store, id: submitted.record.id, adapter: safeAdapter({ service }) };
  };

  // The reproduced proof-of-concept: `{ isExecuted: true }` with no to, data or
  // safeTxHash returned EXECUTED, because every check was `if (field && …)`.
  for (const omitted of [["safeTxHash"], ["to"], ["data"], ["value"], ["operation"], ["nonce"], ["safe"], ["chainId"]]) {
    const { store, id, adapter } = await record({ omit: omitted, isExecuted: true });
    await assert.rejects(
      new ExecutionEngine({ adapters: [adapter], store, now: () => NOW }).status(id),
      /did not return|is missing/i,
      `omitting ${omitted[0]} was treated as a pass`,
    );
  }

  // Fields present but describing a different transaction.
  for (const tampering of [
    { statusOverrides: { to: ATTACKER } },
    { statusOverrides: { data: "0xdeadbeef" } },
    { statusOverrides: { value: "1000000000000000000" } },
    { statusOverrides: { operation: 1 } },
    { statusOverrides: { nonce: "99" } },
    { statusOverrides: { safe: ATTACKER } },
    { statusOverrides: { chainId: 8453 } },
  ]) {
    const { store, id, adapter } = await record({ ...tampering, isExecuted: true });
    await assert.rejects(
      new ExecutionEngine({ adapters: [adapter], store, now: () => NOW }).status(id),
      /does not match|no longer/i,
      `tampering with ${Object.keys(tampering.statusOverrides)[0]} was accepted`,
    );
  }
});

test("ATTACK: a propose that cannot be read back and verified is not a submission", async () => {
  // The real Safe API returns 201 with an empty body, so the response cannot be
  // the verification. The adapter reads the proposal back instead.
  const unreadable = safeAdapter({ service: { proposeResponse: {}, missing: true } });
  await assert.rejects(
    engine([unreadable]).submit(validated(), { mode: "safe-supervised", blockNumber: 150 }),
    /could not be read back|does not know/i,
  );

  const swapping = safeAdapter({ service: { proposeResponse: { safeTxHash: `0x${"ff".repeat(32)}` } } });
  await assert.rejects(
    engine([swapping]).submit(validated(), { mode: "safe-supervised", blockNumber: 150 }),
    /different safeTxHash/i,
  );
});

// ─────────────────────────── Safe owner invariant

test("ATTACK: supervised mode cannot run without an onchain owner reader", async () => {
  // Skipping the check when `safeInfo` was absent made the "Gavel is never a
  // Safe owner" invariant opt-in, and nothing bundled supplies safeInfo.
  assert.throws(() => safeAdapter({ safeInfo: null }), /owner reader|getOwners/i);

  // And it is checked at submit, not only at construction, so becoming an owner
  // later is caught.
  const becomesOwner = safeAdapter({
    safeInfo: {
      getOwners: (() => {
        let calls = 0;
        return async () => (++calls > 1 ? [OWNER_A, proposerWallet.address] : [OWNER_A, OWNER_B]);
      })(),
    },
  });
  const first = await becomesOwner.prepare(validated());
  assert.ok(first.payload.safeTxHash);
  await assert.rejects(becomesOwner.submit(first), /must not be a Safe owner/);
});

// ─────────────────────────── Identity separation on the execution path

test("ATTACK: one signer cannot back both roles on a live engine", async () => {
  const shared = walletSigner(executorWallet);
  const safe = new SafeSupervisedExecutionAdapter({
    safeAddress: SAFE,
    chainId: 1,
    proposalIdentity: createProposalIdentity({ signer: shared, safeAddress: SAFE, chainId: 1 }),
    transactionService: transactionService(),
    safeInfo: { getOwners: async () => [OWNER_A] },
  });
  const waap = new WaapAutonomousExecutionAdapter({
    chainId: 1,
    policy: async () => ({ allowed: true }),
    executionIdentity: createExecutionIdentity({
      signer: shared,
      chainId: 1,
      broadcaster: { broadcast: async () => ({ transactionHash: `0x${"cd".repeat(32)}` }) },
    }),
  });

  // Two distinct credential references can resolve to one key, so the
  // separation check has to compare resolved addresses on the execution path --
  // not reference strings in a profile, and not only in a test.
  await assert.rejects(
    engine([safe, waap]).submit(validated({ actor: executorWallet.address }), {
      mode: "waap-autonomous",
      blockNumber: 150,
    }),
    /Identity separation violated/,
  );
});

// ─────────────────────────── Freshness and records

test("ATTACK: an intent with an unknown deadline is not submittable by default", async () => {
  // `gavel execution prepare` without a proposal wrote `kind: "none"`, which
  // `evaluateFreshness` reported as not expired -- an intent that never goes
  // stale.
  await assert.rejects(
    engine([safeAdapter()]).submit(validated({ deadline: { kind: "none", value: null } }), {
      mode: "safe-supervised",
      blockNumber: 150,
    }),
    (error) => error.code === "GOVERNANCE_DEADLINE_UNKNOWN",
  );

  // An operator can opt in explicitly for a DAO that genuinely has no deadline.
  const allowed = await engine([safeAdapter()]).submit(
    validated({ deadline: { kind: "none", value: null } }),
    { mode: "safe-supervised", blockNumber: 150, allowUnknownDeadline: true },
  );
  assert.equal(allowed.record.state, ExecutionState.SUBMITTED);
});

test("a standalone prepare does not block a later real submission", async () => {
  // PREPARED means nothing left the process, so it must not count as an
  // in-flight attempt for idempotency.
  const store = new InMemoryExecutionRecordStore();
  const runner = engine([safeAdapter()], store);
  const intent = validated();

  const prepared = await runner.prepare(intent, { mode: "safe-supervised", blockNumber: 150 });
  assert.equal(prepared.record.state, ExecutionState.PREPARED);

  const submitted = await runner.submit(intent, { mode: "safe-supervised", blockNumber: 150 });
  assert.equal(submitted.deduplicated, false, "a dry-run prepare blocked the real submit");
  assert.equal(submitted.record.state, ExecutionState.SUBMITTED);
});

test("the engine requires an explicit record store rather than defaulting to memory", () => {
  // An in-memory default means a restart silently loses every dedup guarantee.
  assert.throws(() => new ExecutionEngine({ adapters: [] }), /record store/i);
});

// ─────────────────────────── Deprecated executors

test("the deprecated single-phase executors are not reachable from the package entry", () => {
  const core = require("../packages/core");
  for (const removed of ["SafeSupervisedExecutor", "WaapAutonomousExecutor", "UnsignedExecutor", "createPreparedGovernanceTransaction", "fromVotePreparation"]) {
    assert.equal(core[removed], undefined, `${removed} is still exported from @gavel/core`);
  }

  // Still requirable by path for the migration, but inert unless opted in.
  const legacy = require("../packages/core/src/execution/executors/safe");
  assert.throws(
    () => new legacy.SafeSupervisedExecutor({ safeAddress: SAFE, client: { propose() {} } }),
    /GAVEL_ALLOW_DEPRECATED_EXECUTORS/,
  );
  // `fromVotePreparation()` is the bridge that turned a preparation into
  // executor input; it is gated. The document builder itself is not, because
  // `gavel prepare-delegation` uses it for unsigned output that never reaches
  // an executor -- but it is unexported, and no gated executor accepts it.
  const binding = require("../packages/core/src/execution/transaction-binding");
  assert.throws(
    () => binding.fromVotePreparation({ status: "READY_TO_SIGN", transaction: {} }),
    /GAVEL_ALLOW_DEPRECATED_EXECUTORS/,
  );
});

test("the durable store survives a restart, so deduplication does too", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { FileExecutionRecordStore } = require("../packages/core/src/execution/records");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-records-"));
  const intent = validated();

  // First process: submit.
  const first = await new ExecutionEngine({
    adapters: [safeAdapter()],
    store: new FileExecutionRecordStore(root),
    now: () => NOW,
  }).submit(intent, { mode: "safe-supervised", blockNumber: 150 });
  assert.equal(first.record.state, ExecutionState.SUBMITTED);

  // A record was written at 0600, not held in memory.
  const written = fs.readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith(".json"));
  assert.equal(written.length, 1);
  assert.equal(fs.statSync(path.join(root, String(written[0]))).mode & 0o777, 0o600);

  // Second process: a brand-new engine over the same directory deduplicates,
  // which an in-memory store could not do.
  const second = await new ExecutionEngine({
    adapters: [safeAdapter()],
    store: new FileExecutionRecordStore(root),
    now: () => NOW,
  }).submit(validated(), { mode: "safe-supervised", blockNumber: 150 });
  assert.equal(second.deduplicated, true);
  assert.equal(second.reason, "ALREADY_IN_FLIGHT");
  assert.equal(second.record.id, first.record.id);
});
