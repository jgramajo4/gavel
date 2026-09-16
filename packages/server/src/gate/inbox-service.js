const { ProfileRequestError } = require("./profile-service");

function unauthorized() {
  return new ProfileRequestError("authentication required", 401, "UNAUTHORIZED");
}

function notFound() {
  return new ProfileRequestError("Not found", 404, "NOT_FOUND");
}

function asIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function projectInbox(row) {
  const material = row.material && typeof row.material === "object" && !Array.isArray(row.material)
    ? row.material : {};
  const decoded = row.decodedFacts && typeof row.decodedFacts === "object" ? row.decodedFacts : {};
  const decodedActions = Array.isArray(decoded.actions) ? decoded.actions : [];
  const decodedIndexes = new Set(decodedActions.map((action, index) => (
    Number.isInteger(action?.actionIndex) ? action.actionIndex : index
  )));
  const canonicalActions = Array.isArray(row.canonicalActions) ? row.canonicalActions : [];
  const rawUnknownActions = canonicalActions.filter((action, index) => {
    const actionIndex = Number.isInteger(action?.actionIndex) ? action.actionIndex : index;
    return !decodedIndexes.has(actionIndex);
  });
  return {
    id: row.id,
    archived: row.archivedAt != null,
    createdAt: asIso(row.createdAt),
    pitch: typeof material.pitch === "string" ? material.pitch : "",
    disclosures: typeof material.disclosures === "string" ? material.disclosures : "",
    evidenceUrls: Array.isArray(material.evidenceUrls)
      ? material.evidenceUrls.filter((url) => typeof url === "string") : [],
    canonicalFacts: row.canonicalFacts && typeof row.canonicalFacts === "object" ? row.canonicalFacts : {},
    decodedFacts: decoded,
    enrichedFacts: Array.isArray(row.enrichedFacts) ? row.enrichedFacts : [],
    rawUnknownActions,
    issuanceLifecycle: row.issuanceLifecycle,
    currentLifecycle: row.currentLifecycle,
    stateChangedAfterQuote: row.lifecycleChanged === true,
  };
}

function createInboxService({ store } = {}) {
  if (!store || typeof store.getProfileByWallet !== "function"
      || typeof store.listInboxItems !== "function"
      || typeof store.getInboxItem !== "function"
      || typeof store.archiveInboxItem !== "function") {
    throw new TypeError("complete inbox store is required");
  }

  async function ownerProfile(session) {
    if (!session || session.role !== "dao_inbox" || typeof session.wallet !== "string") throw unauthorized();
    return store.getProfileByWallet(session.wallet);
  }

  async function listInbox({ session } = {}) {
    const profile = await ownerProfile(session);
    if (!profile) return { items: [] };
    const rows = await store.listInboxItems(profile.id);
    return { items: rows.map(projectInbox) };
  }

  async function getInbox({ session, id } = {}) {
    const profile = await ownerProfile(session);
    if (!profile || typeof id !== "string" || !id) throw notFound();
    const row = await store.getInboxItem(profile.id, id);
    if (!row) throw notFound();
    return projectInbox(row);
  }

  async function archiveInbox({ session, id } = {}) {
    const profile = await ownerProfile(session);
    if (!profile || typeof id !== "string" || !id) throw notFound();
    const row = await store.archiveInboxItem(profile.id, id);
    if (!row) throw notFound();
    return { id: row.id, archived: true };
  }

  return Object.freeze({ listInbox, getInbox, archiveInbox });
}

module.exports = { createInboxService, projectInbox };
