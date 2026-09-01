const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyOperationalFailure, safeOperationMessage } = require("../src/core/operations/failure");

test("classifies retryable infrastructure separately from stale and user failures", () => {
  assert.deepEqual(classifyOperationalFailure("history", new Error("fetch timeout")).category, "RETRYABLE_INFRASTRUCTURE");
  assert.deepEqual(classifyOperationalFailure("prepare-vote", new Error("proposal description stale")).category, "STALE_DATA");
  assert.deepEqual(classifyOperationalFailure("predict", new Error("profile requires exactly one path")).category, "USER_CORRECTION_REQUIRED");
});

test("redacts likely secrets and long transaction material from operational messages", () => {
  const message = safeOperationMessage(new Error(`RPC failed ?api_key=secret 0x${"a".repeat(128)}`));
  assert.doesNotMatch(message, /secret/);
  assert.doesNotMatch(message, /a{64}/);
  assert.match(message, /REDACTED/);
});
