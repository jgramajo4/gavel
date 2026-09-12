"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { ExecutionEngine } = require("../packages/core/src/execution/engine");
const { ExecutionState } = require("../packages/core/src/execution/lifecycle");
const { ExecutionEvent, InMemoryEventSink, buildEvent } = require("../packages/core/src/execution/events");
const {
  InMemoryExecutionRecordStore,
  executionKey,
} = require("../packages/core/src/execution/records");
const {
  assertPreparable,
  assertSubmittable,
  assertExecutionAdapter,
  executionPreparation,
} = require("../packages/core/src/execution/adapter");
const { createVoteIntent } = require("../packages/core/src/intent/vote-intent");
const { createExecutionIntent } = require("../packages/core/src/intent/execution-intent");
const { validateExecutionIntent } = require("../packages/core/src/intent/validated");

const VOTER = "0x0000000000000000000000000000000000000001";
const SAFE = "0x0000000000000000000000000000000000000003";
const WAAP = "0x0000000000000000000000000000000000000004";
const GOVERNOR = "0x0000000000000000000000000000000000000010";
const CALLDATA = "0x56781388000000000000000000000000000000000000000000000000000000000000002a";
const SELECTOR = "0x56781388";
const NOW = new Date("2026-09-02T00:00:00.000Z");

function dao(overrides = {}) {
  return {
    id: "nouns",
    chainId: 1,
    adapterVersion: "nouns@2.0.0",
    governanceContracts: { governor: GOVERNOR },
    governanceSelectors: { CAST_VOTE: [SELECTOR] },
    capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    validateProposal() {}, getVotingPower() {}, getCurrentDelegate() {}, hasVoted() {}, prepareVote() {},
    ...overrides,
  };
}

function validated(overrides = {}) {
  const { support = "FOR", reason = "Consistent with prior votes.", actor = SAFE, ...evidence } = overrides;
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
    intent: createExecutionIntent({ voteIntent, actor, target: GOVERNOR, value: 0n, data: CALLDATA }),
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

/** A minimal execution adapter, to exercise the engine rather than a provider. */
function stubAdapter(mode, overrides = {}) {
  const adapter = {
    mode,
    submitted: [],
    async prepare(intent) {
      assertPreparable(this, intent);
      if (overrides.prepareError) throw new Error(overrides.prepareError);
      return executionPreparation(this, intent, { to: intent.intent.target, data: intent.intent.data }, {
        providerData: overrides.prepareProviderData || {},
      });
    },
    async submit(preparation) {
      assertSubmittable(this, preparation);
      if (overrides.submitError) throw new Error(overrides.submitError);
      this.submitted.push(preparation.intentHash);
      return {
        state: overrides.submitState || ExecutionState.SUBMITTED,
        providerData: overrides.submitProviderData || { providerRequestId: "req-1" },
        events: overrides.events || [],
      };
    },
    async status() {
      return { state: overrides.statusState || ExecutionState.AWAITING_AUTHORIZATION, providerData: {} };
    },
  };
  return adapter;
}

function engine(adapters, options = {}) {
  return new ExecutionEngine({
    adapters,
    store: options.store || new InMemoryExecutionRecordStore(),
    events: options.events,
    now: () => NOW,
  });
}

test("the engine walks one attempt through the lifecycle and records the audit chain", async () => {
  const events = new InMemoryEventSink();
  const safe = stubAdapter("safe-supervised", { submitProviderData: { safeTxHash: `0x${"ab".repeat(32)}`, safeNonce: "7" } });
  const result = await engine([safe], { events }).submit(validated(), { mode: "safe-supervised" });

  assert.equal(result.record.state, ExecutionState.SUBMITTED);
  assert.equal(result.record.mode, "safe-supervised");
  assert.equal(result.record.actor, SAFE);
  assert.equal(result.record.attempt, 1);
  assert.equal(result.record.providerData.safeNonce, "7");

  // Provider values live on the record, never on the intent.
  assert.equal(result.record.intentHash, validated().intentHash);
  assert.equal(Object.prototype.hasOwnProperty.call(result.record.audit, "safeTxHash"), false);

  // The audit chain answers "why did you create this transaction?".
  assert.equal(result.record.voteIntentHash, validated().intent.source.voteIntentHash);
  assert.equal(result.record.dao, "nouns");
  assert.equal(result.record.proposalId, "42");
  assert.equal(result.record.support, "FOR");
  assert.equal(result.record.audit.reason, "Consistent with prior votes.");
  assert.equal(result.record.audit.adapterVersion, "nouns@2.0.0");
  assert.equal(result.record.audit.proposalState, "ACTIVE");
  assert.equal(result.record.audit.calldata, CALLDATA);

  assert.deepEqual(
    result.record.history.map((entry) => entry.state),
    [ExecutionState.VALIDATED, ExecutionState.PREPARED, ExecutionState.SUBMITTED],
  );
  assert.deepEqual(events.names(), [
    ExecutionEvent.INTENT_VALIDATED,
    ExecutionEvent.EXECUTION_PREPARED,
    ExecutionEvent.EXECUTION_SUBMITTED,
  ]);
  for (const event of events.events) {
    assert.equal(event.intentHash, result.record.intentHash);
    assert.equal(event.dao, "nouns");
    assert.equal(event.proposalId, "42");
    assert.equal(event.executionMode, "safe-supervised");
    assert.equal(event.actor, SAFE);
    assert.equal(event.target, GOVERNOR);
  }
});

test("a retry returns the existing attempt instead of submitting twice", async () => {
  const events = new InMemoryEventSink();
  const safe = stubAdapter("safe-supervised");
  const runner = engine([safe], { events });
  const intent = validated();

  const first = await runner.submit(intent, { mode: "safe-supervised" });
  const second = await runner.submit(intent, { mode: "safe-supervised" });
  const third = await runner.submit(validated(), { mode: "safe-supervised" });

  assert.equal(safe.submitted.length, 1, "the provider was called more than once");
  assert.equal(second.deduplicated, true);
  assert.equal(second.reason, "ALREADY_IN_FLIGHT");
  assert.equal(second.record.id, first.record.id);
  // A freshly built but logically identical intent deduplicates too, which is
  // the whole reason the hash excludes wall-clock fields.
  assert.equal(third.deduplicated, true);
  assert.equal(third.record.id, first.record.id);
  assert.equal(events.named(ExecutionEvent.EXECUTION_DEDUPLICATED).length, 2);

  assert.equal(
    first.record.key,
    executionKey({ intentHash: intent.intentHash, mode: "safe-supervised", actor: SAFE }),
  );
});

test("a confirmed execution is never rebroadcast, and a dead attempt may be retried", async () => {
  const store = new InMemoryExecutionRecordStore();
  const confirmed = stubAdapter("waap-autonomous", { submitState: ExecutionState.EXECUTED });
  const autonomous = await engine([confirmed], { store }).submit(
    validated({ actor: WAAP, autonomyAllowed: true }),
    { mode: "waap-autonomous" },
  );
  assert.equal(autonomous.record.state, ExecutionState.EXECUTED);

  const again = await engine([stubAdapter("waap-autonomous")], { store }).submit(
    validated({ actor: WAAP, autonomyAllowed: true }),
    { mode: "waap-autonomous" },
  );
  assert.equal(again.deduplicated, true);
  assert.equal(again.reason, "ALREADY_EXECUTED");

  // A failed attempt is not a live one, so a genuine retry proceeds as a new
  // attempt on the same intent.
  const failStore = new InMemoryExecutionRecordStore();
  const failing = stubAdapter("safe-supervised", { submitError: "Safe service unavailable" });
  await assert.rejects(
    engine([failing], { store: failStore }).submit(validated(), { mode: "safe-supervised" }),
    /Safe service unavailable/,
  );
  const recovered = await engine([stubAdapter("safe-supervised")], { store: failStore }).submit(
    validated(),
    { mode: "safe-supervised" },
  );
  assert.equal(recovered.deduplicated, false);
  assert.equal(recovered.record.attempt, 2);
  assert.equal(recovered.record.state, ExecutionState.SUBMITTED);

  const attempts = await engine([stubAdapter("safe-supervised")], { store: failStore }).attempts(
    validated().intentHash,
  );
  assert.equal(attempts.length, 2);
  assert.deepEqual(new Set(attempts.map((record) => record.state)), new Set([ExecutionState.FAILED, ExecutionState.SUBMITTED]));
});

test("replay is decided by DAO-declared semantics, not by the execution layer", async () => {
  // Nouns: one vote per proposal. A different support is a different intent
  // hash, so idempotency lets it through and the replay rule must catch it.
  const store = new InMemoryExecutionRecordStore();
  const executed = stubAdapter("safe-supervised", { submitState: ExecutionState.EXECUTED });
  await engine([executed], { store }).submit(validated(), { mode: "safe-supervised" });
  await assert.rejects(
    engine([stubAdapter("safe-supervised")], { store }).submit(
      validated({ support: "AGAINST" }),
      { mode: "safe-supervised" },
    ),
    (error) => error.code === "VOTE_REPLACEMENT_NOT_PERMITTED",
  );

  // The same governance action already executed under another mode.
  await assert.rejects(
    engine([stubAdapter("waap-autonomous")], { store }).submit(
      validated({ autonomyAllowed: true }),
      { mode: "waap-autonomous" },
    ),
    (error) => error.code === "GOVERNANCE_ACTION_ALREADY_EXECUTED",
  );

  // A DAO that permits repeat votes (Railgun's partial votes) is allowed to.
  const railgunStore = new InMemoryExecutionRecordStore();
  const repeatable = { canVoteMultipleTimes: true, canReplaceVote: false };
  const first = await engine([stubAdapter("safe-supervised", { submitState: ExecutionState.EXECUTED })], {
    store: railgunStore,
  }).submit(validated({ semantics: repeatable, reason: "First tranche." }), { mode: "safe-supervised" });
  const second = await engine([stubAdapter("safe-supervised")], { store: railgunStore }).submit(
    validated({ semantics: repeatable, reason: "Second tranche." }),
    { mode: "safe-supervised" },
  );
  assert.equal(first.record.state, ExecutionState.EXECUTED);
  assert.equal(second.deduplicated, false);
  assert.equal(second.record.state, ExecutionState.SUBMITTED);

  // A DAO that permits replacement allows a changed vote.
  const replaceStore = new InMemoryExecutionRecordStore();
  const replaceable = { canVoteMultipleTimes: false, canReplaceVote: true };
  await engine([stubAdapter("safe-supervised", { submitState: ExecutionState.EXECUTED })], {
    store: replaceStore,
  }).submit(validated({ semantics: replaceable }), { mode: "safe-supervised" });
  const replaced = await engine([stubAdapter("safe-supervised")], { store: replaceStore }).submit(
    validated({ semantics: replaceable, support: "AGAINST" }),
    { mode: "safe-supervised" },
  );
  assert.equal(replaced.deduplicated, false);
});

test("two modes cannot race one vote, and a mode switch works once the first is dead", async () => {
  const store = new InMemoryExecutionRecordStore();
  await engine([stubAdapter("safe-supervised")], { store }).submit(validated(), { mode: "safe-supervised" });

  // The Safe proposal is still in flight: starting an autonomous execution of
  // the same vote would double-vote if the Safe owners later signed.
  await assert.rejects(
    engine([stubAdapter("waap-autonomous")], { store }).submit(
      validated({ actor: SAFE, autonomyAllowed: true }),
      { mode: "waap-autonomous" },
    ),
    (error) => error.code === "CONCURRENT_EXECUTION_IN_ANOTHER_MODE",
  );

  // Once the Safe proposal expires, the documented mode switch is allowed --
  // and it reuses the same governance intent rather than rebuilding it.
  const safeRecord = (await store.list())[0];
  await store.put({
    ...safeRecord,
    state: ExecutionState.EXPIRED,
    history: [...safeRecord.history, { state: ExecutionState.EXPIRED, at: NOW.toISOString(), detail: null }],
  });
  const switched = await engine([stubAdapter("waap-autonomous")], { store }).submit(
    validated({ actor: SAFE, autonomyAllowed: true }),
    { mode: "waap-autonomous" },
  );
  assert.equal(switched.deduplicated, false);
  assert.equal(switched.record.mode, "waap-autonomous");
  assert.equal(switched.record.intentHash, validated().intentHash, "the governance intent was rebuilt");
});

test("a stale validated intent is refused instead of executed", async () => {
  const events = new InMemoryEventSink();
  const runner = engine([stubAdapter("safe-supervised")], { events });

  // The proposal's block deadline has passed. The intent is still structurally
  // perfect, which is exactly why the deadline has to be checked here.
  await assert.rejects(
    runner.submit(validated(), { mode: "safe-supervised", blockNumber: 201 }),
    (error) => error.code === "GOVERNANCE_WINDOW_CLOSED",
  );
  assert.equal(events.named(ExecutionEvent.EXECUTION_EXPIRED).length, 1);

  // Inside the window it proceeds.
  const inside = await runner.submit(validated(), { mode: "safe-supervised", blockNumber: 199 });
  assert.equal(inside.record.state, ExecutionState.SUBMITTED);

  // A timestamp deadline behaves the same way.
  await assert.rejects(
    engine([stubAdapter("safe-supervised")]).submit(
      validated({ deadline: { kind: "timestamp", value: "1000" } }),
      { mode: "safe-supervised", now: new Date(2000 * 1000) },
    ),
    (error) => error.code === "GOVERNANCE_WINDOW_CLOSED",
  );
});

test("the engine refuses unvalidated input, unknown modes, and unimplemented backends", async () => {
  const runner = engine([stubAdapter("safe-supervised")]);

  // The prompt-injection case, at the engine rather than the adapter.
  for (const bogus of [
    { to: "0x00000000000000000000000000000000000000ff", data: "0xdeadbeef" },
    validated().toJSON(),
    null,
    "0xdeadbeef",
  ]) {
    await assert.rejects(
      runner.submit(bogus, { mode: "safe-supervised" }),
      /only a ValidatedExecutionIntent/,
    );
  }

  await assert.rejects(runner.submit(validated(), { mode: "made-up" }), /Unknown execution mode/);
  await assert.rejects(runner.submit(validated(), { mode: "erc4337" }), /not implemented/);
  await assert.rejects(runner.submit(validated(), { mode: "waap-autonomous" }), /No execution adapter is registered/);

  assert.throws(() => assertExecutionAdapter({ mode: "safe-supervised" }), /missing prepare\(\)/);
  assert.throws(() => assertExecutionAdapter({ mode: "erc4337", prepare() {}, submit() {}, status() {} }), /not implemented/);
  assert.throws(() => new ExecutionEngine({ adapters: [stubAdapter("safe-supervised"), stubAdapter("safe-supervised")] }), /already registered/);
});

test("a preparation cannot be swapped between modes or intents before submission", async () => {
  const safe = stubAdapter("safe-supervised");
  const waap = stubAdapter("waap-autonomous");
  const preparation = await safe.prepare(validated());

  await assert.rejects(waap.submit(preparation), /built for safe-supervised/);
  await assert.rejects(safe.submit({ ...preparation, intentHash: `0x${"00".repeat(32)}` }), /does not match the validated intent/);
  await assert.rejects(safe.submit({ mode: "safe-supervised", validated: preparation.validated.toJSON() }), /only a ValidatedExecutionIntent/);
  await assert.rejects(safe.submit(undefined), /requires a preparation/);
});

test("prepare alone reaches PREPARED without the provider being asked to submit", async () => {
  const safe = stubAdapter("safe-supervised");
  const prepared = await engine([safe]).prepare(validated(), { mode: "safe-supervised" });
  assert.equal(prepared.record.state, ExecutionState.PREPARED);
  assert.equal(safe.submitted.length, 0);
  assert.equal(prepared.preparation.payload.to, GOVERNOR);
  // The payload is frozen, so a caller cannot retarget it between the phases.
  assert.throws(() => {
    prepared.preparation.payload.to = "0x00000000000000000000000000000000000000ff";
  }, TypeError);
});

test("status refreshes from the provider but will not accept an illegal state", async () => {
  const store = new InMemoryExecutionRecordStore();
  const safe = stubAdapter("safe-supervised", { statusState: ExecutionState.AWAITING_AUTHORIZATION });
  const runner = engine([safe], { store });
  const submitted = await runner.submit(validated(), { mode: "safe-supervised" });

  const refreshed = await runner.status(submitted.record.id);
  assert.equal(refreshed.state, ExecutionState.AWAITING_AUTHORIZATION);
  assert.deepEqual(refreshed.history.map((entry) => entry.state), [
    ExecutionState.VALIDATED, ExecutionState.PREPARED, ExecutionState.SUBMITTED, ExecutionState.AWAITING_AUTHORIZATION,
  ]);

  // A provider claiming the transaction went back to PREPARED is not believed.
  const liar = engine([stubAdapter("safe-supervised", { statusState: ExecutionState.PREPARED })], { store });
  await assert.rejects(liar.status(submitted.record.id), /Illegal execution transition/);
  await assert.rejects(runner.status("no-such-record"), /Unknown execution record/);
});

test("events carry correlation fields and refuse to carry secrets", () => {
  const intent = validated();
  const event = buildEvent(ExecutionEvent.SAFE_PROPOSED, intent, { safeTxHash: "0xabc", state: "SUBMITTED" }, { mode: "safe-supervised" });
  assert.equal(event.event, "safe.proposed");
  assert.equal(event.intentHash, intent.intentHash);
  assert.equal(event.voteIntentHash, intent.intent.source.voteIntentHash);
  assert.equal(event.safeTxHash, "0xabc");
  assert.equal(event.executionMode, "safe-supervised");

  // An unexpected key is dropped rather than logged.
  const filtered = buildEvent(ExecutionEvent.SAFE_PROPOSED, intent, { somethingElse: "x" });
  assert.equal(Object.prototype.hasOwnProperty.call(filtered, "somethingElse"), false);

  // A secret-looking key is a hard error, not a silent drop, so a bad call site
  // is found in tests rather than in a log.
  for (const key of ["privateKey", "signature", "apiKey", "credential", "mnemonic"]) {
    assert.throws(
      () => buildEvent(ExecutionEvent.SAFE_PROPOSED, intent, { [key]: "leak" }),
      /Refusing to emit an execution event/,
      key,
    );
  }
  assert.throws(() => buildEvent("made.up", intent, {}), /Unknown execution event/);
});
