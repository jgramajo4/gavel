const assert = require("node:assert/strict");
const test = require("node:test");
const { createNotificationWorker } = require("../src/gate/notification-worker");
const { createEmailNotifier, createAgentMailSender } = require("../src/gate/notifiers/email");

const SUMMARY = { subject: "Paid pitch ready", text: "Open your private Gate inbox." };
const DESTINATION = "voter@secret.example";

function durableWorker(provider, attempts) {
  provider.idempotencyWindowMs ??= 24 * 60 * 60 * 1000;
  provider.idempotencySafetyMs ??= 10_000;
  return createNotificationWorker({
    store: {
      async claimNotificationAttempts() { return attempts.map((attempt) => ({
        firstAttemptAt: new Date("2026-01-01T00:00:00Z"),
        dedupeDeadline: new Date("2026-01-02T00:00:00Z"),
        ...attempt,
      })); },
      async completeNotification() { return true; },
      async failNotification() { return true; },
      async reconcileNotification() { return true; },
    },
    provider,
    operatorAlert: async () => {},
    clock: () => new Date("2026-01-01T00:00:00Z"),
  });
}

test("trusted summary is delivered and destination never appears in logs or errors", async () => {
  const logs = [];
  const sent = [];
  const provider = createEmailNotifier({
    resolveDestination: async () => DESTINATION,
    send: async (value) => { sent.push(value); return { messageId: "msg-1" }; },
    logger: { error(message) { logs.push(String(message)); } },
  });
  assert.equal(provider.durableIdempotency, false);
  const result = await provider({
    idempotencyKey: "notice-1", destinationRef: "vault:ciphertext", summary: SUMMARY,
  });
  assert.deepEqual(sent[0], { to: DESTINATION, subject: SUMMARY.subject, text: SUMMARY.text, idempotencyKey: "notice-1" });
  assert.deepEqual(result, { providerOpaqueId: "msg-1" });
  assert.equal(JSON.stringify(logs).includes(DESTINATION), false);
  assert.equal(JSON.stringify(result).includes(DESTINATION), false);
});

test("provider throw stays private and retryable without leaking destination", async () => {
  const logs = [];
  const provider = createEmailNotifier({
    resolveDestination: async () => DESTINATION,
    send: async () => { throw new Error(`AgentMail 500 for ${DESTINATION}`); },
    logger: { error(message) { logs.push(String(message)); } },
  });
  await assert.rejects(provider({
    idempotencyKey: "notice-1", destinationRef: "vault:ciphertext", summary: SUMMARY,
  }), (error) => {
    assert.equal(String(error.message).includes(DESTINATION), false);
    assert.equal(error.code, "PROVIDER_ERROR");
    return true;
  });
  assert.equal(JSON.stringify(logs).includes(DESTINATION), false);
  const send = Object.assign(async () => { throw new Error("down"); }, { durableIdempotency: true });
  const retryable = createEmailNotifier({ resolveDestination: async () => DESTINATION, send });
  const worker = durableWorker(retryable, [{
    id: "notice-1", claimToken: "1", retryCount: 0, destinationRef: "vault:ciphertext", summary: SUMMARY,
  }]);
  assert.deepEqual(await worker.runOnce(), { claimed: 1, sent: 0, failed: 1 });
});

test("upstream exception text never reaches notifier logs", async () => {
  const cases = [
    {
      resolveDestination: async () => { throw new Error("decrypt failed ref=vault:ciphertext-secret"); },
      send: async () => ({ messageId: "unused" }),
      expectedLog: "source=email_notifier code=DESTINATION_UNAVAILABLE",
    },
    {
      resolveDestination: async () => DESTINATION,
      send: async () => { throw new Error("send failed key=notice-secret body=body-secret"); },
      expectedLog: "source=email_notifier code=PROVIDER_ERROR",
    },
  ];
  for (const sample of cases) {
    const logs = [];
    const provider = createEmailNotifier({
      resolveDestination: sample.resolveDestination,
      send: sample.send,
      logger: { error(message) { logs.push(String(message)); } },
    });
    await assert.rejects(provider({
      idempotencyKey: "notice-secret",
      destinationRef: "vault:ciphertext-secret",
      summary: { subject: "subject-secret", text: "body-secret" },
    }));
    assert.deepEqual(logs, [sample.expectedLog]);
    assert.equal(JSON.stringify(logs).includes("secret"), false);
  }
});

test("idempotency key is stable across retries and does not double-send when the provider confirms", async () => {
  const sent = [];
  const messages = new Map();
  const send = async ({ idempotencyKey, to, subject, text }) => {
    sent.push(idempotencyKey);
    if (messages.has(idempotencyKey)) return messages.get(idempotencyKey);
    const created = { messageId: `msg-${messages.size + 1}` };
    messages.set(idempotencyKey, created);
    return created;
  };
  const provider = createEmailNotifier({
    resolveDestination: async () => DESTINATION,
    send,
  });
  assert.deepEqual(await provider({ idempotencyKey: "notice-1", destinationRef: "ref", summary: SUMMARY }),
    { providerOpaqueId: "msg-1" });
  assert.deepEqual(await provider({ idempotencyKey: "notice-1", destinationRef: "ref", summary: SUMMARY }),
    { providerOpaqueId: "msg-1" });
  assert.deepEqual(sent, ["notice-1", "notice-1"]);
  assert.equal(messages.size, 1);
});

test("raw advocate URLs are never fetched and notifier receives no signer or wallet capability", async () => {
  const fetches = [];
  const fetchImpl = async (url) => { fetches.push(url); throw new Error("network"); };
  const provider = createEmailNotifier({
    resolveDestination: async () => DESTINATION,
    send: createAgentMailSender({
      apiUrl: "https://api.agentmail.to",
      apiKey: "am_test",
      fromInbox: "agent@gavel.example",
      fetchImpl,
    }),
  });
  await assert.rejects(provider({
    idempotencyKey: "notice-1", destinationRef: "ref",
    summary: { subject: "s", text: "see https://advocate.example/evidence" },
  }));
  assert.equal(fetches.some((url) => String(url).includes("advocate.example")), false);
  assert.equal("sign" in provider, false);
  assert.equal("wallet" in provider, false);
  assert.equal(provider.durableIdempotency, true);
});

test("durableIdempotency is inherited from the sender, never hardcoded on the wrapper", () => {
  const dummy = createEmailNotifier({
    resolveDestination: async () => DESTINATION,
    send: async () => ({ messageId: "x" }),
  });
  assert.equal(dummy.durableIdempotency, false);
  assert.throws(() => durableWorker(dummy, []), /durable.*idempotencyKey/i);
  const promised = Object.assign(async () => ({ messageId: "x" }), { durableIdempotency: true });
  const wrapped = createEmailNotifier({
    resolveDestination: async () => DESTINATION, send: promised,
  });
  assert.equal(wrapped.durableIdempotency, true);
});

test("overlong provider ids are dropped instead of turning a successful send into a retry", async () => {
  const send = Object.assign(async () => ({ messageId: "m".repeat(403) }), { durableIdempotency: true });
  const provider = createEmailNotifier({
    resolveDestination: async () => DESTINATION, send,
  });
  const result = await provider({ idempotencyKey: "notice-1", destinationRef: "ref", summary: SUMMARY });
  assert.deepEqual(result, { providerOpaqueId: null });
  const worker = durableWorker(provider, [{
    id: "notice-1", claimToken: "1", retryCount: 0, destinationRef: "ref", summary: SUMMARY,
  }]);
  assert.deepEqual(await worker.runOnce(), { claimed: 1, sent: 1, failed: 0 });
});

test("AgentMail 409 is a private idempotency conflict, never a completed send", async () => {
  const send = createAgentMailSender({
    apiUrl: "https://api.agentmail.to", apiKey: "am_test", fromInbox: "agent@gavel.example",
    fetchImpl: async () => ({
      ok: false, status: 409, async json() { return { message_id: "am_existing" }; },
    }),
  });
  assert.equal(send.durableIdempotency, true);
  await assert.rejects(
    send({ to: DESTINATION, subject: "s", text: "t", idempotencyKey: "notice-1" }),
    (error) => {
      assert.equal(error.code, "PROVIDER_IDEMPOTENCY_CONFLICT");
      assert.equal(String(error.message).includes("notice-1"), false);
      assert.equal(String(error.message).includes(DESTINATION), false);
      assert.equal(String(error.message).includes("am_existing"), false);
      return true;
    },
  );
});

test("AgentMail rejects missing and invalid idempotency keys before zero fetches", async () => {
  let fetches = 0;
  const send = createAgentMailSender({
    apiUrl: "https://api.agentmail.to", apiKey: ["am", "test"].join("_"), fromInbox: "agent@gavel.example",
    fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
  });
  for (const idempotencyKey of [undefined, "", "spaces are invalid", "x".repeat(257)]) {
    await assert.rejects(send({ to: DESTINATION, subject: "s", text: "t", idempotencyKey }),
      (error) => error.code === "INVALID_IDEMPOTENCY_KEY"
        && !String(error.message).includes(DESTINATION)
        && (!idempotencyKey || !String(error.message).includes(String(idempotencyKey))));
  }
  assert.equal(fetches, 0);
});

test("AgentMail send times out and rejects redirects", async () => {
  let captured;
  const send = createAgentMailSender({
    apiUrl: "https://api.agentmail.to", apiKey: "am_test", fromInbox: "agent@gavel.example",
    fetchImpl: async (_url, options) => { captured = options; return { ok: true, status: 200, async json() { return { message_id: "am_1" }; } }; },
  });
  await send({ to: DESTINATION, subject: "s", text: "t", idempotencyKey: "notice-1" });
  assert.equal(captured.redirect, "error");
  assert.equal(typeof captured.signal?.aborted, "boolean");
});

test("AgentMail sender stamps Idempotency-Key and returns only an opaque id", async () => {
  let captured;
  const send = createAgentMailSender({
    apiUrl: "https://api.agentmail.to",
    apiKey: "am_test",
    fromInbox: "agent@gavel.example",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, async json() { return { message_id: "am_1", to: DESTINATION }; } };
    },
  });
  const result = await send({ to: DESTINATION, subject: "s", text: "t", idempotencyKey: "notice-1" });
  assert.equal(captured.options.headers["Idempotency-Key"], "notice-1");
  assert.match(captured.url, /\/v0\/inboxes\/agent%40gavel.example\/messages\/send$/);
  assert.deepEqual(result, { messageId: "am_1" });
  assert.equal(JSON.stringify(result).includes(DESTINATION), false);
  assert.equal(send.idempotencyWindowMs, 24 * 60 * 60 * 1000);
  assert.equal(send.idempotencySafetyMs, 10_000);
});

test("slow destination resolution cannot begin an AgentMail fetch beyond the dedupe safety boundary", async () => {
  let now = new Date("2026-01-01T00:00:00Z");
  let fetches = 0;
  const provider = createEmailNotifier({
    clock: () => now,
    resolveDestination: async () => {
      now = new Date("2026-01-01T00:00:12Z");
      return DESTINATION;
    },
    send: createAgentMailSender({
      apiKey: ["agent", "mail", "test"].join("-"), fromInbox: "agent@gavel.example", timeoutMs: 10_000,
      fetchImpl: async () => { fetches += 1; throw new Error("must not fetch"); },
    }),
  });
  await assert.rejects(provider({ idempotencyKey: "notice-1", destinationRef: "ref", summary: SUMMARY,
    dedupeDeadline: new Date("2026-01-01T00:00:20Z") }),
  (error) => error.code === "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED");
  assert.equal(fetches, 0);
});

test("notification failure does not require a public accepted-state mutation", async () => {
  const publicState = { accepted: true };
  const provider = createEmailNotifier({
    resolveDestination: async () => DESTINATION,
    send: async () => { throw new Error("down"); },
  });
  await assert.rejects(provider({ idempotencyKey: "n", destinationRef: "ref", summary: SUMMARY }));
  assert.equal(publicState.accepted, true);
});
