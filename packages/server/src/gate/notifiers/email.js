const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{1,256}$/;
const SEND_TIMEOUT_MS = 10_000;
const AGENTMAIL_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const DELIVERY_KEY = /^([A-Za-z0-9_-]{1,32}):([A-Za-z0-9_-]{43})$/;

function parseDeliveryKey(encodedKey) {
  const match = DELIVERY_KEY.exec(String(encodedKey ?? ""));
  if (!match) throw new TypeError("GAVEL_GATE_ENCRYPTION_KEY must be key-id:base64url-encoded-32-byte-key");
  const key = Buffer.from(match[2], "base64url");
  if (key.length !== 32 || key.toString("base64url") !== match[2]) {
    throw new TypeError("GAVEL_GATE_ENCRYPTION_KEY must be key-id:base64url-encoded-32-byte-key");
  }
  return { keyId: match[1], key };
}

function createDeliverySettingsCipher({ encodedKey, randomBytesImpl = randomBytes } = {}) {
  const { keyId, key } = parseDeliveryKey(encodedKey);
  function profileAad(profileId) {
    if (typeof profileId !== "string" || profileId.length === 0 || profileId.length > 256) {
      throw new TypeError("delivery profile identity is required");
    }
    return Buffer.from(`gavel-gate:delivery-settings:gg1:${keyId}:${profileId}`, "utf8");
  }
  function encryptDestination(profileId, destination) {
    const aad = profileAad(profileId);
    if (typeof destination !== "string" || destination.length === 0) throw new TypeError("delivery destination is required");
    const iv = randomBytesImpl(12);
    if (!Buffer.isBuffer(iv) || iv.length !== 12) throw new TypeError("delivery encryption nonce must be 12 bytes");
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(destination, "utf8"), cipher.final()]);
    return ["gg1", keyId, iv.toString("base64url"), ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url")].join(".");
  }
  function resolveDestination(profileId, envelope) {
    try {
      const aad = profileAad(profileId);
      const parts = String(envelope ?? "").split(".");
      if (parts.length !== 5 || parts[0] !== "gg1" || parts[1] !== keyId) throw new Error("invalid envelope");
      const decode = (value) => {
        if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid envelope");
        const decoded = Buffer.from(value, "base64url");
        if (decoded.toString("base64url") !== value) throw new Error("invalid envelope");
        return decoded;
      };
      const iv = decode(parts[2]);
      const ciphertext = decode(parts[3]);
      const tag = decode(parts[4]);
      if (iv.length !== 12 || ciphertext.length === 0 || tag.length !== 16) throw new Error("invalid envelope");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw Object.assign(new Error("destination unavailable"), { code: "DESTINATION_UNAVAILABLE" });
    }
  }
  return Object.freeze({ keyId, encryptDestination, resolveDestination });
}

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

  function assertSendWindow(dedupeDeadline) {
    if (dedupeDeadline === undefined || !Number.isSafeInteger(send.idempotencySafetyMs)) return;
    const now = new Date(clock());
    const deadline = new Date(dedupeDeadline);
    if (Number.isNaN(now.valueOf()) || Number.isNaN(deadline.valueOf())
        || now.valueOf() + send.idempotencySafetyMs >= deadline.valueOf()) {
      throw Object.assign(new Error("provider idempotency window expired"), { code: "PROVIDER_IDEMPOTENCY_WINDOW_EXPIRED" });
    }
  }

  async function provider({ idempotencyKey, dedupeDeadline, profileId, destinationRef, summary } = {}) {
    assertSendWindow(dedupeDeadline);
    let destination;
    try {
      destination = await resolveDestination(destinationRef, profileId);
    } catch {
      logger.error?.("source=email_notifier code=DESTINATION_UNAVAILABLE");
      throw Object.assign(new Error("destination unavailable"), { code: "DESTINATION_UNAVAILABLE" });
    }
    if (typeof destination !== "string" || !destination.includes("@")) {
      throw Object.assign(new Error("destination unavailable"), { code: "DESTINATION_INVALID" });
    }
    assertSendWindow(dedupeDeadline);
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

async function probeAgentMail({
  apiUrl = "https://api.agentmail.to",
  apiKey,
  fromInbox,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 5_000,
} = {}) {
  if (typeof apiKey !== "string" || apiKey === "") throw new TypeError("AgentMail apiKey is required");
  if (typeof fromInbox !== "string" || fromInbox === "") throw new TypeError("AgentMail fromInbox is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("probe timeoutMs must be between 1 and 30000");
  }
  const root = String(apiUrl).replace(/\/+$/, "");
  try {
    const response = await fetchImpl(`${root}/v0/inboxes/${encodeURIComponent(fromInbox)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const statusClass = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
      ? `${Math.floor(response.status / 100)}xx` : "invalid";
    return Object.freeze({ result: response?.ok === true ? "pass" : "fail", statusClass });
  } catch {
    return Object.freeze({ result: "fail", statusClass: "network" });
  }
}

module.exports = { createEmailNotifier, createAgentMailSender, createDeliverySettingsCipher, probeAgentMail };
