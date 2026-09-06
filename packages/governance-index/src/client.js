const { getAddress } = require("ethers");
const { historyDocumentSchema, normalizedVoteSchema } = require("../../core/src/schema/governance");

class IndexApiClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.GAVEL_INDEX_API_URL || "").replace(/\/$/, "");
    this.fetch = options.fetch || globalThis.fetch;
    const pageSize = Number(options.pageSize || 100);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer");
    this.pageSize = Math.min(pageSize, 100);
    if (!/^https?:\/\//.test(this.baseUrl)) throw new TypeError("GAVEL_INDEX_API_URL must be an HTTP(S) URL");
    if (typeof this.fetch !== "function") throw new TypeError("fetch is required");
  }
  async request(path) { const response = await this.fetch(`${this.baseUrl}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`Governance index HTTP ${response.status}`); return response.json(); }
  async fetchProposal(dao, id) { if (!/^(nouns|ens|railgun-eth)$/.test(dao) || !/^\d+$/.test(String(id))) throw new TypeError("invalid DAO or proposal id"); return this.request(`/v1/daos/${dao}/proposals/${id}`); }
  async fetchHistory(dao, voter) {
    const address = getAddress(voter); const queriedAt = new Date().toISOString(); const events = []; let cursor = null;
    do { const query = new URLSearchParams({ limit: String(this.pageSize) }); if (cursor) query.set("cursor", cursor); const page = await this.request(`/v1/daos/${dao}/voters/${address}/history?${query}`); events.push(...page.items); cursor = page.nextCursor; } while (cursor);
    const cache = new Map(); const votes = [];
    for (const event of events) {
      if (!cache.has(event.proposalId)) cache.set(event.proposalId, await this.fetchProposal(dao, event.proposalId));
      const proposal = cache.get(event.proposalId); const endpoint = event.sourceEndpoint; const head = String(event.observedHead);
      votes.push(normalizedVoteSchema.parse({ dao, chainId: Number(event.chainId || 1), proposalId: String(event.proposalId), proposalContentHash: proposal.contentHash, voter: getAddress(event.voter), support: event.support, reason: event.reason ?? null, blockNumber: String(event.blockNumber), timestamp: new Date(event.timestamp).toISOString(), voteWeight: String(event.voteWeight), clientId: 0, proposal, source: { kind: event.sourceKind, endpoint, entityId: `${address.toLowerCase()}-${event.transactionHash}-${event.logIndex}`, transactionHash: event.transactionHash, subgraphBlock: head, queriedAt } }));
    }
    const head = votes.reduce((max, vote) => BigInt(vote.source.subgraphBlock) > BigInt(max) ? vote.source.subgraphBlock : max, "0");
    return historyDocumentSchema.parse({ schemaVersion: "1.0.0", dao, chainId: 1, voter: address, generatedAt: queriedAt, source: { kind: "gavel-governance-index", endpoint: this.baseUrl, subgraphBlock: head }, voteCount: votes.length, votes });
  }
}
module.exports = { IndexApiClient };
