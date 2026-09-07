const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyOperationalFailure, safeOperationMessage } = require("../packages/core/src/operations/failure");

test("classifies retryable infrastructure separately from stale and user failures", () => {
  assert.deepEqual(classifyOperationalFailure("history", new Error("fetch timeout")).category, "RETRYABLE_INFRASTRUCTURE");
  assert.deepEqual(classifyOperationalFailure("prepare-vote", new Error("proposal description stale")).category, "STALE_DATA");
  assert.deepEqual(classifyOperationalFailure("predict", new Error("profile requires exactly one path")).category, "USER_CORRECTION_REQUIRED");
});

test("classifies every governance index freshness refusal as stale data", () => {
  for (const message of [
    "Governance index has no sync checkpoint for ens.",
    "Governance index sync for ens is failing (source ens-governor).",
    "Governance index checkpoint for ens has no usable updatedAt.",
  ]) {
    // The client's own error carries this code; see the governance index suite.
    const error = new Error(message);
    error.code = "GAVEL_INDEX_STALE";
    const failure = classifyOperationalFailure("history", error);
    assert.equal(failure.category, "STALE_DATA", message);
    assert.equal(failure.retryable, false);
  }
});

test("redacts likely secrets and long transaction material from operational messages", () => {
  const message = safeOperationMessage(new Error(`RPC failed ?api_key=secret 0x${"a".repeat(128)}`));
  assert.doesNotMatch(message, /secret/);
  assert.doesNotMatch(message, /a{64}/);
  assert.match(message, /REDACTED/);
});
