/**
 * The provider-neutral execution lifecycle.
 *
 * The previous `ExecutionStatus` was Safe's vocabulary in a neutral schema --
 * `PROPOSED`, `AWAITING_APPROVAL`, `READY_TO_EXECUTE` are Safe Transaction
 * Service concepts, and a WaaP broadcast has no meaningful "proposed" step. It
 * was also not a state machine: any status could follow any other.
 *
 * This is one state machine every provider maps into.
 *
 *   Safe supervised:  VALIDATED -> PREPARED -> SUBMITTED
 *                     -> AWAITING_AUTHORIZATION -> AUTHORIZED -> EXECUTED
 *   WaaP autonomous:  VALIDATED -> PREPARED -> AUTHORIZED (by policy)
 *                     -> EXECUTING -> EXECUTED
 *   Unsigned:         VALIDATED -> PREPARED  (and stops; nothing was submitted)
 *
 * The existing names are mapped in rather than duplicated, so there is one
 * state machine in the system and not two that disagree.
 */

const ExecutionState = Object.freeze({
  /** A record exists for an intent. */
  CREATED: "CREATED",
  /** The intent passed canonical Gavel validation. */
  VALIDATED: "VALIDATED",
  /** A provider-specific payload was built but nothing left the process. */
  PREPARED: "PREPARED",
  /** Handed to the provider. */
  SUBMITTED: "SUBMITTED",
  /** Waiting on an authorizer Gavel does not control -- a human Safe threshold. */
  AWAITING_AUTHORIZATION: "AWAITING_AUTHORIZATION",
  /** Authorization obtained: Safe threshold met, or autonomous policy approved. */
  AUTHORIZED: "AUTHORIZED",
  /** Broadcast and awaiting inclusion. */
  EXECUTING: "EXECUTING",
  EXECUTED: "EXECUTED",
  FAILED: "FAILED",
  /** Withdrawn or rejected before execution. */
  CANCELLED: "CANCELLED",
  /** The governance window closed before authorization. */
  EXPIRED: "EXPIRED",
});

/** Nothing follows these. A new attempt needs a new record. */
const TERMINAL_STATES = Object.freeze(
  new Set([
    ExecutionState.EXECUTED,
    ExecutionState.FAILED,
    ExecutionState.CANCELLED,
    ExecutionState.EXPIRED,
  ]),
);

/** The only state that means the governance action actually happened. */
const SUCCESS_STATES = Object.freeze(new Set([ExecutionState.EXECUTED]));

/**
 * States in which an attempt is still live, so a second submission of the same
 * intent would duplicate a governance action rather than retry a dead one.
 */
const ACTIVE_STATES = Object.freeze(
  new Set([
    ExecutionState.CREATED,
    ExecutionState.VALIDATED,
    ExecutionState.PREPARED,
    ExecutionState.SUBMITTED,
    ExecutionState.AWAITING_AUTHORIZATION,
    ExecutionState.AUTHORIZED,
    ExecutionState.EXECUTING,
  ]),
);

const ABANDONMENT = Object.freeze([
  ExecutionState.FAILED,
  ExecutionState.CANCELLED,
  ExecutionState.EXPIRED,
]);

const TRANSITIONS = Object.freeze({
  [ExecutionState.CREATED]: Object.freeze([ExecutionState.VALIDATED, ...ABANDONMENT]),
  [ExecutionState.VALIDATED]: Object.freeze([ExecutionState.PREPARED, ...ABANDONMENT]),
  // A supervised provider may report an authorization state directly, and an
  // autonomous one may jump straight to AUTHORIZED after a policy decision.
  [ExecutionState.PREPARED]: Object.freeze([
    ExecutionState.SUBMITTED,
    ExecutionState.AUTHORIZED,
    ...ABANDONMENT,
  ]),
  [ExecutionState.SUBMITTED]: Object.freeze([
    ExecutionState.AWAITING_AUTHORIZATION,
    ExecutionState.AUTHORIZED,
    ExecutionState.EXECUTING,
    ExecutionState.EXECUTED,
    ...ABANDONMENT,
  ]),
  [ExecutionState.AWAITING_AUTHORIZATION]: Object.freeze([
    ExecutionState.AUTHORIZED,
    ExecutionState.EXECUTING,
    ExecutionState.EXECUTED,
    ...ABANDONMENT,
  ]),
  [ExecutionState.AUTHORIZED]: Object.freeze([
    ExecutionState.EXECUTING,
    ExecutionState.EXECUTED,
    ...ABANDONMENT,
  ]),
  // Once broadcast, the only honest outcomes are inclusion or failure.
  [ExecutionState.EXECUTING]: Object.freeze([ExecutionState.EXECUTED, ExecutionState.FAILED]),
  [ExecutionState.EXECUTED]: Object.freeze([]),
  [ExecutionState.FAILED]: Object.freeze([]),
  [ExecutionState.CANCELLED]: Object.freeze([]),
  [ExecutionState.EXPIRED]: Object.freeze([]),
});

/**
 * Provider and legacy vocabularies mapped into the canonical states.
 *
 * `READY_TO_SIGN` is the vote-preparation status; the Safe words come from the
 * current `ExecutionStatus`; `AUTHORIZED_BY_POLICY` is the autonomous
 * equivalent of a Safe threshold being met.
 */
const LEGACY_STATE_ALIASES = Object.freeze({
  READY_TO_SIGN: ExecutionState.VALIDATED,
  PREPARED: ExecutionState.PREPARED,
  PROPOSED: ExecutionState.SUBMITTED,
  AWAITING_APPROVAL: ExecutionState.AWAITING_AUTHORIZATION,
  READY_TO_EXECUTE: ExecutionState.AUTHORIZED,
  AUTHORIZED_BY_POLICY: ExecutionState.AUTHORIZED,
  EXECUTED: ExecutionState.EXECUTED,
  REJECTED: ExecutionState.CANCELLED,
  EXPIRED: ExecutionState.EXPIRED,
  FAILED: ExecutionState.FAILED,
  // A blocked action never entered the execution layer at all; recording it as
  // FAILED keeps one terminal vocabulary instead of a parallel one.
  BLOCKED: ExecutionState.FAILED,
});

function isExecutionState(value) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, value);
}

/** Translate a provider or legacy status into a canonical state, or throw. */
function toExecutionState(value) {
  const raw = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (isExecutionState(raw)) return raw;
  const mapped = LEGACY_STATE_ALIASES[raw];
  if (mapped) return mapped;
  throw new Error(`Unknown execution status: ${value}`);
}

function isTerminalExecutionState(state) {
  return TERMINAL_STATES.has(toExecutionState(state));
}

function isActiveExecutionState(state) {
  return ACTIVE_STATES.has(toExecutionState(state));
}

function isSuccessfulExecutionState(state) {
  return SUCCESS_STATES.has(toExecutionState(state));
}

function canTransition(from, to) {
  return TRANSITIONS[toExecutionState(from)].includes(toExecutionState(to));
}

/**
 * Advance a state, or throw.
 *
 * Throwing matters: a provider reporting `EXECUTED` and then `PREPARED` is
 * either confused or lying, and a record that silently accepted both would be
 * useless as an audit trail. Repeating the current state is allowed -- status
 * polling returning the same answer twice is normal.
 */
function assertTransition(from, to) {
  const current = toExecutionState(from);
  const next = toExecutionState(to);
  if (current === next) return next;
  if (!canTransition(current, next)) {
    throw new Error(`Illegal execution transition: ${current} -> ${next}`);
  }
  return next;
}

module.exports = {
  ACTIVE_STATES,
  ExecutionState,
  LEGACY_STATE_ALIASES,
  SUCCESS_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isActiveExecutionState,
  isExecutionState,
  isSuccessfulExecutionState,
  isTerminalExecutionState,
  toExecutionState,
};
