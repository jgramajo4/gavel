"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ExecutionState,
  LEGACY_STATE_ALIASES,
  TRANSITIONS,
  assertTransition,
  canTransition,
  isActiveExecutionState,
  isSuccessfulExecutionState,
  isTerminalExecutionState,
  toExecutionState,
} = require("../packages/core/src/execution/lifecycle");
const { ExecutionStatus } = require("../packages/core/src/schema/execution");
const {
  ExecutionModeKind,
  FUTURE_EXECUTION_MODES,
  capabilityForMode,
  getExecutionMode,
  isAutonomous,
  listExecutionModes,
  registerExecutionMode,
} = require("../packages/core/src/execution/modes");

test("the lifecycle covers every state the architecture requires", () => {
  for (const required of [
    "CREATED", "VALIDATED", "PREPARED", "SUBMITTED", "AWAITING_AUTHORIZATION",
    "AUTHORIZED", "EXECUTING", "EXECUTED", "FAILED", "CANCELLED", "EXPIRED",
  ]) {
    assert.equal(ExecutionState[required], required, required);
    assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, required), `${required} has no transitions`);
  }
});

test("every legacy and provider status maps into exactly one canonical state", () => {
  // The point of the mapping is that there is one state machine, not two.
  for (const status of Object.values(ExecutionStatus)) {
    const state = toExecutionState(status);
    assert.ok(Object.prototype.hasOwnProperty.call(TRANSITIONS, state), `${status} -> ${state}`);
  }
  assert.equal(toExecutionState("READY_TO_SIGN"), ExecutionState.VALIDATED);
  assert.equal(toExecutionState("PROPOSED"), ExecutionState.SUBMITTED);
  assert.equal(toExecutionState("AWAITING_APPROVAL"), ExecutionState.AWAITING_AUTHORIZATION);
  assert.equal(toExecutionState("READY_TO_EXECUTE"), ExecutionState.AUTHORIZED);
  assert.equal(toExecutionState("AUTHORIZED_BY_POLICY"), ExecutionState.AUTHORIZED);
  assert.equal(toExecutionState("REJECTED"), ExecutionState.CANCELLED);
  assert.equal(toExecutionState("BLOCKED"), ExecutionState.FAILED);
  // Case and separator tolerant, since providers are not consistent.
  assert.equal(toExecutionState("awaiting-approval"), ExecutionState.AWAITING_AUTHORIZATION);
  assert.throws(() => toExecutionState("SOMETHING_ELSE"), /Unknown execution status/);

  for (const [legacy, state] of Object.entries(LEGACY_STATE_ALIASES)) {
    assert.equal(toExecutionState(legacy), state);
  }
});

test("the documented Safe and WaaP paths are legal and backwards steps are not", () => {
  const walk = (states) => {
    let current = states[0];
    for (const next of states.slice(1)) current = assertTransition(current, next);
    return current;
  };

  assert.equal(
    walk([
      ExecutionState.VALIDATED,
      ExecutionState.PREPARED,
      ExecutionState.SUBMITTED,
      ExecutionState.AWAITING_AUTHORIZATION,
      ExecutionState.AUTHORIZED,
      ExecutionState.EXECUTED,
    ]),
    ExecutionState.EXECUTED,
  );
  assert.equal(
    walk([
      ExecutionState.VALIDATED,
      ExecutionState.PREPARED,
      ExecutionState.AUTHORIZED,
      ExecutionState.EXECUTING,
      ExecutionState.EXECUTED,
    ]),
    ExecutionState.EXECUTED,
  );

  // Nothing follows a terminal state, and nothing walks backwards.
  for (const terminal of [ExecutionState.EXECUTED, ExecutionState.FAILED, ExecutionState.CANCELLED, ExecutionState.EXPIRED]) {
    assert.deepEqual(TRANSITIONS[terminal], []);
    assert.throws(() => assertTransition(terminal, ExecutionState.PREPARED), /Illegal execution transition/);
    assert.ok(isTerminalExecutionState(terminal));
    assert.equal(isActiveExecutionState(terminal), false);
  }
  assert.throws(() => assertTransition(ExecutionState.SUBMITTED, ExecutionState.VALIDATED), /Illegal/);
  assert.throws(() => assertTransition(ExecutionState.EXECUTING, ExecutionState.CANCELLED), /Illegal/);

  // Repeating the current state is fine: polling returns the same answer twice.
  assert.equal(assertTransition(ExecutionState.SUBMITTED, ExecutionState.SUBMITTED), ExecutionState.SUBMITTED);
  assert.equal(canTransition(ExecutionState.PREPARED, ExecutionState.SUBMITTED), true);
  assert.equal(isSuccessfulExecutionState(ExecutionState.EXECUTED), true);
  assert.equal(isSuccessfulExecutionState(ExecutionState.AUTHORIZED), false);
});

test("execution modes are a registry, not a Safe-and-WaaP branch", () => {
  const declared = listExecutionModes().map((mode) => mode.mode);
  for (const mode of ["unsigned", "safe-supervised", "waap-autonomous"]) {
    assert.ok(declared.includes(mode), mode);
    assert.equal(getExecutionMode(mode).implemented, true);
  }
  // Future backends are declared so the architecture is visibly not shaped
  // around two providers, and unimplemented so selecting one is a clear error.
  for (const mode of Object.values(FUTURE_EXECUTION_MODES)) {
    assert.ok(declared.includes(mode), mode);
    assert.equal(getExecutionMode(mode).implemented, false, mode);
  }

  assert.equal(capabilityForMode("safe-supervised"), "safeSupervised");
  assert.equal(capabilityForMode("waap-autonomous"), "waapAutonomous");
  assert.equal(capabilityForMode("unsigned"), "prepareVote");
  assert.equal(capabilityForMode("erc4337"), "erc4337");
  assert.throws(() => capabilityForMode("made-up"), /Unknown execution mode/);

  assert.equal(isAutonomous("waap-autonomous"), true);
  assert.equal(isAutonomous("safe-supervised"), false);
  assert.equal(getExecutionMode("safe-supervised").kind, ExecutionModeKind.SUPERVISED);
  assert.equal(getExecutionMode("unsigned").kind, ExecutionModeKind.OFFLINE);

  // A supervised mode wants a proposal identity; an autonomous one an
  // execution identity. Never the same role.
  assert.equal(getExecutionMode("safe-supervised").identityRole, "proposal");
  assert.equal(getExecutionMode("waap-autonomous").identityRole, "execution");
});

test("registering a new backend needs no change to the execution layer", () => {
  const registered = registerExecutionMode({
    mode: "test-backend",
    kind: ExecutionModeKind.SUPERVISED,
    capability: "testBackend",
    identityRole: "proposal",
    implemented: true,
    description: "A backend added by declaration alone.",
  });
  assert.equal(registered.mode, "test-backend");
  assert.equal(capabilityForMode("test-backend"), "testBackend");
  assert.equal(isAutonomous("test-backend"), false);

  assert.throws(() => registerExecutionMode({ mode: "Bad Mode", kind: ExecutionModeKind.SUPERVISED, capability: "x" }), /execution mode id/);
  assert.throws(() => registerExecutionMode({ mode: "no-kind", capability: "x" }), /needs a kind/);
  assert.throws(() => registerExecutionMode({ mode: "no-capability", kind: ExecutionModeKind.SUPERVISED }), /capability key/);
});
