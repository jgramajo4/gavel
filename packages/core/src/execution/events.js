/**
 * Structured execution events.
 *
 * Every event carries the same correlation fields, so an audit query can follow
 * one governance decision from recommendation to onchain inclusion by
 * `intentHash` alone.
 *
 * Nothing secret is emitted. `buildEvent()` assembles the payload from a fixed
 * allowlist rather than spreading a caller's object, so a key, a signature or a
 * provider credential cannot reach a log by being added to a call site
 * somewhere else. Calldata is included because it is public onchain data and is
 * the thing an auditor most needs; signatures are not, because they are
 * authorization material.
 */

const REDACTED_KEY_PATTERN = /privatekey|secret|mnemonic|seed|signature|credential|token|password|apikey/i;

const ExecutionEvent = Object.freeze({
  INTENT_CREATED: "intent.created",
  INTENT_VALIDATED: "intent.validated",
  INTENT_REJECTED: "intent.rejected",
  EXECUTION_PREPARED: "execution.prepared",
  EXECUTION_SUBMITTED: "execution.submitted",
  EXECUTION_AWAITING_AUTHORIZATION: "execution.awaiting_authorization",
  EXECUTION_AUTHORIZED: "execution.authorized",
  EXECUTION_EXECUTED: "execution.executed",
  EXECUTION_FAILED: "execution.failed",
  EXECUTION_DEDUPLICATED: "execution.deduplicated",
  EXECUTION_REPLAY_REJECTED: "execution.replay_rejected",
  EXECUTION_EXPIRED: "execution.expired",
  SAFE_PROPOSED: "safe.proposed",
  SAFE_REJECTED: "safe.rejected",
  SAFE_EXECUTED: "safe.executed",
  WAAP_AUTHORIZED: "waap.authorized",
  WAAP_BROADCAST: "waap.broadcast",
  WAAP_CONFIRMED: "waap.confirmed",
  WAAP_POLICY_REJECTED: "waap.policy_rejected",
});

/** Lifecycle state to the event announcing it. */
const STATE_EVENTS = Object.freeze({
  VALIDATED: ExecutionEvent.INTENT_VALIDATED,
  PREPARED: ExecutionEvent.EXECUTION_PREPARED,
  SUBMITTED: ExecutionEvent.EXECUTION_SUBMITTED,
  AWAITING_AUTHORIZATION: ExecutionEvent.EXECUTION_AWAITING_AUTHORIZATION,
  AUTHORIZED: ExecutionEvent.EXECUTION_AUTHORIZED,
  EXECUTING: ExecutionEvent.EXECUTION_SUBMITTED,
  EXECUTED: ExecutionEvent.EXECUTION_EXECUTED,
  FAILED: ExecutionEvent.EXECUTION_FAILED,
  CANCELLED: ExecutionEvent.EXECUTION_FAILED,
  EXPIRED: ExecutionEvent.EXECUTION_EXPIRED,
});

/** The only detail keys an event may carry, beyond the correlation fields. */
const ALLOWED_DETAIL_KEYS = Object.freeze([
  "state",
  "previousState",
  "attempt",
  "reasonCode",
  "message",
  "proposalState",
  "safeTxHash",
  "safeNonce",
  "safeAddress",
  "transactionHash",
  "providerRequestId",
  "providerStatus",
  "existingExecutionId",
  "autonomyAllowed",
  "adapterVersion",
  "deadlineKind",
]);

function assertNoSecrets(detail) {
  for (const key of Object.keys(detail || {})) {
    if (REDACTED_KEY_PATTERN.test(key)) {
      throw new Error(`Refusing to emit an execution event carrying '${key}'`);
    }
  }
}

/**
 * Build one event. Correlation comes from the intent or the record; detail is
 * filtered to the allowlist, so an unexpected key is dropped rather than
 * logged.
 */
function buildEvent(name, source, detail = {}, options = {}) {
  if (!Object.values(ExecutionEvent).includes(name)) throw new Error(`Unknown execution event: ${name}`);
  assertNoSecrets(detail);
  const intent = source?.intent?.source ? source.intent : null;
  const filtered = {};
  for (const key of ALLOWED_DETAIL_KEYS) {
    if (detail[key] !== undefined && detail[key] !== null) filtered[key] = detail[key];
  }
  return {
    event: name,
    at: new Date(options.now || Date.now()).toISOString(),
    intentHash: source?.intentHash ?? null,
    voteIntentHash: intent ? intent.source.voteIntentHash : source?.voteIntentHash ?? null,
    dao: intent ? intent.source.dao : source?.dao ?? null,
    proposalId: intent ? intent.source.proposalId : source?.proposalId ?? null,
    support: intent ? intent.source.support : source?.support ?? null,
    executionMode: source?.mode ?? options.mode ?? null,
    actor: intent ? intent.actor : source?.actor ?? null,
    target: intent ? intent.target : source?.target ?? null,
    chainId: intent ? intent.chainId : source?.chainId ?? null,
    ...filtered,
  };
}

/**
 * A sink that collects events in memory. The default in tests and the
 * reference shape for a real one: `emit(event)` and nothing else.
 */
class InMemoryEventSink {
  constructor() {
    this.events = [];
  }

  emit(event) {
    this.events.push(event);
    return event;
  }

  named(name) {
    return this.events.filter((event) => event.event === name);
  }

  names() {
    return this.events.map((event) => event.event);
  }
}

/** A sink that drops everything, so the engine never needs a null check. */
const NULL_EVENT_SINK = Object.freeze({ emit: () => undefined });

module.exports = {
  ALLOWED_DETAIL_KEYS,
  ExecutionEvent,
  InMemoryEventSink,
  NULL_EVENT_SINK,
  STATE_EVENTS,
  buildEvent,
};
