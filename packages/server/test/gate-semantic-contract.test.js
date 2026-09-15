const assert = require("node:assert/strict");
const test = require("node:test");

const contract = require("../src/gate/semantic-contract");

test("shared Gate semantic contract freezes lifecycle, event, capacity, and public vocabularies", () => {
  assert.deepEqual(contract.INBOX_LIFECYCLES, [
    "PRE_VOTE", "VOTING", "CLOSED", "UNKNOWN",
  ]);
  assert.deepEqual(contract.NORMALIZED_LIFECYCLES, ["PRE_VOTE", "VOTING", "CLOSED"]);
  assert.equal(contract.PRIVATE_UNKNOWN_LIFECYCLE, "UNKNOWN");
  assert.equal(contract.NOUNS_ISSUANCE_STAGE, "VOTING");
  assert.equal(contract.NOUNS_DAO_CHAIN_ID, "1");
  assert.equal(contract.PRODUCTION_BASE_CHAIN_ID, "8453");
  assert.equal(contract.QUOTE_LIFETIME_MS, 600_000);
  assert.deepEqual(contract.QUOTE_SETTLED_EVENT_FIELDS, [
    "quoteId", "payer", "voter", "attentionAmount", "gavelRecipient", "gavelFeeAmount", "token", "submissionHash",
  ]);
  assert.deepEqual(contract.PUBLIC_RECEIPT_STATES, [
    "payment_required", "pending_settlement", "accepted", "rejected_by_policy", "duplicate", "malformed", "expired",
  ]);
  assert.equal(contract.DEFAULT_PENDING_CAPACITY, 12);
  assert.equal(contract.DEFAULT_SETTLED_CAPACITY, 25);
  assert.equal(contract.SETTLED_CAPACITY_WINDOW_MS, 86_400_000);
});

test("shared lifecycle and expiry validators encode the frozen Nouns contract", () => {
  assert.equal(contract.nounsLifecycle("ACTIVE"), "VOTING");
  for (const state of ["PENDING", "SUCCEEDED", "DEFEATED", "CANCELLED", "EXECUTED", "VETOED", "EXPIRED", "UNKNOWN", 1, "1", null]) {
    assert.equal(contract.nounsLifecycle(state), "CLOSED");
  }
  assert.equal(contract.requireNounsIssuanceLifecycle("ACTIVE", "VOTING"), "VOTING");
  assert.throws(() => contract.requireNounsIssuanceLifecycle("PENDING", "PRE_VOTE"), /canonical ACTIVE.*VOTING/);

  const issuedAt = new Date("2026-01-01T00:00:00.000Z");
  assert.deepEqual(contract.quoteExpiry(issuedAt), new Date("2026-01-01T00:10:00.000Z"));
  assert.doesNotThrow(() => contract.assertExactQuoteExpiry(new Date("2026-01-01T00:10:00.000Z"), issuedAt));
  assert.throws(() => contract.assertExactQuoteExpiry(new Date("2026-01-01T00:10:00.001Z"), issuedAt), /exactly 10 minutes/);
});

test("shared capacity validator keeps pending reservations at or below half of settled capacity", () => {
  assert.deepEqual(contract.normalizeCapacityPolicy({}), {
    pendingReservationCapacity: 12, settledCapacity: 25,
  });
  assert.deepEqual(contract.normalizeCapacityPolicy({ pendingReservationCapacity: 12, settledCapacity: 24 }), {
    pendingReservationCapacity: 12, settledCapacity: 24,
  });
  assert.throws(() => contract.normalizeCapacityPolicy({ pendingReservationCapacity: 13, settledCapacity: 24 }), /maximum.*12/i);
  assert.throws(() => contract.normalizeCapacityPolicy({ pendingReservationCapacity: 13, settledCapacity: 25 }), /at most.*half|maximum.*12/i);
  assert.throws(() => contract.normalizeCapacityPolicy({ pendingReservationCapacity: 25, settledCapacity: 25 }), /at most.*half|maximum.*12/i);
  assert.throws(() => contract.normalizeCapacityPolicy({ pendingLiabilityCap: "1000000" }), /pendingLiabilityCap.*not supported/i);
});

test("shared notification transition validator preserves metadata and bounds retries", () => {
  const pending = { status: "pending", retryCount: 0, providerOpaqueId: "provider-1" };
  assert.deepEqual(contract.notificationTransition(pending, { providerOpaqueId: undefined }, 1), {
    status: "pending", retryCount: 0,
  });
  const failed = contract.notificationTransition(pending, { status: "failed", errorCode: "timeout" }, 1);
  assert.deepEqual(failed, { status: "failed", retryCount: 0, errorCode: "timeout" });
  assert.deepEqual(contract.notificationTransition({ ...pending, ...failed }, { status: "pending" }, 1), {
    status: "pending", retryCount: 1,
  });
  assert.throws(() => contract.notificationTransition({ status: "failed", retryCount: 1 }, { status: "pending" }, 1), /retry limit/);
  assert.throws(() => contract.notificationTransition({ status: "sent", retryCount: 0 }, { status: "pending" }, 1), /terminal/);
  assert.throws(() => contract.notificationTransition(pending, { inboxId: "other" }, 1), /immutable field/);
});

test("shared public projection constructs rather than redacts exact state-specific shapes", () => {
  const updatedAt = new Date("2026-01-01T00:00:00.000Z");
  const acceptedAt = new Date("2026-01-01T00:01:00.000Z");
  for (const [status, state] of [["QUOTED", "payment_required"], ["SETTLEMENT_PENDING", "pending_settlement"], ["EXPIRED", "expired"]]) {
    assert.deepEqual(contract.publicSubmissionProjection({ publicId: "opaque", status, publicStateChangedAt: updatedAt, secret: true }), {
      publicId: "opaque", state, updatedAt,
    });
  }
  assert.deepEqual(contract.publicSubmissionProjection(
    { publicId: "opaque", status: "SETTLED", publicStateChangedAt: updatedAt, secret: true },
    { inboxCreatedAt: acceptedAt, notification: "private" },
  ), { publicId: "opaque", state: "accepted", acceptedAt });
});
