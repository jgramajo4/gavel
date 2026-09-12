/**
 * The execution engine: the one place a validated intent becomes an attempt.
 *
 * Everything provider-independent lives here, so no execution adapter has to
 * reimplement it and no two adapters can disagree about it:
 *
 *   - the validated-intent gate
 *   - execution-mode resolution and capability gating
 *   - idempotency on intentHash + mode + actor
 *   - replay rejection under DAO-declared semantics
 *   - freshness against the governance deadline
 *   - lifecycle transitions and record persistence
 *   - structured events
 *
 * An execution adapter is then only three methods of genuinely
 * provider-specific work. That asymmetry is intentional: adding a wallet
 * backend should not mean re-deriving how governance actions behave.
 *
 * The engine knows no DAO. It never sees a governor ABI, a proposal, or an
 * adapter -- only a validated intent carrying the semantics and deadline the
 * DAO adapter recorded.
 */

const { assertExecutionAdapter } = require("./adapter");
const { ExecutionEvent, NULL_EVENT_SINK, STATE_EVENTS, buildEvent } = require("./events");
const { ExecutionState, canTransition, toExecutionState } = require("./lifecycle");
const { getExecutionMode } = require("./modes");
const {
  InMemoryExecutionRecordStore,
  advanceExecutionRecord,
  createExecutionRecord,
  executionKey,
} = require("./records");
const {
  ReplayRejected,
  assertFresh,
  assertReplayAllowed,
  nextAttempt,
  resolveIdempotency,
} = require("./replay");
const { assertValidatedExecutionIntent } = require("../intent/validated");

class ExecutionEngine {
  /**
   * @param {object} options
   * @param {Iterable<object>} [options.adapters]  execution adapters, keyed by their own `mode`
   * @param {object} [options.store]               an execution record store
   * @param {object} [options.events]              an event sink with `emit(event)`
   * @param {Function} [options.now]               clock, for tests
   */
  constructor(options = {}) {
    this.adapters = new Map();
    for (const adapter of options.adapters || []) this.register(adapter);
    this.store = options.store || new InMemoryExecutionRecordStore();
    this.events = options.events || NULL_EVENT_SINK;
    this.now = options.now || (() => new Date());
  }

  register(adapter) {
    const checked = assertExecutionAdapter(adapter);
    const mode = getExecutionMode(checked.mode).mode;
    if (this.adapters.has(mode)) throw new Error(`An execution adapter is already registered for ${mode}`);
    this.adapters.set(mode, checked);
    return checked;
  }

  adapterFor(mode) {
    const definition = getExecutionMode(mode);
    const adapter = this.adapters.get(definition.mode);
    if (!adapter) {
      throw new Error(
        `No execution adapter is registered for ${definition.mode}` +
          (definition.implemented ? "" : " (the mode is declared but not implemented)"),
      );
    }
    return adapter;
  }

  #emit(name, source, detail, mode) {
    return this.events.emit(buildEvent(name, source, detail, { now: this.now(), mode }));
  }

  async #advance(record, next, detail) {
    const before = record.state;
    const advanced = advanceExecutionRecord(record, next, { now: this.now() });
    const stored = await this.store.put(advanced);
    const eventName = STATE_EVENTS[stored.state];
    if (eventName && stored.state !== before) {
      this.#emit(
        eventName,
        stored,
        {
          state: stored.state,
          previousState: before,
          attempt: stored.attempt,
          message: detail ?? undefined,
          ...stored.providerData,
        },
        stored.mode,
      );
    }
    return stored;
  }

  /**
   * Prepare a validated intent for a mode without submitting anything.
   *
   * Safe to call speculatively: it performs the same gates as `submit()` and
   * records a PREPARED attempt, but no execution adapter reaches its provider.
   */
  async prepare(validated, options = {}) {
    const intent = assertValidatedExecutionIntent(validated);
    const mode = getExecutionMode(options.mode).mode;
    const adapter = this.adapterFor(mode);
    const key = executionKey({ intentHash: intent.intentHash, mode, actor: intent.intent.actor });

    const existingForKey = await this.store.listByKey(key);
    const idempotent = resolveIdempotency(existingForKey);
    if (idempotent) {
      this.#emit(
        ExecutionEvent.EXECUTION_DEDUPLICATED,
        idempotent.record,
        { reasonCode: idempotent.reason, existingExecutionId: idempotent.record.id, state: idempotent.record.state },
        mode,
      );
      return { record: idempotent.record, preparation: null, deduplicated: true, reason: idempotent.reason };
    }

    try {
      assertFresh(intent, options);
      assertReplayAllowed(intent, await this.store.listByProposal({
        dao: intent.dao,
        proposalId: intent.intent.source.proposalId,
        actor: intent.intent.actor,
      }), { ...options, mode });
    } catch (error) {
      if (error instanceof ReplayRejected) {
        this.#emit(
          error.code === "GOVERNANCE_WINDOW_CLOSED"
            ? ExecutionEvent.EXECUTION_EXPIRED
            : ExecutionEvent.EXECUTION_REPLAY_REJECTED,
          intent,
          { reasonCode: error.code, message: error.message, existingExecutionId: error.existing?.id },
          mode,
        );
      }
      throw error;
    }

    let record = createExecutionRecord(intent, {
      mode,
      now: this.now(),
      attempt: nextAttempt(existingForKey),
    });
    record = await this.store.put(record);
    this.#emit(
      ExecutionEvent.INTENT_VALIDATED,
      record,
      {
        state: record.state,
        attempt: record.attempt,
        proposalState: record.audit.proposalState,
        adapterVersion: record.audit.adapterVersion,
        autonomyAllowed: record.audit.autonomyAllowed,
        deadlineKind: record.audit.deadline.kind,
      },
      mode,
    );

    let preparation;
    try {
      preparation = await adapter.prepare(intent, options);
    } catch (error) {
      await this.#advance(record, { state: ExecutionState.FAILED, detail: error.message }, error.message);
      throw error;
    }
    record = await this.#advance(record, {
      state: ExecutionState.PREPARED,
      providerData: preparation.providerData || {},
    });
    return { record, preparation, deduplicated: false, reason: null };
  }

  /**
   * Prepare and submit. The only method that can cause an external effect.
   *
   * A duplicate returns the existing attempt rather than submitting again, so a
   * retried CLI invocation or a re-delivered runtime request cannot queue a
   * second Safe transaction or rebroadcast a confirmed vote.
   */
  async submit(validated, options = {}) {
    const prepared = await this.prepare(validated, options);
    if (prepared.deduplicated) return prepared;

    let record = prepared.record;
    let submission;
    try {
      submission = await this.adapterFor(record.mode).submit(prepared.preparation, options);
    } catch (error) {
      await this.#advance(record, { state: ExecutionState.FAILED, detail: error.message }, error.message);
      throw error;
    }

    // A provider that submits and confirms in one call (an autonomous
    // broadcaster, say) reports EXECUTED straight from PREPARED. Rather than
    // widening the state machine to let PREPARED reach a terminal state, record
    // the submission that demonstrably happened and then the outcome. The
    // history then still shows that something left the process -- which is the
    // fact that matters when a call times out and nobody knows whether it
    // landed. `unsigned` mode reports PREPARED and stays there, because nothing
    // was submitted anywhere.
    const reported = toExecutionState(submission.state ?? submission.status);
    if (reported !== ExecutionState.PREPARED && !canTransition(record.state, reported)) {
      record = await this.#advance(record, { state: ExecutionState.SUBMITTED });
    }
    record = await this.#advance(record, {
      state: reported,
      providerData: submission.providerData || {},
      detail: submission.detail ?? null,
    });
    for (const event of submission.events || []) {
      this.#emit(event.name, record, event.detail || {}, record.mode);
    }
    return { record, preparation: prepared.preparation, submission, deduplicated: false, reason: null };
  }

  /**
   * Refresh one attempt from its provider.
   *
   * Provider metadata is not trusted to be coherent: the reported state must be
   * a legal transition from the recorded one, or the update is refused rather
   * than overwriting the history.
   */
  async status(recordId, options = {}) {
    const record = await this.store.getById(recordId);
    if (!record) throw new Error(`Unknown execution record: ${recordId}`);
    const adapter = this.adapterFor(record.mode);
    const reported = await adapter.status(record, options);
    return this.#advance(record, {
      state: toExecutionState(reported.state ?? reported.status),
      providerData: reported.providerData || {},
      detail: reported.detail ?? null,
    });
  }

  /** Every attempt made against one governance action, newest first. */
  async attempts(intentHash) {
    const records = await this.store.listByIntentHash(intentHash);
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}

module.exports = { ExecutionEngine };
