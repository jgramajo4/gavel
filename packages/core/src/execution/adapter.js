/**
 * The execution adapter contract.
 *
 * Three phases, so provider work has somewhere to live other than inside a
 * single `submit()`:
 *
 *   prepare(validatedIntent)   build the provider payload. No network writes.
 *                              This is where a Safe nonce is read and a
 *                              safeTxHash derived, or an autonomous policy is
 *                              evaluated -- all of it inspectable before
 *                              anything is submitted.
 *   submit(preparation)        hand it to the provider. The only phase that
 *                              can cause an external effect.
 *   status(submission)         ask the provider where it got to.
 *
 * Splitting prepare from submit is what makes a dry run possible and what lets
 * the engine record a PREPARED state that is distinguishable from a submitted
 * one -- which matters when a submission times out and nobody knows whether it
 * landed.
 */

const { getExecutionMode } = require("./modes");
const { deepFreeze } = require("../intent/canonical");
const { isValidatedExecutionIntent } = require("../intent/validated");

const REQUIRED_METHODS = Object.freeze(["prepare", "submit", "status"]);

function assertExecutionAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("An execution adapter is required");
  const mode = getExecutionMode(adapter.mode);
  if (!mode.implemented) {
    throw new Error(`Execution mode ${mode.mode} is declared but not implemented`);
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`Execution adapter ${mode.mode} is missing ${method}()`);
    }
  }
  return adapter;
}

/**
 * The guard every adapter's `prepare()` calls first.
 *
 * This is the one place the governance invariant is enforced structurally: an
 * execution adapter has no way to act on anything but a ValidatedExecutionIntent,
 * because this throws on everything else and there is no exported conversion
 * that produces one.
 */
function assertPreparable(adapter, validated) {
  const mode = getExecutionMode(adapter.mode);
  if (!isValidatedExecutionIntent(validated)) {
    throw new TypeError(
      `${mode.mode} accepts only a ValidatedExecutionIntent; ` +
        "arbitrary transaction input cannot reach an execution adapter",
    );
  }
  return validated;
}

/**
 * What `prepare()` returns.
 *
 * `payload` is provider-shaped and deliberately opaque to the engine. The
 * validated intent travels with it so `submit()` can re-check that nothing
 * drifted between the phases.
 *
 * The payload is **deeply** frozen. A shallow `Object.freeze({ ...payload })`
 * left nested objects writable, so `preparation.payload.request.to = attacker`
 * between `prepare()` and `submit()` was an arbitrary-execution path that
 * carried a genuine intent hash. Deep freezing closes it -- and, because a
 * caller can always construct a look-alike preparation object, every adapter's
 * `submit()` additionally derives the onchain call from `validated.intent`
 * rather than reading it back out of the payload.
 */
function executionPreparation(adapter, validated, payload, extra = {}) {
  const mode = getExecutionMode(adapter.mode).mode;
  return Object.freeze({
    mode,
    intentHash: validated.intentHash,
    validated,
    payload: deepFreeze(structuredClone(payload)),
    ...extra,
  });
}

/**
 * The guard every adapter's `submit()` calls first.
 *
 * A preparation from another mode, or one whose intent hash no longer matches
 * the intent it carries, is refused. That closes the gap where a caller
 * prepares one action and submits another.
 */
function assertSubmittable(adapter, preparation) {
  const mode = getExecutionMode(adapter.mode).mode;
  if (!preparation || typeof preparation !== "object") {
    throw new TypeError(`${mode} requires a preparation produced by prepare()`);
  }
  if (preparation.mode !== mode) {
    throw new Error(`Preparation was built for ${preparation.mode}, not ${mode}`);
  }
  const validated = assertPreparable(adapter, preparation.validated);
  if (preparation.intentHash !== validated.intentHash) {
    throw new Error("Preparation intent hash does not match the validated intent it carries");
  }
  return preparation;
}

module.exports = {
  REQUIRED_METHODS,
  assertExecutionAdapter,
  assertPreparable,
  assertSubmittable,
  executionPreparation,
};
