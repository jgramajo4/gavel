"use strict";

// Strict mode matters here: assigning to a frozen property is a silent no-op in
// sloppy mode, so the immutability assertions below would pass vacuously.

const assert = require("node:assert/strict");
const test = require("node:test");

const { createVoteIntent, voteIntentHash } = require("../packages/core/src/intent/vote-intent");
const {
  createExecutionIntent,
  executionIntentHash,
  executionIntentSelector,
} = require("../packages/core/src/intent/execution-intent");
const {
  ValidatedExecutionIntent,
  ValidationError,
  assertValidatedExecutionIntent,
  isValidatedExecutionIntent,
  validateExecutionIntent,
} = require("../packages/core/src/intent/validated");

const VOTER = "0x0000000000000000000000000000000000000001";
const SAFE = "0x0000000000000000000000000000000000000003";
const GOVERNOR = "0x0000000000000000000000000000000000000010";
const TOKEN = "0x0000000000000000000000000000000000000011";
const ATTACKER = "0x00000000000000000000000000000000000000ff";
const CALLDATA = "0x56781388000000000000000000000000000000000000000000000000000000000000002a";
const SELECTOR = "0x56781388";

function voteIntent(overrides = {}) {
  return createVoteIntent({
    dao: "nouns",
    chainId: 1,
    voterAddress: VOTER,
    proposalId: "42",
    support: "FOR",
    reason: "Consistent with prior votes.",
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  });
}

function executionIntent(overrides = {}) {
  const { voteIntent: vote, ...rest } = overrides;
  return createExecutionIntent({
    voteIntent: vote || voteIntent(),
    actor: SAFE,
    target: GOVERNOR,
    value: 0n,
    data: CALLDATA,
    action: "CAST_VOTE",
    ...rest,
  });
}

function dao(overrides = {}) {
  return {
    id: "nouns",
    chainId: 1,
    adapterVersion: "nouns@2.0.0",
    governanceContracts: { governor: GOVERNOR, token: TOKEN },
    governanceSelectors: { CAST_VOTE: [SELECTOR] },
    capabilities: { prepareVote: true, safeSupervised: true, waapAutonomous: true },
    supportedActions: ["CAST_VOTE"],
    validateProposal() {},
    getVotingPower() {},
    getCurrentDelegate() {},
    hasVoted() {},
    prepareVote() {},
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    adapterVersion: "nouns@2.0.0",
    validatedAt: "2026-09-02T00:00:00.000Z",
    proposalState: "ACTIVE",
    proposalStateVotable: true,
    governanceTarget: GOVERNOR,
    selector: SELECTOR,
    actorEligible: true,
    autonomyAllowed: false,
    deadline: { kind: "block", value: "23000000" },
    semantics: { canVoteMultipleTimes: false, canReplaceVote: false },
    checks: [{ code: "PROPOSAL_STATE_VOTABLE", passed: true, detail: "ACTIVE" }],
    ...overrides,
  };
}

function validate(overrides = {}) {
  return validateExecutionIntent({
    adapter: dao(),
    intent: executionIntent(),
    evidence: evidence(),
    ...overrides,
  });
}

test("VoteIntent carries governance facts only and hashes the logical decision", () => {
  const intent = voteIntent();
  assert.deepEqual(Object.keys(intent).sort(), [
    "chainId", "createdAt", "dao", "proposalId", "reason", "support", "version", "voterAddress",
  ]);
  for (const leaked of ["safeTxHash", "safeNonce", "target", "data", "calldata", "sessionId"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(intent, leaked), false, leaked);
  }

  // Same logical decision, different wall clock and annotation: same hash.
  assert.equal(
    voteIntentHash(intent),
    voteIntentHash(voteIntent({ createdAt: "2027-01-01T00:00:00.000Z", metadata: { note: "later" } })),
  );
  // Any governance field changes the identity.
  assert.notEqual(voteIntentHash(intent), voteIntentHash(voteIntent({ support: "AGAINST" })));
  assert.notEqual(voteIntentHash(intent), voteIntentHash(voteIntent({ proposalId: "43" })));
  assert.notEqual(voteIntentHash(intent), voteIntentHash(voteIntent({ reason: "Different." })));
  assert.notEqual(voteIntentHash(intent), voteIntentHash(voteIntent({ dao: "ens" })));
});

test("execution intent hashing is deterministic, order-free, and provider-blind", () => {
  const intent = executionIntent();
  const hash = executionIntentHash(intent);

  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(hash, executionIntentHash(JSON.parse(JSON.stringify(intent))));
  assert.equal(executionIntentSelector(intent), SELECTOR);

  // Field order and address casing are not part of the logical intent.
  const reordered = { source: intent.source, data: intent.data, ...intent };
  assert.equal(executionIntentHash(reordered), hash);
  assert.equal(executionIntentHash({ ...intent, actor: SAFE.toUpperCase().replace("0X", "0x") }), hash);

  // Every security-sensitive field is covered.
  for (const mutation of [
    { chainId: 8453 },
    { actor: ATTACKER },
    { target: ATTACKER },
    { value: "1" },
    { data: `${CALLDATA}ff` },
  ]) {
    assert.notEqual(executionIntentHash({ ...intent, ...mutation }), hash, JSON.stringify(mutation));
  }
  for (const mutation of [
    { dao: "ens" },
    { proposalId: "43" },
    { support: "AGAINST" },
    { reason: "Other." },
  ]) {
    assert.notEqual(
      executionIntentHash({ ...intent, source: { ...intent.source, ...mutation } }),
      hash,
      JSON.stringify(mutation),
    );
  }

  // Provider-invented values have nowhere to live, so retries cannot drift.
  assert.equal(
    executionIntentHash({ ...intent, safeNonce: "7", safeTxHash: "0xdead", providerRequestId: "req-1" }),
    hash,
  );

  // reason "" and null are the same logical decision.
  assert.equal(
    executionIntentHash(executionIntent({ voteIntent: voteIntent({ reason: "   " }) })),
    executionIntentHash(executionIntent({ voteIntent: voteIntent({ reason: null }) })),
  );
});

test("an execution intent is refused unless it descends from its governance intent", () => {
  assert.throws(
    () => createExecutionIntent({ voteIntent: voteIntent(), target: GOVERNOR, data: CALLDATA, chainId: 8453 }),
    /chain must match the governance intent chain/,
  );
  assert.throws(
    () => createExecutionIntent({ voteIntent: voteIntent(), target: GOVERNOR, data: CALLDATA, operation: "DELEGATECALL" }),
    /delegatecall is never a governance vote/,
  );
  assert.throws(
    () =>
      validate({
        voteIntent: voteIntent({ support: "AGAINST" }),
      }),
    (error) => error instanceof ValidationError && error.code === "VOTE_INTENT_MISMATCH",
  );
});

test("ValidatedExecutionIntent cannot be constructed, forged, or cast into", () => {
  const validated = validate();
  assert.ok(isValidatedExecutionIntent(validated));
  assert.equal(validated.intentHash, executionIntentHash(executionIntent()));

  // No public constructor.
  assert.throws(
    () => new ValidatedExecutionIntent(Symbol("guess"), executionIntent(), "0x00", evidence()),
    /minted only by canonical Gavel validation/,
  );
  assert.throws(() => new ValidatedExecutionIntent(), /minted only by canonical Gavel validation/);

  // A structural look-alike is not the boundary type.
  const lookalike = validated.toJSON();
  assert.equal(isValidatedExecutionIntent(lookalike), false);
  assert.throws(() => assertValidatedExecutionIntent(lookalike), /accept only a ValidatedExecutionIntent/);
  assert.throws(
    () => assertValidatedExecutionIntent({ intent: executionIntent(), intentHash: validated.intentHash, validation: evidence() }),
    /accept only a ValidatedExecutionIntent/,
  );
  assert.throws(
    () => assertValidatedExecutionIntent(Object.create(ValidatedExecutionIntent.prototype)),
    /accept only a ValidatedExecutionIntent/,
  );

  // Round-tripping through JSON does not restore it: re-entering the boundary
  // requires re-validating against a live adapter.
  assert.equal(isValidatedExecutionIntent(JSON.parse(JSON.stringify(validated))), false);
});

test("a validated intent is immutable after validation", () => {
  const validated = validate();
  assert.throws(() => {
    validated.intent.target = ATTACKER;
  }, TypeError);
  assert.throws(() => {
    validated.intent.source.support = "AGAINST";
  }, TypeError);
  assert.throws(() => {
    validated.intentHash = "0x00";
  }, TypeError);
  assert.throws(() => {
    validated.validation.autonomyAllowed = true;
  }, TypeError);
  assert.equal(validated.intent.target, GOVERNOR);

  // The caller's own copies cannot reach inside it either.
  const intent = executionIntent();
  const held = validateExecutionIntent({ adapter: dao(), intent, evidence: evidence() });
  intent.target = ATTACKER;
  assert.equal(held.intent.target, GOVERNOR);
  assert.equal(held.intentHash, executionIntentHash(executionIntent()));
});

test("validation refuses arbitrary calldata, foreign targets, and undeclared selectors", () => {
  const codeOf = (overrides) => {
    try {
      validate(overrides);
    } catch (error) {
      return error.code;
    }
    return "NO_ERROR";
  };

  // The prompt-injection case: an attacker-chosen target.
  assert.equal(
    codeOf({ intent: executionIntent({ target: ATTACKER }) }),
    "TARGET_NOT_GOVERNANCE_CONTRACT",
  );
  // A declared contract but a call the adapter never authorized for this action.
  assert.equal(
    codeOf({
      intent: executionIntent({ data: "0xdeadbeef" }),
      evidence: evidence({ selector: "0xdeadbeef" }),
    }),
    "SELECTOR_NOT_ALLOWED_FOR_ACTION",
  );
  // Evidence that disagrees with the calldata it claims to describe.
  assert.equal(codeOf({ evidence: evidence({ selector: "0xaaaaaaaa" }) }), "EVIDENCE_SELECTOR_MISMATCH");
  assert.equal(codeOf({ evidence: evidence({ governanceTarget: TOKEN }) }), "EVIDENCE_TARGET_MISMATCH");
  // Calldata too short to name a function.
  assert.equal(codeOf({ intent: executionIntent({ data: "0x" }), evidence: evidence({ selector: SELECTOR }) }), "CALLDATA_HAS_NO_SELECTOR");

  assert.equal(codeOf({ adapter: dao({ id: "ens" }) }), "DAO_MISMATCH");
  assert.equal(codeOf({ adapter: dao({ chainId: 8453 }) }), "CHAIN_MISMATCH");
  assert.equal(codeOf({ adapter: dao({ supportedActions: [] }) }), "ACTION_UNSUPPORTED");
  assert.equal(
    codeOf({ adapter: dao({ governanceContracts: { governor: GOVERNOR }, governanceTargets: [] }) }),
    "ADAPTER_DECLARES_NO_GOVERNANCE_TARGETS",
  );

  assert.equal(codeOf({ evidence: evidence({ proposalStateVotable: false, proposalState: "DEFEATED" }) }), "PROPOSAL_NOT_VOTABLE");
  assert.equal(codeOf({ evidence: evidence({ actorEligible: false }) }), "ACTOR_NOT_ELIGIBLE");
  assert.equal(
    codeOf({ evidence: evidence({ checks: [{ code: "DELEGATION_MISMATCH", passed: false, detail: null }] }) }),
    "ADAPTER_CHECKS_FAILED",
  );
});

test("an adapter may only bless targets it declares, with no governance-contract map to fall back on", () => {
  // `governanceTargets` overrides the contract map, so an adapter can declare a
  // narrower set than the contracts it knows about.
  const narrowed = dao({ governanceTargets: [GOVERNOR] });
  assert.ok(isValidatedExecutionIntent(validate({ adapter: narrowed })));
  assert.throws(
    () =>
      validate({
        adapter: narrowed,
        intent: executionIntent({ target: TOKEN }),
        evidence: evidence({ governanceTarget: TOKEN }),
      }),
    (error) => error.code === "TARGET_NOT_GOVERNANCE_CONTRACT",
  );

  // An adapter with no declared selector allowlist still gets target and
  // selector-consistency checks, so it is safe but less specific.
  const permissive = dao({ governanceSelectors: undefined });
  assert.ok(
    isValidatedExecutionIntent(
      validate({
        adapter: permissive,
        intent: executionIntent({ data: "0xdeadbeef" }),
        evidence: evidence({ selector: "0xdeadbeef" }),
      }),
    ),
  );
});
