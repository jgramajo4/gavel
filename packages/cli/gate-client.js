const INBOX_FIELDS = Object.freeze([
  "id", "archived", "createdAt", "pitch", "disclosures", "evidenceUrls",
  "canonicalFacts", "decodedFacts", "enrichedFacts", "rawUnknownActions",
  "issuanceLifecycle", "currentLifecycle", "stateChangedAfterQuote",
]);
const PROFILE_FIELDS = Object.freeze([
  "wallet", "ens", "availability", "acceptingSubmissions", "message", "policies", "governancePower",
]);

class GateClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GateClientError";
    this.code = code;
  }
}

function pick(value, fields) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field)) result[field] = source[field];
  }
  return result;
}

function projectInbox(value) {
  const item = pick(value, INBOX_FIELDS);
  if (typeof item.archived !== "boolean") item.archived = false;
  if (!Array.isArray(item.evidenceUrls)) item.evidenceUrls = [];
  if (!Array.isArray(item.enrichedFacts)) item.enrichedFacts = [];
  if (!Array.isArray(item.rawUnknownActions)) item.rawUnknownActions = [];
  if (!item.canonicalFacts || typeof item.canonicalFacts !== "object") item.canonicalFacts = {};
  if (!item.decodedFacts || typeof item.decodedFacts !== "object") item.decodedFacts = {};
  return item;
}

function projectProfile(value) {
  return pick(value, PROFILE_FIELDS);
}

function coarseError(status) {
  if (status === 401) return new GateClientError("UNAUTHORIZED", "authentication required");
  if (status === 404) return new GateClientError("NOT_FOUND", "not found");
  return new GateClientError("REQUEST_FAILED", "request failed");
}

function createGateClient({ baseUrl, token, fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl) throw new TypeError("Gate API baseUrl is required");
  if (typeof token !== "string" || !token) throw new GateClientError("UNAUTHORIZED", "authentication required");
  const root = baseUrl.replace(/\/+$/, "");

  async function request(method, path) {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status < 200 || response.status >= 300) throw coarseError(response.status);
    return body;
  }

  return Object.freeze({
    async profile() {
      return projectProfile(await request("GET", "/v1/gate/me/profile"));
    },
    async listInbox() {
      const body = await request("GET", "/v1/gate/me/inbox");
      const items = Array.isArray(body?.items) ? body.items.map(projectInbox) : [];
      return { items };
    },
    async showInbox(id) {
      if (typeof id !== "string" || !id) throw new GateClientError("INVALID_REQUEST", "inbox id is required");
      return projectInbox(await request("GET", `/v1/gate/me/inbox/${encodeURIComponent(id)}`));
    },
    async archiveInbox(id) {
      if (typeof id !== "string" || !id) throw new GateClientError("INVALID_REQUEST", "inbox id is required");
      const body = await request("POST", `/v1/gate/me/inbox/${encodeURIComponent(id)}/archive`);
      return { id: typeof body?.id === "string" ? body.id : id, archived: true };
    },
  });
}

module.exports = { GateClientError, createGateClient, projectInbox, projectProfile };
