const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{1,256}$/;
const SEND_TIMEOUT_MS = 10_000;
const AGENTMAIL_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

function opaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function messageIdFrom(body) {
  if (!body || typeof body !== "object") return null;
  return opaqueId(body.message_id) || opaqueId(body.messageId) || opaqueId(body.id);
}

function createAgentMailSender({
  apiUrl = "https://api.agentmail.to",
  apiKey,
  fromInbox,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = SEND_TIMEOUT_MS,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new TypeError("AgentMail apiKey is required");
  if (typeof fromInbox !== "string" || !fromInbox) throw new TypeError("AgentMail fromInbox is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer");
  const root = String(apiUrl).replace(/\/+$/, "");

  async function send({ to, subject, text, idempotencyKey } = {}) {
    if (!IDEMPOTENCY_KEY.test(String(idempotencyKey ?? ""))) {
      throw Object.assign(new Error("invalid idempotency key"), { code: "INVALID_IDEMPOTENCY_KEY" });
    }
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
    headers["Idempotency-Key"] = String(idempotencyKey);
    const response = await fetchImpl(
      `${root}/v0/inboxes/${encodeURIComponent(fromInbox)}/messages/send`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ to: [to], subject, text }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 409) {
      throw Object.assign(new Error("provider idempotency conflict"), { code: "PROVIDER_IDEMPOTENCY_CONFLICT" });
    }
    if (!response.ok) throw Object.assign(new Error("provider error"), { code: "PROVIDER_ERROR" });
    return { messageId: messageIdFrom(body) };
  }

  send.durableIdempotency = true;
  send.idempotencyWindowMs = AGENTMAIL_IDEMPOTENCY_WINDOW_MS;
  send.idempotencySafetyMs = timeoutMs;
  return send;
}

function createEmailNotifier({ send, resolveDestination, logger = { error() {} }, clock = () => new Date() } = {}) {
  if (typeof send !== "function") throw new TypeError("email send function is required");
  if (typeof resolveDestination !== "function") throw new TypeError("destination resolver is required");

  async function provider({ idempotencyKey, dedupeDeadline, destinationRef, summary } = {}) {
    let destination;
    try {
      destination = await resolveDestination(destinationRef);
    } catch {
      logger.error?.("source=email_notifier code=DESTINATION_UNAVAILABLE");
      throw Object.assign(new Error("destination unavailable"), { code: "DESTINATION_UNAVAILABLE" });
    }
    if (typeof destination !== "string" || !destination.includes("@")) {
      throw Object.assign(new Error("destination unavailable"), { code: "DESTINATION_INVALID" });
    }
    if (dedupeDeadline !== undefined && Number.isSafeInteger(send.idempotencySafetyMs)) {
      const beforeSend = new Date(clock());
      const deadline = new Date(dedupeDeadline);
      if (Number.isNaN(beforeSend.valueOf()) || Number.isNaN(deadline.valueOf())
          || beforeSend.valueOf() + send.idempotencySafetyMs >= deadline.valueOf()) {
        throw Object.assign(new Error("provider idempotency window expired"), { code: "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED" });
      }
    }
    try {
      const result = await send({
        to: destination,
        subject: summary.subject,
        text: summary.text,
        idempotencyKey,
      });
      return { providerOpaqueId: opaqueId(result?.messageId ?? result?.providerOpaqueId) };
    } catch (error) {
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : "PROVIDER_ERROR";
      logger.error?.(`source=email_notifier code=${code}`);
      throw Object.assign(new Error("provider error"), {
        code,
      });
    }
  }

  provider.durableIdempotency = send.durableIdempotency === true;
  provider.idempotencyWindowMs = send.idempotencyWindowMs;
  provider.idempotencySafetyMs = send.idempotencySafetyMs;
  return provider;
}

module.exports = { createEmailNotifier, createAgentMailSender };
