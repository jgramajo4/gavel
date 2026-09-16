const assert = require("node:assert/strict");
const test = require("node:test");
const { createNotificationWorker } = require("../src/gate/notification-worker");
const { createEmailNotifier, createAgentMailSender } = require("../src/gate/notifiers/email");

const SUMMARY = { subject: "Paid pitch ready", text: "Open your private Gate inbox." };
const DESTINATION = "voter@secret.example";

function durableWorker(provider, attempts) {
  return createNotificationWorker({
    store: {
      async claimNotificationAttempts() { return attempts; },
      async completeNotification() { return true; },
      async failNotification() { return true; },
    },
    provider,
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
  assert.equal(provider.durableIdempotency, true);
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
  const worker = durableWorker(provider, [{
    id: "notice-1", claimToken: "1", retryCount: 0, destinationRef: "vault:ciphertext", summary: SUMMARY,
  }]);
  assert.deepEqual(await worker.runOnce(), { claimed: 1, sent: 0, failed: 1 });
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
