const { getAddress } = require("ethers");
const { historyDocumentSchema, normalizedVoteSchema } = require("../../core/src/schema/governance");
const { sanitizeEndpoint } = require("./provenance");

const SUPPORTED_DAOS = ["nouns", "ens", "railgun-eth"];
// Public read-only index. Used when no operator override is configured, so an
// ordinary user needs no endpoint, no shared secret, and no network setup.
const DEFAULT_INDEX_API_URL = "https://index.0773h.com";
const DEFAULT_MAX_STALENESS_MS = 60 * 60 * 1000;
const MAX_HISTORY_PAGES = 1000;

class IndexStaleError extends Error {
  constructor(message) { super(message); this.name = "IndexStaleError"; this.code = "GAVEL_INDEX_STALE"; }
}

class IndexApiClient {
  constructor(options = {}) {
    // An explicit base URL or GAVEL_INDEX_API_URL selects a private or
    // self-hosted index; otherwise reads go to the public one.
    const configured = String(options.baseUrl || process.env.GAVEL_INDEX_API_URL || "").trim();
    this.isDefaultEndpoint = configured === "";
    this.baseUrl = (configured || DEFAULT_INDEX_API_URL).replace(/\/$/, "");
    this.fetch = options.fetch || globalThis.fetch;
    const pageSize = Number(options.pageSize || 100);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer");
    this.pageSize = Math.min(pageSize, 100);
    if (!/^https?:\/\//.test(this.baseUrl)) throw new TypeError("GAVEL_INDEX_API_URL must be an HTTP(S) URL");
    if (typeof this.fetch !== "function") throw new TypeError("fetch is required");
    const staleness = options.maxStalenessMs != null
      ? Number(options.maxStalenessMs)
      : Number(process.env.GAVEL_INDEX_MAX_STALENESS_SECONDS || 0) * 1000 || DEFAULT_MAX_STALENESS_MS;
    if (!Number.isFinite(staleness) || staleness <= 0) throw new RangeError("maxStalenessMs must be a positive number");
    this.maxStalenessMs = staleness;
    this.now = options.now || (() => new Date());
    // Recorded provenance is origin-only: a private endpoint's path and query
    // never reach a history document.
    this.publicBaseUrl = sanitizeEndpoint(this.baseUrl);
    this._freshness = new Map();
  }

  static dao(value) {
    const dao = String(value || "");
    if (!SUPPORTED_DAOS.includes(dao)) throw new TypeError(`invalid DAO: ${dao}`);
    return dao;
  }

  async request(path) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      // Name the endpoint that failed. The default one is chosen silently, so a
      // bare transport error leaves the caller nothing to act on. The sanitized
      // origin is used so the text can never echo a misconfigured secret.
      const override = this.isDefaultEndpoint ? "; set GAVEL_INDEX_API_URL to read a different index" : "";
      throw new Error(`Governance index request to ${this.publicBaseUrl} failed: ${error.message}${override}`);
    }
    if (!response.ok) throw new Error(`Governance index HTTP ${response.status} from ${this.publicBaseUrl}`);
    return response.json();
  }

  // The index is a cache of chain state, not an oracle. Serving a history
  // document from a stalled, failed or empty index would look identical to a
  // voter with no history, so every read gates on checkpoint freshness first.
  async assertFresh(dao) {
    const daoId = IndexApiClient.dao(dao);
    if (this._freshness.has(daoId)) return this._freshness.get(daoId);
    const status = await this.request(`/v1/daos/${daoId}/sync-status`);
    const sources = Array.isArray(status?.sources) ? status.sources : [];
    if (!sources.length) {
      throw new IndexStaleError(`Governance index has no sync checkpoint for ${daoId}. Run \`gavel-indexer backfill --dao ${daoId}\` before reading history.`);
    }
    const failed = sources.filter((row) => row.lastError);
    if (failed.length) {
      throw new IndexStaleError(`Governance index sync for ${daoId} is failing (source ${failed[0].sourceId}). Refusing to serve possibly incomplete history.`);
    }
    let newest = null;
    for (const row of sources) {
      const updatedAt = new Date(row.updatedAt).getTime();
      if (!Number.isFinite(updatedAt)) throw new IndexStaleError(`Governance index checkpoint for ${daoId} has no usable updatedAt.`);
      const age = this.now().getTime() - updatedAt;
      if (age > this.maxStalenessMs) {
        throw new IndexStaleError(`Governance index for ${daoId} is ${Math.round(age / 1000)}s stale (limit ${Math.round(this.maxStalenessMs / 1000)}s). Refusing to serve possibly incomplete history.`);
      }
      if (!newest || BigInt(row.finalizedHead || 0) > BigInt(newest.finalizedHead || 0)) newest = row;
    }
    const freshness = { daoId, finalizedHead: String(newest.finalizedHead ?? newest.nextBlock ?? "0"), updatedAt: newest.updatedAt };
    this._freshness.set(daoId, freshness);
    return freshness;
  }

  async fetchProposal(dao, id) {
    const daoId = IndexApiClient.dao(dao);
    if (!/^\d+$/.test(String(id)) || String(id).length > 78) throw new TypeError("invalid proposal id");
    await this.assertFresh(daoId);
    return this.request(`/v1/daos/${daoId}/proposals/${id}`);
  }

  async fetchHistory(dao, voter) {
    const daoId = IndexApiClient.dao(dao);
    const freshness = await this.assertFresh(daoId);
    const address = getAddress(voter);
    const queriedAt = new Date().toISOString();
    const events = [];
    let cursor = null;
    let pages = 0;
    do {
      if (++pages > MAX_HISTORY_PAGES) throw new Error(`Governance index history for ${address} exceeded ${MAX_HISTORY_PAGES} pages`);
      const query = new URLSearchParams({ limit: String(this.pageSize) });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request(`/v1/daos/${daoId}/voters/${address}/history?${query}`);
      events.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const cache = new Map();
    const votes = [];
    for (const event of events) {
      if (!cache.has(event.proposalId)) cache.set(event.proposalId, await this.fetchProposal(daoId, event.proposalId));
      const proposal = cache.get(event.proposalId);
      votes.push(normalizedVoteSchema.parse({
        dao: daoId,
        chainId: Number(event.chainId || 1),
        proposalId: String(event.proposalId),
        proposalContentHash: proposal.contentHash,
        voter: getAddress(event.voter),
        support: event.support,
        reason: event.reason ?? null,
        blockNumber: String(event.blockNumber),
        timestamp: new Date(event.timestamp).toISOString(),
        voteWeight: String(event.voteWeight),
        clientId: Number(event.clientId ?? 0),
        proposal,
        source: {
          kind: event.sourceKind,
          endpoint: event.sourceEndpoint,
          // Preserve the upstream entity id so chronological tie-breaks stay
          // identical to a subgraph-generated document.
          entityId: event.entityId || `${address.toLowerCase()}-${event.transactionHash}-${event.logIndex}`,
          transactionHash: event.transactionHash,
          subgraphBlock: String(event.observedHead),
          queriedAt,
        },
      }));
    }
    return historyDocumentSchema.parse({
      schemaVersion: "1.0.0",
      dao: daoId,
      chainId: 1,
      voter: address,
      generatedAt: queriedAt,
      // The document head is the indexer's verified checkpoint, not the highest
      // block this voter happens to appear in: a voter with no votes must not
      // report a head of 0.
      source: { kind: "gavel-governance-index", endpoint: this.publicBaseUrl, subgraphBlock: freshness.finalizedHead },
      voteCount: votes.length,
      votes,
    });
  }
}

module.exports = { IndexApiClient, IndexStaleError, DEFAULT_INDEX_API_URL };
