const assert = require("node:assert/strict");
const test = require("node:test");

function defineGateStoreConformance(name, createHarness) {
  test(`${name} conformance: DAO policy chain is independent from the Base quote deployment`, async () => {
    const harness = await createHarness("chains");
    assert.equal((await harness.store.getPolicy("profile-1", "nouns")).chainId, "1");
    assert.equal(harness.issued.quote.baseChainId, "8453");
    assert.equal(harness.issued.quote.expiresAt.getTime() - harness.issuedAt.getTime(), 600_000);
  });

  test(`${name} conformance: pending hints reverse and duplicate resume reports exact public state`, async () => {
    const harness = await createHarness("pending");
    harness.setNow(new Date("2026-01-01T00:01:00.000Z"));
    assert.equal(await harness.store.markSettlementPending(harness.publicId), true);
    assert.equal((await harness.resume()).state, "pending_settlement");
    harness.setNow(new Date("2026-01-01T00:02:00.000Z"));
    assert.equal(await harness.store.markSettlementPending(harness.publicId, false), true);
    assert.equal((await harness.resume()).state, "payment_required");
    harness.setNow(new Date("2026-01-01T00:10:00.000Z"));
    await harness.store.markExpired();
    assert.equal((await harness.resume()).state, "expired");
  });

  test(`${name} conformance: inbox lifecycle uses normalized values plus private UNKNOWN only`, async () => {
    const closed = await createHarness("closed");
    await closed.settle({ currentLifecycle: "CLOSED", lifecycleChanged: true });
    assert.equal((await closed.store.getSubmission(closed.publicId)).state, "accepted");
    assert.equal((await closed.resume()).state, "accepted");

    const unavailable = await createHarness("unknown");
    await unavailable.settle({
      currentLifecycle: "UNKNOWN", lifecycleChanged: false, currentLifecycleUnavailable: true,
      privateUnavailabilityReason: "timeout",
    });
    assert.equal((await unavailable.store.getSubmission(unavailable.publicId)).state, "accepted");

    const leaked = await createHarness("native-leak");
    await assert.rejects(leaked.settle({ currentLifecycle: "SUCCEEDED", lifecycleChanged: true }), /invalid inbox lifecycle/);
  });

  test(`${name} conformance: notification retries are bounded and metadata-only patches preserve state`, async () => {
    const harness = await createHarness("notification", { notificationRetryLimit: 1 });
    await harness.settle();
    const first = await harness.store.updateNotification(harness.notificationId, { providerOpaqueId: "provider-1" });
    assert.equal(first.status, "pending");
    assert.equal(first.retryCount, 0);
    const omitted = await harness.store.updateNotification(harness.notificationId, { providerOpaqueId: undefined });
    assert.equal(omitted.providerOpaqueId, "provider-1");
    await harness.store.updateNotification(harness.notificationId, { status: "failed", errorCode: "timeout" });
    const metadata = await harness.store.updateNotification(harness.notificationId, { errorCode: "still-timeout" });
    assert.equal(metadata.status, "failed");
    assert.equal(metadata.retryCount, 0);
    assert.equal((await harness.store.updateNotification(harness.notificationId, { status: "pending" })).retryCount, 1);
    await harness.store.updateNotification(harness.notificationId, { status: "failed" });
    await assert.rejects(harness.store.updateNotification(harness.notificationId, { status: "pending" }), /retry limit/);
  });
}

module.exports = { defineGateStoreConformance };
