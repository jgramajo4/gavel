"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  executionIntentFromPreparation,
  validatedIntentFromPreparation,
  validationEvidenceFromPreparation,
  voteIntentFromPreparation,
} = require("../packages/core/src/intent/from-preparation");
const { executionIntentHash } = require("../packages/core/src/intent/execution-intent");
const { voteIntentHash } = require("../packages/core/src/intent/vote-intent");
const { isValidatedExecutionIntent } = require("../packages/core/src/intent/validated");
const {
  GOVERNANCE_ADDRESS,
  VOTER,
  nounsAdapterDescriptor,
  prepareNounsVote,
} = require("./helpers/nouns-preparation");

const SAFE = "0x0000000000000000000000000000000000000003";

test("the existing Nouns preparation flow yields canonical intents unchanged", async () => {
  const preparation = await prepareNounsVote();
  assert.equal(preparation.status, "READY_TO_SIGN");

  const vote = voteIntentFromPreparation(preparation);
  assert.deepEqual(
    { ...vote, metadata: undefined },
    {
      version: 1,
      dao: "nouns",
      chainId: 1,
      voterAddress: VOTER,
      proposalId: "42",
      support: "FOR",
      reason: "Support based on the builder's demonstrated delivery.",
      createdAt: "2026-01-03T00:00:00.000Z",
      metadata: undefined,
    },
  );
  // Governance reasoning is preserved as annotation, not as structure.
  assert.equal(vote.metadata.recommendation, "FOR");
  assert.equal(vote.metadata.confidencePercent, 80);

  const intent = executionIntentFromPreparation(preparation);
  assert.equal(intent.target, GOVERNANCE_ADDRESS);
  assert.equal(intent.actor, VOTER);
  assert.equal(intent.value, "0");
  assert.equal(intent.operation, "CALL");
  assert.equal(intent.data, preparation.transaction.data.toLowerCase());
  assert.equal(intent.source.voteIntentHash, voteIntentHash(vote));
  assert.equal(intent.source.action, "CAST_VOTE");

  const validated = validatedIntentFromPreparation(nounsAdapterDescriptor(), preparation);
  assert.ok(isValidatedExecutionIntent(validated));
  assert.equal(validated.intentHash, executionIntentHash(intent));
  assert.equal(validated.validation.proposalState, "ACTIVE");
  assert.equal(validated.validation.selector, "0x8136730f");
  assert.equal(validated.validation.autonomyAllowed, false);
});

test("a Safe execution address becomes the actor while the model voter stays the voter", async () => {
  const preparation = await prepareNounsVote({ executionAddress: SAFE, assetOwnerAddress: VOTER });
  const vote = voteIntentFromPreparation(preparation);
  const intent = executionIntentFromPreparation(preparation);

  // This separation is why there are two artifacts: the governance identity and
  // the address that originates the call are different things.
  assert.equal(vote.voterAddress, VOTER);
  assert.equal(intent.actor, SAFE);
  assert.ok(isValidatedExecutionIntent(validatedIntentFromPreparation(nounsAdapterDescriptor(), preparation)));
});

test("a blocked preparation cannot cross the boundary", async () => {
  const blocked = await prepareNounsVote({ state: 3 });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.transaction, null);

  for (const derive of [voteIntentFromPreparation, executionIntentFromPreparation, validationEvidenceFromPreparation]) {
    assert.throws(() => derive(blocked), /READY_TO_SIGN/, derive.name);
  }
  assert.throws(
    () => validatedIntentFromPreparation(nounsAdapterDescriptor(), blocked),
    /READY_TO_SIGN/,
  );
});

test("evidence records what was verified and re-validation catches a doctored document", async () => {
  const preparation = await prepareNounsVote();
  const evidence = validationEvidenceFromPreparation(preparation);
  const codes = evidence.checks.map((check) => check.code);

  for (const expected of [
    "PROPOSAL_STATE_VOTABLE",
    "CANONICAL_PROPOSAL_IDENTITY",
    "CANONICAL_VOTING_WINDOW",
    "CANONICAL_ACTIONS_MATCH",
    "VOTING_POWER_ELIGIBLE",
    "ACTOR_AUTHORIZED",
    "SIMULATION_SUCCEEDED",
    "SECURITY_REVIEW_CLEARED",
    "PREDICTION_REVIEW_CLEARED",
  ]) {
    assert.ok(codes.includes(expected), `missing ${expected}`);
  }
  assert.ok(evidence.checks.every((check) => check.passed));
  assert.equal(evidence.actorEligible, true);

  // Retargeting a stored preparation does not survive re-validation, because
  // the adapter's declared governance contracts are the authority.
  const retargeted = {
    ...preparation,
    transaction: { ...preparation.transaction, to: "0x00000000000000000000000000000000000000ff" },
  };
  assert.throws(
    () => validatedIntentFromPreparation(nounsAdapterDescriptor(), retargeted),
    (error) => error.code === "TARGET_NOT_GOVERNANCE_CONTRACT",
  );

  // Flipping status to READY without clearing the finding still fails: the
  // adapter's own blockers are carried into the evidence.
  const laundered = {
    ...preparation,
    blockers: [{ code: "PROPOSAL_NOT_ACTIVE", message: "Canonical proposal state is DEFEATED, not ACTIVE." }],
  };
  assert.throws(
    () => validatedIntentFromPreparation(nounsAdapterDescriptor(), laundered),
    (error) => error.code === "ADAPTER_CHECKS_FAILED",
  );
});

test("autonomy stays closed unless the prediction review opened it", async () => {
  const advisory = await prepareNounsVote();
  assert.equal(validationEvidenceFromPreparation(advisory).autonomyAllowed, false);

  const cleared = await prepareNounsVote({
    prediction: {
      predictionReview: {
        requiresHumanReview: false,
        autonomyAllowed: true,
        reasonCodes: [],
        backtest: null,
      },
    },
  });
  assert.equal(validationEvidenceFromPreparation(cleared).autonomyAllowed, true);
});

test("a deadline supplied by the caller reaches the validated intent", async () => {
  const preparation = await prepareNounsVote();
  const withoutDeadline = validatedIntentFromPreparation(nounsAdapterDescriptor(), preparation);
  assert.deepEqual(withoutDeadline.validation.deadline, { kind: "none", value: null });

  const withDeadline = validatedIntentFromPreparation(nounsAdapterDescriptor(), preparation, {
    deadline: { kind: "block", value: "200" },
  });
  assert.deepEqual(withDeadline.validation.deadline, { kind: "block", value: "200" });
  // The deadline is evidence, not identity: it must not change the intent hash.
  assert.equal(withDeadline.intentHash, withoutDeadline.intentHash);
});
