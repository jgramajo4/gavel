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

const { getAddress } = require("ethers");

const { assertExecutionAdapter } = require("./adapter");
const { ExecutionEvent, NULL_EVENT_SINK, STATE_EVENTS, buildEvent } = require("./events");
const { ExecutionState, canTransition, toExecutionState } = require("./lifecycle");
const { ExecutionModeKind, getExecutionMode } = require("./modes");
const {
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
  reusablePreparedRecord,
} = require("./replay");
const { assertValidatedExecutionIntent } = require("../intent/validated");

class ExecutionEngine {
  #adapters;

  /**
   * @param {object} options
   * @param {Iterable<object>} [options.adapters]  execution adapters, keyed by their own `mode`
   * @param {object} [options.store]               an execution record store
   * @param {object} [options.events]              an event sink with `emit(event)`
   * @param {Function} [options.now]               clock, for tests
   */
  constructor(options = {}) {
    this.#adapters = new Map();
    // The store is required. Defaulting to memory meant a restart silently
    // lost every deduplication and replay guarantee -- the failure mode of
    // which is a duplicate governance action, not an error. Making it explicit
    // forces the decision at construction; `InMemoryExecutionRecordStore` is
    // still the right answer in tests, but it has to be asked for.
    if (
      !options.store ||
      typeof options.store.put !== "function" ||
      typeof options.store.withLocks !== "function"
    ) {
      throw new TypeError(
        "ExecutionEngine requires an explicit execution record store. Use FileExecutionRecordStore " +
          "for a durable one, or InMemoryExecutionRecordStore in tests -- there is no default, " +
          "because an in-memory default loses deduplication across restarts.",
      );
    }
    this.store = options.store;
    this.events = options.events || NULL_EVENT_SINK;
    this.now = options.now || (() => new Date());
    for (const adapter of options.adapters || []) this.register(adapter);
  }

  register(adapter) {
    const checked = assertExecutionAdapter(adapter);
    const mode = getExecutionMode(checked.mode).mode;
    if (this.#adapters.has(mode)) throw new Error(`An execution adapter is already registered for ${mode}`);
    this.#adapters.set(mode, checked);
    return checked;
  }

  adapterFor(mode) {
    const definition = getExecutionMode(mode);
    const adapter = this.#adapters.get(definition.mode);
    if (!adapter) {
      throw new Error(
        `No execution adapter is registered for ${definition.mode}` +
          (definition.implemented ? "" : " (the mode is declared but not implemented)"),
      );
    }
    return adapter;
  }

  /**
   * The identity invariant, on the execution path.
   *
   * The types are non-substitutable, but their constructors are public and one
   * `SigningIdentity` can back both roles -- and two different credential
   * references in a profile can resolve to the same key, so a string comparison
   * there proves nothing. This resolves the actual addresses of every
   * registered adapter's identity and refuses to run if a proposal identity and
   * an execution identity are the same address.
   *
   * Checked at every security-sensitive boundary because a remote signer can
   * resolve to a different address after an earlier check.
   */
  async #assertIdentitySeparation() {
    const identities = [];
    for (const adapter of this.#adapters.values()) {
      const role = getExecutionMode(adapter.mode).identityRole;
      const identity = typeof adapter.getProposalIdentity === "function"
        ? adapter.getProposalIdentity()
        : adapter.proposalIdentity || adapter.executionIdentity;
      if (!role || !identity) continue;
      identities.push({ role, mode: adapter.mode, address: getAddress(await identity.address()) });
    }
    for (const proposal of identities.filter((entry) => entry.role === "proposal")) {
      for (const execution of identities.filter((entry) => entry.role === "execution")) {
        if (proposal.address === execution.address) {
          throw new Error(
            `Identity separation violated: ${proposal.address} is configured as both the ` +
              `${proposal.mode} proposal identity and the ${execution.mode} execution identity. ` +
              "These must be distinct keys, because the autonomous identity has materially more authority.",
          );
        }
      }
    }
  }

  #emit(name, source, detail, mode) {
    return this.events.emit(buildEvent(name, source, detail, { now: this.now(), mode }));
  }

  #lockKeys(intent, mode, adapter) {
    const key = executionKey({ intentHash: intent.intentHash, mode, actor: intent.intent.actor });
    const proposal = [
      intent.dao,
      intent.intent.source.proposalId,
      getAddress(intent.intent.actor).toLowerCase(),
    ].join(":");
    const adapterKeys = typeof adapter.lockKeys === "function" ? adapter.lockKeys(intent) : [];
    return [`idempotency:${key}`, `proposal:${proposal}`, ...adapterKeys];
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
    return this.store.withLocks(this.#lockKeys(intent, mode, adapter), () =>
      this.#prepareLocked(intent, options, mode, adapter));
  }

  async #prepareLocked(intent, options, mode, adapter) {
    await this.#assertIdentitySeparation();
    const key = executionKey({ intentHash: intent.intentHash, mode, actor: intent.intent.actor });

    const existingForKey = await this.store.listByKey(key);
    let idempotent = resolveIdempotency(existingForKey);
    let retryProviderData = null;
    if (
      idempotent?.record.providerData.providerStatus === "submission-outcome-unknown" &&
      typeof adapter.reconcile === "function"
    ) {
      const reconciled = await adapter.reconcile(idempotent.record, options);
      if (!reconciled) {
        retryProviderData = { ...idempotent.record.providerData };
        await this.#advance(idempotent.record, {
          state: ExecutionState.FAILED,
          providerData: { providerStatus: "definitely-not-submitted" },
          detail: "the provider definitively does not contain the write-ahead transaction",
        });
        idempotent = null;
      } else {
        idempotent.record = await this.#advance(idempotent.record, {
          state: toExecutionState(reconciled.state ?? reconciled.status),
          providerData: reconciled.providerData || {},
          detail: reconciled.detail ?? null,
        });
      }
    }
    if (idempotent) {
      this.#emit(
        ExecutionEvent.EXECUTION_DEDUPLICATED,
        idempotent.record,
        { reasonCode: idempotent.reason, existingExecutionId: idempotent.record.id, state: idempotent.record.state },
        mode,
      );
      return { record: idempotent.record, preparation: null, deduplicated: true, reason: idempotent.reason };
    }

    // PREPARED may mean the process died after the provider accepted the POST
    // but before the write-ahead SUBMITTED record landed. Check its deterministic
    // provider hash before rebuilding or posting anything.
    const reusable = reusablePreparedRecord(existingForKey);
    if (
      reusable?.providerData.safeTxHash &&
      typeof adapter.reconcile === "function"
    ) {
      const reconciled = await adapter.reconcile(reusable, options);
      if (reconciled) {
        const reported = toExecutionState(reconciled.state ?? reconciled.status);
        let record = reusable;
        if (reported !== record.state && !canTransition(record.state, reported)) {
          record = await this.#advance(record, {
            state: ExecutionState.SUBMITTED,
            detail: "inferred: the provider already contains this prepared transaction",
          });
        }
        record = await this.#advance(record, {
          state: reported,
          providerData: reconciled.providerData || {},
          detail: reconciled.detail ?? null,
        });
        this.#emit(
          ExecutionEvent.EXECUTION_DEDUPLICATED,
          record,
          { reasonCode: "existing-provider-transaction", existingExecutionId: record.id, state: record.state },
          mode,
        );
        return {
          record,
          preparation: null,
          deduplicated: true,
          reason: "existing-provider-transaction",
        };
      }
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

    // A prepared-but-unsubmitted attempt for this key is reused rather than
    // superseded, so a dry run followed by a real submission is one attempt in
    // the audit trail instead of two.
    let record =
      reusable ||
      createExecutionRecord(intent, { mode, now: this.now(), attempt: nextAttempt(existingForKey) });
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
      preparation = await adapter.prepare(intent, {
        ...options,
        existingProviderData: reusable?.providerData || retryProviderData || null,
      });
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
    const intent = assertValidatedExecutionIntent(validated);
    const mode = getExecutionMode(options.mode).mode;
    const adapter = this.adapterFor(mode);
    return this.store.withLocks(this.#lockKeys(intent, mode, adapter), async () => {
      const prepared = await this.#prepareLocked(intent, options, mode, adapter);
      await this.#assertIdentitySeparation();
      if (prepared.deduplicated) return prepared;

      let record = prepared.record;
      let submission;
      const supportsWriteAhead =
        getExecutionMode(record.mode).kind !== ExecutionModeKind.OFFLINE &&
        typeof adapter.reconcile === "function" &&
        typeof record.providerData.safeTxHash === "string";
      let dispatched = false;
      const beforeProviderDispatch = async () => {
        if (!supportsWriteAhead || dispatched) return;
        record = await this.#advance(record, {
          state: ExecutionState.SUBMITTED,
          providerData: { providerStatus: "submission-outcome-unknown" },
          detail: "provider submission outcome is not yet known",
        });
        dispatched = true;
      };
      try {
        submission = await adapter.submit(prepared.preparation, {
          ...options,
          beforeProviderDispatch,
        });
      } catch (error) {
        if (dispatched && error?.submissionOutcome !== "definitely-not-submitted") {
          await this.#advance(record, {
            state: ExecutionState.SUBMITTED,
            providerData: { providerStatus: "submission-outcome-unknown" },
            detail: error.message,
          }, error.message);
        } else {
          await this.#advance(record, { state: ExecutionState.FAILED, detail: error.message }, error.message);
        }
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
      if (
        reported !== ExecutionState.PREPARED &&
        reported !== record.state &&
        !canTransition(record.state, reported)
      ) {
        // Marked as inferred, so the history is not mistaken for a step the
        // provider actually reported. The submission demonstrably happened --
        // the provider returned an outcome -- but Gavel never observed a
        // distinct submitted state for it.
        record = await this.#advance(record, {
          state: ExecutionState.SUBMITTED,
          detail: "inferred: the provider submitted and reported an outcome in one call",
        });
      }
      const sameStateDetail = reported === record.state ? record.history.at(-1)?.detail ?? null : undefined;
      record = await this.#advance(record, {
        state: reported,
        providerData: {
          ...(submission.providerData || {}),
          ...(dispatched && !submission.providerData?.providerStatus
            ? { providerStatus: "submitted" }
            : {}),
        },
        detail: sameStateDetail ?? submission.detail ?? null,
      });
      for (const event of submission.events || []) {
        this.#emit(event.name, record, event.detail || {}, record.mode);
      }
      return { record, preparation: prepared.preparation, submission, deduplicated: false, reason: null };
    });
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
