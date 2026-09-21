const { getAddress } = require("ethers");
const { historyDocumentSchema, normalizedVoteSchema } = require("../../core/src/schema/governance");
const { sanitizeEndpoint } = require("./provenance");

const SUPPORTED_DAOS = ["nouns", "ens", "railgun-eth"];
// Public read-only index. Used when no operator override is configured, so an
// ordinary user needs no endpoint, no shared secret, and no network setup.
const DEFAULT_INDEX_API_URL = "https://index.0773h.com";
const DEFAULT_MAX_STALENESS_MS = 60 * 60 * 1000;
const MAX_HISTORY_PAGES = 1000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 8_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Caps a whole history sync (pages + proposal joins + 429 waits). Long enough
// for a few rate-limit pauses, short enough that a busy index cannot hang the
// CLI for tens of minutes.
const DEFAULT_OPERATION_DEADLINE_MS = 90_000;

class IndexStaleError extends Error {
  constructor(message) { super(message); this.name = "IndexStaleError"; this.code = "GAVEL_INDEX_STALE"; }
}

class IndexRateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = "IndexRateLimitedError";
    this.code = "GAVEL_INDEX_RATE_LIMITED";
  }
}

const RATE_LIMITED_MESSAGE = "The history source is temporarily rate-limited. Try again in a moment. No vote can be prepared until history sync completes.";

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${name} must be a positive number`);
  return n;
}

function nonNegativeInteger(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer`);
  return n;
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
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random || Math.random;
    this.maxRetries = nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, "maxRetries");
    this.baseBackoffMs = positiveNumber(options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS, "baseBackoffMs");
    this.maxBackoffMs = positiveNumber(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, "maxBackoffMs");
    this.maxRetryAfterMs = positiveNumber(options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS, "maxRetryAfterMs");
    this.requestTimeoutMs = positiveNumber(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs");
    this.operationDeadlineMs = positiveNumber(options.operationDeadlineMs ?? DEFAULT_OPERATION_DEADLINE_MS, "operationDeadlineMs");
    if (this.maxBackoffMs < this.baseBackoffMs) throw new RangeError("maxBackoffMs must be >= baseBackoffMs");
    if (this.maxRetryAfterMs < this.baseBackoffMs) throw new RangeError("maxRetryAfterMs must be >= baseBackoffMs");
    // Recorded provenance is origin-only: a private endpoint's path and query
    // never reach a history document.
    this.publicBaseUrl = sanitizeEndpoint(this.baseUrl);
    this._freshness = new Map();
    this._deadlineAt = null;
  }

  static dao(value) {
    const dao = String(value || "");
    if (!SUPPORTED_DAOS.includes(dao)) throw new TypeError(`invalid DAO: ${dao}`);
    return dao;
  }

  parseRetryAfterMs(response) {
    const raw = typeof response.headers?.get === "function" ? response.headers.get("retry-after") : null;
    if (raw == null || raw === "") return null;
    const trimmed = String(raw).trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) return at - this.now().getTime();
    return null;
  }

  retryDelayMs(response, attempt) {
    const parsed = this.parseRetryAfterMs(response);
    let delay;
    let cap;
    if (parsed != null && Number.isFinite(parsed)) {
      delay = parsed * (0.9 + 0.2 * this.random());
      cap = this.maxRetryAfterMs;
    } else {
      delay = this.baseBackoffMs * (2 ** attempt) * (0.5 + this.random());
      cap = this.maxBackoffMs;
    }
    return Math.min(cap, Math.max(this.baseBackoffMs, delay));
  }

  assertWithinDeadline(upcomingDelayMs = 0) {
    if (this._deadlineAt == null) return;
    if (this.now().getTime() + upcomingDelayMs >= this._deadlineAt) {
      throw new IndexRateLimitedError(RATE_LIMITED_MESSAGE);
    }
  }

  async runOperation(fn) {
    if (this._deadlineAt != null) return fn();
    this._deadlineAt = this.now().getTime() + this.operationDeadlineMs;
    try {
      return await fn();
    } finally {
      this._deadlineAt = null;
    }
  }

  async request(path) {
    const url = `${this.baseUrl}${path}`;
    const override = this.isDefaultEndpoint ? "; set GAVEL_INDEX_API_URL to read a different index" : "";
    for (let attempt = 0; ; attempt++) {
      this.assertWithinDeadline();
      let response;
      try {
        // Fresh timeout per attempt so a Retry-After sleep cannot abort the next request.
        response = await this.fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        // Name the endpoint that failed. The default one is chosen silently, so a
        // bare transport error leaves the caller nothing to act on. The sanitized
        // origin is used so the text can never echo a misconfigured secret.
        throw new Error(`Governance index request to ${this.publicBaseUrl} failed: ${error.message}${override}`);
      }
      if (response.status === 429) {
        if (attempt >= this.maxRetries) throw new IndexRateLimitedError(RATE_LIMITED_MESSAGE);
        const delay = this.retryDelayMs(response, attempt);
        this.assertWithinDeadline(delay);
        await this.sleep(delay);
        continue;
      }
      if (!response.ok) throw new Error(`Governance index HTTP ${response.status} from ${this.publicBaseUrl}`);
      return response.json();
    }
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
    return this.runOperation(async () => {
      const daoId = IndexApiClient.dao(dao);
      if (!/^\d+$/.test(String(id)) || String(id).length > 78) throw new TypeError("invalid proposal id");
      await this.assertFresh(daoId);
      return this.request(`/v1/daos/${daoId}/proposals/${id}`);
    });
  }

  async fetchHistory(dao, voter) {
    return this.runOperation(async () => {
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
    });
  }
}

module.exports = { IndexApiClient, IndexStaleError, IndexRateLimitedError, DEFAULT_INDEX_API_URL };
