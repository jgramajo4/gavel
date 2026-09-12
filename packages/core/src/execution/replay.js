/**
 * Replay and duplication rules.
 *
 * Two different questions, deliberately kept apart:
 *
 *   Idempotency  "is this the same attempt again?"  Keyed on
 *                intentHash + mode + actor. A retry must return the existing
 *                attempt, not create a second one.
 *   Replay       "is this a second governance action on the same proposal?"
 *                Decided by DAO-declared semantics, because the DAOs disagree:
 *                a second Nouns vote is a duplicate, a second Railgun vote may
 *                be a legitimate partial vote.
 *
 * Neither rule is hard-coded per provider. The engine asks these functions,
 * which read `validated.validation.semantics` and `validation.deadline` -- both
 * facts the DAO adapter put there.
 */

const { getAddress } = require("ethers");

const { isActiveRecord, isSuccessfulRecord } = require("./records");

class ReplayRejected extends Error {
  constructor(code, message, existing = null) {
    super(message);
    this.name = "ReplayRejected";
    this.code = code;
    this.existing = existing;
  }
}

/**
 * Is the validated intent still inside the governance window?
 *
 * A validated intent stays *structurally* valid forever, which is precisely the
 * replay risk: a document validated while a proposal was ACTIVE can be
 * resubmitted after it closed. The deadline the adapter recorded is what makes
 * staleness detectable without re-reading the chain.
 *
 * `kind: "none"` means the adapter did not supply one. That is not treated as
 * "never expires" silently -- it is reported, so a caller can decide whether to
 * require a deadline.
 */
function evaluateFreshness(validated, clock = {}) {
  const deadline = validated.validation.deadline;
  if (deadline.kind === "none" || deadline.value == null) {
    return { known: false, expired: false, kind: deadline.kind };
  }
  if (deadline.kind === "block") {
    if (clock.blockNumber == null) return { known: false, expired: false, kind: "block" };
    return {
      known: true,
      kind: "block",
      expired: BigInt(clock.blockNumber) > BigInt(deadline.value),
    };
  }
  const nowSeconds = BigInt(Math.floor(new Date(clock.now || Date.now()).getTime() / 1000));
  return { known: true, kind: "timestamp", expired: nowSeconds > BigInt(deadline.value) };
}

function assertFresh(validated, clock = {}) {
  const freshness = evaluateFreshness(validated, clock);
  if (freshness.expired) {
    throw new ReplayRejected(
      "GOVERNANCE_WINDOW_CLOSED",
      `The ${validated.dao} proposal ${validated.intent.source.proposalId} voting window closed ` +
        `(${freshness.kind} deadline ${validated.validation.deadline.value}); this intent must be revalidated`,
    );
  }
  return freshness;
}

/**
 * The idempotency decision, from the records already stored under this key.
 *
 * Returns the record to hand back instead of submitting again, or null to
 * proceed. A live attempt and a succeeded attempt are both reasons not to
 * submit; an abandoned one (failed, cancelled, expired) is not, so a genuine
 * retry after a provider failure still works.
 */
function resolveIdempotency(records) {
  const succeeded = records.find((record) => isSuccessfulRecord(record));
  if (succeeded) return { record: succeeded, reason: "ALREADY_EXECUTED" };
  const active = records.find((record) => isActiveRecord(record));
  if (active) return { record: active, reason: "ALREADY_IN_FLIGHT" };
  return null;
}

/** The next attempt number for a key whose previous attempts are all dead. */
function nextAttempt(records) {
  return records.reduce((highest, record) => Math.max(highest, record.attempt), 0) + 1;
}

/**
 * The replay decision, across every record for this proposal and actor -- not
 * only this intent hash.
 *
 * That breadth is the point. Voting AGAINST after voting FOR on the same
 * proposal is a different intent hash and therefore passes idempotency, but for
 * Nouns it is still a second vote the governor will reject. Only a DAO that
 * declares `canReplaceVote` or `canVoteMultipleTimes` permits it.
 */
function assertReplayAllowed(validated, records, options = {}) {
  const semantics = validated.validation.semantics;
  const actor = getAddress(validated.intent.actor);
  const relevant = records.filter(
    (record) =>
      record.dao === validated.dao &&
      record.proposalId === validated.intent.source.proposalId &&
      getAddress(record.actor) === actor,
  );

  if (semantics.canVoteMultipleTimes) return { allowed: true, reason: "DAO_PERMITS_REPEAT_VOTES" };

  const completed = relevant.filter((record) => isSuccessfulRecord(record));
  const sameIntent = completed.filter((record) => record.intentHash === validated.intentHash);
  const differentIntent = completed.filter((record) => record.intentHash !== validated.intentHash);

  if (sameIntent.length > 0) {
    // The same action already succeeded. Idempotency normally catches this
    // first; it reaches here when the earlier attempt used a different mode.
    throw new ReplayRejected(
      "GOVERNANCE_ACTION_ALREADY_EXECUTED",
      `${actor} already executed this ${validated.dao} vote on proposal ${validated.intent.source.proposalId}` +
        ` via ${sameIntent[0].mode}`,
      sameIntent[0],
    );
  }
  if (differentIntent.length > 0 && !semantics.canReplaceVote) {
    throw new ReplayRejected(
      "VOTE_REPLACEMENT_NOT_PERMITTED",
      `${actor} already voted on ${validated.dao} proposal ${validated.intent.source.proposalId}` +
        ` and ${validated.dao} does not permit replacing a cast vote`,
      differentIntent[0],
    );
  }

  // An attempt still in flight under a *different* mode would race the one
  // being started: two Safe proposals, or a Safe proposal and a broadcast, for
  // one vote. Same-mode in-flight attempts are idempotency's job.
  //
  // The mode being started has to be named for this to mean anything. Without
  // it every in-flight attempt would look like a different mode and be
  // rejected, so an unnamed mode is an error rather than a silent over-rejection.
  if (options.rejectConcurrentModes !== false) {
    if (!options.mode) {
      throw new TypeError("assertReplayAllowed requires the execution mode being started");
    }
    const inFlightElsewhere = relevant.find(
      (record) => isActiveRecord(record) && record.mode !== options.mode,
    );
    if (inFlightElsewhere) {
      throw new ReplayRejected(
        "CONCURRENT_EXECUTION_IN_ANOTHER_MODE",
        `An execution of this ${validated.dao} vote is already in flight via ${inFlightElsewhere.mode};` +
          " cancel it before starting another",
        inFlightElsewhere,
      );
    }
  }

  return {
    allowed: true,
    reason: differentIntent.length > 0 ? "DAO_PERMITS_VOTE_REPLACEMENT" : "NO_PRIOR_EXECUTION",
  };
}

module.exports = {
  ReplayRejected,
  assertFresh,
  assertReplayAllowed,
  evaluateFreshness,
  nextAttempt,
  resolveIdempotency,
};
