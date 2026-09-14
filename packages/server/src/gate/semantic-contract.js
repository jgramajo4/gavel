const PUBLIC_RECEIPT_STATES = Object.freeze([
  "payment_required", "pending_settlement", "accepted", "rejected_by_policy", "duplicate", "malformed", "expired",
]);
const PERSISTED_SUBMISSION_STATES = Object.freeze(["QUOTED", "SETTLEMENT_PENDING", "SETTLED", "EXPIRED"]);
const NORMALIZED_LIFECYCLES = Object.freeze(["PRE_VOTE", "VOTING", "CLOSED"]);
const PRIVATE_UNKNOWN_LIFECYCLE = "UNKNOWN";
const INBOX_LIFECYCLES = Object.freeze([...NORMALIZED_LIFECYCLES, PRIVATE_UNKNOWN_LIFECYCLE]);
const NOUNS_ISSUANCE_STAGE = "VOTING";
const NOUNS_DAO_CHAIN_ID = "1";
const PRODUCTION_BASE_CHAIN_ID = "8453";
const QUOTE_LIFETIME_MS = 10 * 60 * 1000;
const QUOTE_SETTLED_EVENT_FIELDS = Object.freeze([
  "quoteId", "payer", "voter", "attentionAmount", "gavelRecipient", "gavelFeeAmount", "token", "submissionHash",
]);
const DEFAULT_SETTLED_CAPACITY = 25;
const DEFAULT_PENDING_CAPACITY = Math.floor(DEFAULT_SETTLED_CAPACITY * 0.5);
const SETTLED_CAPACITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NOTIFICATION_RETRY_LIMIT = 3;
const NOTIFICATION_STATES = Object.freeze(["pending", "sent", "failed"]);
const NOTIFICATION_PATCH_FIELDS = Object.freeze(["status", "providerOpaqueId", "errorCode"]);

function capacityInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function normalizeCapacityPolicy(policy = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("capacity policy must be an object");
  if (Object.hasOwn(policy, "pendingLiabilityCap")) {
    throw new TypeError("pendingLiabilityCap is not supported; pending capacity is a reservation count");
  }
  const settledCapacity = capacityInteger(policy.settledCapacity ?? DEFAULT_SETTLED_CAPACITY, "settledCapacity");
  const maximumPending = Math.floor(settledCapacity / 2);
  const pendingReservationCapacity = capacityInteger(
    policy.pendingReservationCapacity ?? (policy.settledCapacity == null ? DEFAULT_PENDING_CAPACITY : maximumPending),
    "pendingReservationCapacity",
  );
  if (pendingReservationCapacity > maximumPending) {
    throw new TypeError(`pendingReservationCapacity maximum is ${maximumPending}; it must be at most half of settledCapacity`);
  }
  return { pendingReservationCapacity, settledCapacity };
}

function timestamp(value, name) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return result;
}

function nounsLifecycle(nativeState) {
  return nativeState === "ACTIVE" ? NOUNS_ISSUANCE_STAGE : "CLOSED";
}

function requireNounsIssuanceLifecycle(nativeState, normalizedLifecycle) {
  if (nounsLifecycle(nativeState) !== NOUNS_ISSUANCE_STAGE || normalizedLifecycle !== NOUNS_ISSUANCE_STAGE) {
    throw new Error("Nouns quote issuance requires canonical ACTIVE to VOTING lifecycle mapping");
  }
  return NOUNS_ISSUANCE_STAGE;
}

function quoteExpiry(issuedAt) {
  return new Date(timestamp(issuedAt, "issuance time").getTime() + QUOTE_LIFETIME_MS);
}

function assertExactQuoteExpiry(value, issuedAt, name = "quote expiry") {
  const supplied = timestamp(value, name);
  const expected = quoteExpiry(issuedAt);
  if (supplied.getTime() !== expected.getTime()) throw new Error(`${name} must be exactly 10 minutes after issuance`);
  return expected;
}

function notificationTransition(current, patch = {}, retryLimit = DEFAULT_NOTIFICATION_RETRY_LIMIT) {
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new TypeError("current notification is required");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("notification patch must be an object");
  if (!Number.isInteger(retryLimit) || retryLimit < 0) throw new TypeError("notification retry limit must be a nonnegative integer");
  const fields = Object.keys(patch);
  if (fields.some((field) => !NOTIFICATION_PATCH_FIELDS.includes(field))) {
    throw new TypeError("notification patch contains an immutable field");
  }
  const effectivePatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const nextStatus = effectivePatch.status ?? current.status;
  if (!NOTIFICATION_STATES.includes(nextStatus)) throw new TypeError("invalid notification status");
  if (current.status === "sent" && nextStatus !== "sent") throw new Error("sent notification state is terminal");
  if (current.status === "failed" && !["failed", "pending"].includes(nextStatus)) {
    throw new Error("failed notification must return to pending before delivery");
  }
  let retryCount = current.retryCount ?? 0;
  if (current.status === "failed" && nextStatus === "pending") {
    if (retryCount >= retryLimit) throw new Error("notification retry limit reached");
    retryCount += 1;
  }
  return { ...effectivePatch, status: nextStatus, retryCount };
}

function publicState(status) {
  const value = ({
    QUOTED: "payment_required",
    SETTLEMENT_PENDING: "pending_settlement",
    SETTLED: "accepted",
    EXPIRED: "expired",
  })[status];
  if (!value) throw new TypeError("invalid persisted submission state");
  return value;
}

function publicSubmissionProjection(submission, inbox = null) {
  const state = publicState(submission.status);
  if (state === "accepted") {
    if (!inbox?.inboxCreatedAt) throw new Error("accepted submission requires an inbox timestamp");
    return { publicId: submission.publicId, state, acceptedAt: structuredClone(inbox.inboxCreatedAt) };
  }
  return { publicId: submission.publicId, state, updatedAt: structuredClone(submission.publicStateChangedAt) };
}

function assertExactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new TypeError(`${name} must contain exactly ${expected.join(",")}`);
  }
}

module.exports = {
  DEFAULT_NOTIFICATION_RETRY_LIMIT,
  DEFAULT_PENDING_CAPACITY,
  DEFAULT_SETTLED_CAPACITY,
  INBOX_LIFECYCLES,
  NORMALIZED_LIFECYCLES,
  NOTIFICATION_PATCH_FIELDS,
  NOTIFICATION_STATES,
  PRIVATE_UNKNOWN_LIFECYCLE,
  NOUNS_ISSUANCE_STAGE,
  NOUNS_DAO_CHAIN_ID,
  PERSISTED_SUBMISSION_STATES,
  PRODUCTION_BASE_CHAIN_ID,
  PUBLIC_RECEIPT_STATES,
  QUOTE_LIFETIME_MS,
  QUOTE_SETTLED_EVENT_FIELDS,
  SETTLED_CAPACITY_WINDOW_MS,
  assertExactQuoteExpiry,
  assertExactKeys,
  nounsLifecycle,
  notificationTransition,
  normalizeCapacityPolicy,
  publicState,
  publicSubmissionProjection,
  quoteExpiry,
  requireNounsIssuanceLifecycle,
};
