const assert = require("node:assert/strict");
const test = require("node:test");
const { createNotificationWorker } = require("../src/gate/notification-worker");

function durableProvider(provider) {
  return Object.assign(provider, { durableIdempotency: true });
}

function harness({ provider = async () => ({ providerOpaqueId: "opaque-1" }), attempts } = {}) {
  const calls = [];
  const jobs = attempts ?? [{ id: "notice-1", claimToken: "1", status: "pending", retryCount: 0, destinationRef: "private:1",
    summary: { subject: "Paid pitch ready", text: "Open your private Gate inbox." } }];
  const store = {
    async claimNotificationAttempts(value) { calls.push(["claim", value]); return jobs; },
    async completeNotification(value) { calls.push(["complete", value]); },
    async failNotification(value) { calls.push(["fail", value]); },
  };
  return { calls, worker: createNotificationWorker({ store, provider: durableProvider(provider), clock: () => new Date("2026-01-01T00:00:00Z"),
    baseDelayMs: 1000, maxDelayMs: 4000, batchSize: 5 }) };
}

test("notification providers must promise durable deduplication by idempotencyKey", () => {
  const store = { claimNotificationAttempts() {}, completeNotification() {}, failNotification() {} };
  assert.throws(() => createNotificationWorker({ store, provider: async () => ({}) }), /durable.*idempotencyKey/i);
});

test("21. notifier receives only trusted pre-rendered summary and an opaque private destination reference", async () => {
  let received;
  const h = harness({ provider: async (value) => { received = value; return { providerOpaqueId: "opaque" }; } });
  await h.worker.runOnce();
  assert.deepEqual(received, { idempotencyKey: "notice-1", destinationRef: "private:1", summary: { subject: "Paid pitch ready", text: "Open your private Gate inbox." } });
  assert.deepEqual(Object.keys(received).sort(), ["destinationRef", "idempotencyKey", "summary"]);
  assert.deepEqual(Object.keys(received.summary).sort(), ["subject", "text"]);
  assert.deepEqual(h.calls.find(([name]) => name === "claim")[1], { limit: 5, leaseMs: 300_000 });
  for (const forbidden of ["signer", "wallet", "shell", "fetch", "url", "agent", "authorization"]) {
    assert.equal(JSON.stringify(received).toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("22. provider success marks only the private notification attempt sent", async () => {
  const h = harness();
  const result = await h.worker.runOnce();
  assert.deepEqual(result, { claimed: 1, sent: 1, failed: 0 });
  assert.deepEqual(h.calls.find(([name]) => name === "complete")[1], { id: "notice-1", claimToken: "1", providerOpaqueId: "opaque-1" });
});

test("23. provider throw preserves acceptance and schedules bounded exponential backoff", async () => {
  const h = harness({ provider: async () => { throw Object.assign(new Error("secret provider detail"), { code: "TEMP" }); } });
  assert.deepEqual(await h.worker.runOnce(), { claimed: 1, sent: 0, failed: 1 });
  const failure = h.calls.find(([name]) => name === "fail")[1];
  assert.deepEqual(failure, { id: "notice-1", claimToken: "1", errorCode: "TEMP", nextAttemptAt: new Date("2026-01-01T00:00:01Z") });
  assert.equal(JSON.stringify(failure).includes("secret provider detail"), false);
});

test("24. retry delay is capped and invalid provider capabilities or job shapes fail closed", async () => {
  const capped = harness({ provider: async () => { throw new Error("no"); }, attempts: [{ id: "n", claimToken: "7", status: "pending", retryCount: 20,
    destinationRef: "private:1", summary: { subject: "s", text: "t" } }] });
  await capped.worker.runOnce();
  assert.equal(capped.calls.find(([name]) => name === "fail")[1].nextAttemptAt.toISOString(), "2026-01-01T00:00:04.000Z");
  assert.throws(() => createNotificationWorker({ store: {}, provider: { fetch() {} } }), /provider.*function/i);
  const invalid = harness({ attempts: [{ id: "n", claimToken: "1", destinationRef: "https://example.com", summary: { subject: "s", text: "t" } }] });
  assert.deepEqual(await invalid.worker.runOnce(), { claimed: 1, sent: 0, failed: 1 });
});

test("25. public serializer is never consulted or mutated by notification processing", async () => {
  const h = harness();
  h.worker.publicReader = new Proxy({}, { get() { throw new Error("public reader must remain outside notification worker"); } });
  await h.worker.runOnce();
  assert.equal(h.calls.some(([name]) => name === "complete"), true);
});

test("26. a poison notification is isolated and does not abort the rest of the claimed batch", async () => {
  const h = harness({ attempts: [
    { id: "poison", claimToken: "1", retryCount: 0, destinationRef: "https://attacker.invalid", summary: { subject: "s", text: "t" } },
    { id: "healthy", claimToken: "2", retryCount: 0, destinationRef: "private:2", summary: { subject: "s", text: "t" } },
  ] });
  assert.deepEqual(await h.worker.runOnce(), { claimed: 2, sent: 1, failed: 1 });
  assert.deepEqual(h.calls.find(([name, value]) => name === "fail" && value.id === "poison")[1], {
    id: "poison", claimToken: "1", errorCode: "INVALID_JOB", nextAttemptAt: new Date("2026-01-01T00:00:01Z"),
  });
  assert.equal(h.calls.some(([name, value]) => name === "complete" && value.id === "healthy"), true);
});

test("27. lost claim ownership is not reported as a completed delivery", async () => {
  const worker = createNotificationWorker({
    store: {
      async claimNotificationAttempts() { return [{ id: "notice-1", claimToken: "stale", retryCount: 0,
        destinationRef: "private:1", summary: { subject: "s", text: "t" } }]; },
      async completeNotification() { return false; },
      async failNotification() { return false; },
    },
    provider: durableProvider(async () => ({ providerOpaqueId: "provider-1" })),
    clock: () => new Date("2026-01-01T00:00:00Z"),
  });
  assert.deepEqual(await worker.runOnce(), { claimed: 1, sent: 0, failed: 0 });
});

test("28. a failure-recording error is isolated from later jobs", async () => {
  const completed = [];
  const worker = createNotificationWorker({
    store: {
      async claimNotificationAttempts() { return [
        { id: "broken", claimToken: "1", retryCount: 0, destinationRef: "private:1", summary: { subject: "s", text: "t" } },
        { id: "healthy", claimToken: "2", retryCount: 0, destinationRef: "private:2", summary: { subject: "s", text: "t" } },
      ]; },
      async completeNotification(value) { completed.push(value.id); return true; },
      async failNotification() { throw new Error("database temporarily unavailable"); },
    },
    provider: durableProvider(async ({ idempotencyKey }) => {
      if (idempotencyKey === "broken") throw new Error("provider failed");
      return { providerOpaqueId: "provider-1" };
    }),
    clock: () => new Date("2026-01-01T00:00:00Z"),
  });
  assert.deepEqual(await worker.runOnce(), { claimed: 2, sent: 1, failed: 0 });
  assert.deepEqual(completed, ["healthy"]);
});
