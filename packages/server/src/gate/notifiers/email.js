const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function redact(value) {
  return String(value ?? "provider error").replace(EMAIL, "[redacted]").replace(/\s+/g, " ").slice(0, 180);
}

function createAgentMailSender({
  apiUrl = "https://api.agentmail.to",
  apiKey,
  fromInbox,
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new TypeError("AgentMail apiKey is required");
  if (typeof fromInbox !== "string" || !fromInbox) throw new TypeError("AgentMail fromInbox is required");
  const root = String(apiUrl).replace(/\/+$/, "");

  return async function send({ to, subject, text, idempotencyKey } = {}) {
    const response = await fetchImpl(
      `${root}/v0/inboxes/${encodeURIComponent(fromInbox)}/messages/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "Idempotency-Key": String(idempotencyKey || ""),
        },
        body: JSON.stringify({ to: [to], subject, text }),
      },
    );
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok && response.status !== 200) {
      throw Object.assign(new Error("provider error"), { code: "PROVIDER_ERROR" });
    }
    const messageId = typeof body?.message_id === "string" ? body.message_id
      : typeof body?.messageId === "string" ? body.messageId
        : typeof body?.id === "string" ? body.id : null;
    return { messageId };
  };
}

function createEmailNotifier({ send, resolveDestination, logger = { error() {} } } = {}) {
  if (typeof send !== "function") throw new TypeError("email send function is required");
  if (typeof resolveDestination !== "function") throw new TypeError("destination resolver is required");

  async function provider({ idempotencyKey, destinationRef, summary } = {}) {
    let destination;
    try {
      destination = await resolveDestination(destinationRef);
    } catch (error) {
      logger.error?.(redact(error?.message));
      throw Object.assign(new Error("destination unavailable"), { code: "DESTINATION_UNAVAILABLE" });
    }
    if (typeof destination !== "string" || !destination.includes("@")) {
      throw Object.assign(new Error("destination unavailable"), { code: "DESTINATION_INVALID" });
    }
    try {
      const result = await send({
        to: destination,
        subject: summary.subject,
        text: summary.text,
        idempotencyKey,
      });
      const providerOpaqueId = result?.messageId ?? result?.providerOpaqueId ?? null;
      return { providerOpaqueId };
    } catch (error) {
      logger.error?.(redact(error?.message));
      throw Object.assign(new Error("provider error"), {
        code: typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "PROVIDER_ERROR",
      });
    }
  }

  provider.durableIdempotency = true;
  return provider;
}

module.exports = { createEmailNotifier, createAgentMailSender };
