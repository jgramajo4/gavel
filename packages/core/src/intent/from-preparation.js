/**
 * The migration bridge: existing vote-preparation documents into canonical
 * intents.
 *
 * Phase 1 of the execution-architecture migration adapts the current flow to
 * the canonical intents without changing any DAO adapter or any CLI surface.
 * `gavel prepare-vote` keeps emitting the same `votePreparation` document; this
 * module reads one and derives the three canonical artifacts from it, so
 * everything below the boundary can be written against intents from the start.
 *
 * It is deliberately one-way. A preparation document is a rich, DAO-shaped
 * record of both governance reasoning and chain verification; the intents are
 * the narrow canonical slices of it. Later phases move adapters to emit intents
 * natively (`buildVoteIntent` / `buildExecutionIntent`) and this bridge becomes
 * the compatibility path for stored documents rather than the main road.
 *
 * Nothing here relaxes validation. The derived evidence is fed to
 * `validateExecutionIntent()`, which re-derives the selector and re-checks the
 * target against the adapter's declared governance contracts exactly as it does
 * for a natively built intent.
 */

const { getAddress } = require("ethers");

const { createVoteIntent } = require("./vote-intent");
const { createExecutionIntent } = require("./execution-intent");
const { validateExecutionIntent } = require("./validated");
const { normalizeUint, selectorOf } = require("./canonical");

/**
 * Only a canonically validated, unblocked preparation may cross the boundary.
 * This is the governance invariant at its narrowest point.
 */
function assertReadyPreparation(preparation) {
  if (!preparation || typeof preparation !== "object") {
    throw new TypeError("A vote preparation document is required");
  }
  if (preparation.status !== "READY_TO_SIGN" || !preparation.transaction) {
    throw new Error(
      "Only a canonically validated READY_TO_SIGN preparation may cross the execution boundary",
    );
  }
  return preparation;
}

function voteIntentFromPreparation(preparation, options = {}) {
  const ready = assertReadyPreparation(preparation);
  return createVoteIntent({
    dao: ready.dao,
    chainId: ready.chainId,
    // The voter is the governance identity -- the address whose history and
    // preferences the model represents -- not whichever address will originate
    // the call. That distinction is the whole point of the two artifacts.
    voterAddress: ready.addressRoles?.modelAddress || ready.modelVoter,
    proposalId: ready.proposalId,
    support: ready.selectedSupport,
    reason: ready.reason?.text ?? null,
    createdAt: options.createdAt || ready.generatedAt,
    metadata: {
      proposalContentHash: ready.proposalContentHash,
      recommendation: ready.recommendation,
      confidencePercent: ready.confidencePercent,
      policySource: ready.policySource,
      policySourceId: ready.policySourceId ?? null,
      preparationSchemaVersion: ready.schemaVersion,
    },
  });
}

function executionIntentFromPreparation(preparation, options = {}) {
  const ready = assertReadyPreparation(preparation);
  const voteIntent = options.voteIntent || voteIntentFromPreparation(ready, options);
  return createExecutionIntent({
    voteIntent,
    chainId: ready.transaction.chainId,
    actor: ready.addressRoles?.executionAddress || ready.transaction.from || ready.votingAddress,
    target: ready.transaction.to,
    value: normalizeUint(ready.transaction.value ?? 0n, "transaction value"),
    data: ready.transaction.data,
    action: options.action || "CAST_VOTE",
  });
}

function check(code, passed, detail = null) {
  return { code, passed: Boolean(passed), detail };
}

/**
 * Derive ValidationEvidence from a preparation's `verification` block.
 *
 * The three adapters emit slightly different verification shapes (see the
 * architecture note), so each check falls back across the known field names and
 * omits itself when a DAO has no such concept. Only checks that are present and
 * false can fail validation; a missing concept is not a silent pass because the
 * adapter's own blocker list is carried through as well -- and a preparation
 * with any blocker is not READY_TO_SIGN in the first place.
 */
function validationEvidenceFromPreparation(preparation, options = {}) {
  const ready = assertReadyPreparation(preparation);
  const verification = ready.verification || {};
  const checks = [];
  const maybe = (code, value, detail) => {
    if (value !== undefined && value !== null) checks.push(check(code, value, detail ?? null));
  };

  maybe("PROPOSAL_STATE_VOTABLE", verification.proposalState?.active, verification.proposalState?.label);
  maybe("CANONICAL_PROPOSAL_IDENTITY", verification.proposalIdentityMatches);
  maybe("CANONICAL_VOTING_WINDOW", verification.votingWindowMatches);
  maybe("CANONICAL_ACTIONS_MATCH", verification.executableActionsMatch);
  maybe("GOVERNANCE_CODE_PRESENT", verification.governanceCodePresent);
  maybe("VOTING_POWER_ELIGIBLE", verification.votingPower?.eligible);
  maybe(
    "ACTOR_AUTHORIZED",
    verification.delegation?.matchesVotingAddress ?? verification.votingKey?.authorized,
  );
  maybe("SIMULATION_SUCCEEDED", verification.simulation?.attempted ? verification.simulation.succeeded : undefined);
  checks.push(
    check(
      "SECURITY_REVIEW_CLEARED",
      !ready.security?.requiresHumanReview || ready.security?.reviewAcknowledged === true,
      ready.security?.riskLevel ?? null,
    ),
  );
  checks.push(
    check(
      "PREDICTION_REVIEW_CLEARED",
      !ready.predictionReview?.requiresHumanReview || ready.predictionReview?.reviewAcknowledged === true,
    ),
  );
  // A READY_TO_SIGN preparation has no blockers by construction; carrying them
  // anyway means a hand-edited document cannot quietly drop its own findings.
  for (const blocker of ready.blockers || []) checks.push(check(blocker.code, false, blocker.message));

  // `actorEligible` means what it says -- this actor may cast this vote -- and
  // is read only from the actor-specific checks. Deriving it from "every check
  // passed" would make every other failure surface as ACTOR_NOT_ELIGIBLE and
  // bury the real reason.
  const actorChecks = checks.filter(
    (entry) => entry.code === "VOTING_POWER_ELIGIBLE" || entry.code === "ACTOR_AUTHORIZED",
  );
  const selector = selectorOf(ready.transaction.data);
  return {
    adapterVersion: options.adapterVersion || `${ready.dao}@${ready.schemaVersion || "unversioned"}`,
    validatedAt: ready.generatedAt,
    proposalState: verification.proposalState?.label || "UNKNOWN",
    proposalStateVotable: verification.proposalState?.active === true,
    governanceTarget: getAddress(ready.transaction.to),
    selector,
    actorEligible: actorChecks.length > 0 && actorChecks.every((entry) => entry.passed),
    // Defaults closed. Only an explicit prediction-review decision opens it.
    autonomyAllowed: ready.predictionReview?.autonomyAllowed === true,
    deadline: options.deadline || { kind: "none", value: null },
    checks,
  };
}

/**
 * The whole bridge in one call: a preparation document plus its DAO adapter
 * becomes a ValidatedExecutionIntent, or throws.
 *
 * `options.deadline` should be supplied whenever the caller knows the
 * proposal's voting deadline -- it is what lets the execution layer reject a
 * stale intent later. Omitted, the evidence records `{ kind: "none" }` and
 * replay protection falls back to DAO-declared semantics and execution records.
 */
function validatedIntentFromPreparation(adapter, preparation, options = {}) {
  const voteIntent = voteIntentFromPreparation(preparation, options);
  const intent = executionIntentFromPreparation(preparation, { ...options, voteIntent });
  const evidence = validationEvidenceFromPreparation(preparation, {
    ...options,
    adapterVersion: options.adapterVersion || adapter?.adapterVersion,
  });
  return validateExecutionIntent({ adapter, intent, evidence, voteIntent });
}

module.exports = {
  assertReadyPreparation,
  executionIntentFromPreparation,
  validatedIntentFromPreparation,
  validationEvidenceFromPreparation,
  voteIntentFromPreparation,
};
