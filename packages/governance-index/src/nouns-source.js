const { createHash } = require("node:crypto");
const { getAddress } = require("ethers");
const { DAO_CONFIGS } = require("./config");
const { normalizeVote, normalizeProposal } = require("../../nouns-adapter/src/history");

const PROPOSAL_FIELDS = `id title description status proposer { id } targets values signatures calldatas createdTimestamp createdBlock startBlock endBlock quorumVotes forVotes againstVotes abstainVotes`;
const VOTE_FIELDS = `id supportDetailed votesRaw reason blockNumber blockTimestamp transactionHash clientId voter { id } proposal { ${PROPOSAL_FIELDS} }`;
const SNAPSHOT = `query { _meta { block { number } } }`;
const PAGE = `query Votes($first:Int!,$after:ID!,$from:BigInt!,$to:BigInt!,$snapshot:Int!){votes(first:$first,orderBy:id,orderDirection:asc,block:{number:$snapshot},where:{id_gt:$after,blockNumber_gte:$from,blockNumber_lte:$to}){${VOTE_FIELDS}}}`;
const PROPOSALS_PAGE = `query Proposals($first:Int!,$after:ID!,$snapshot:Int!){proposals(first:$first,orderBy:id,orderDirection:asc,block:{number:$snapshot},where:{id_gt:$after}){${PROPOSAL_FIELDS}}}`;
// Discovery restricted to proposals created in the synced range, and a targeted
// refresh for proposals whose state can still change. Together these replace the
// full re-enumeration on every cycle.
const NEW_PROPOSALS_PAGE = `query NewProposals($first:Int!,$after:ID!,$from:BigInt!,$snapshot:Int!){proposals(first:$first,orderBy:id,orderDirection:asc,block:{number:$snapshot},where:{id_gt:$after,createdBlock_gte:$from}){${PROPOSAL_FIELDS}}}`;
const REFRESH_PROPOSALS = `query RefreshProposals($ids:[ID!]!,$snapshot:Int!){proposals(first:1000,where:{id_in:$ids},block:{number:$snapshot}){${PROPOSAL_FIELDS}}}`;

class NounsSubgraphSource {
  constructor(options = {}) {
    this.config = DAO_CONFIGS.nouns; this.id = this.config.source.id;
    this.endpoint = options.endpoint || process.env.NOUNS_SUBGRAPH_URL || this.config.source.endpoint;
    this.publicEndpoint = options.sourcePublicEndpoint || process.env.PUBLIC_SOURCE_ENDPOINT || new URL(this.endpoint).origin;
    this.rpcUrl = this.endpoint; this.fetch = options.fetch || globalThis.fetch;
    this.fromBlock = Number(options.fromBlock || this.config.fromBlock);
    this.finalityDepth = Number(options.finalityDepth ?? 12); this.replayBlocks = Number(options.replayBlocks ?? 64);
    this.pageSize = Number(options.pageSize || 500); this.timeoutMs = Number(options.timeoutMs || 30_000);
    if (!/^https?:\/\//.test(this.endpoint)) throw new TypeError("NOUNS_SUBGRAPH_URL must be HTTP(S)");
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1000) throw new RangeError("pageSize must be an integer from 1 to 1000");
  }
  async request(query, variables = {}) {
    let error;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(this.timeoutMs) });
        if (!response.ok) throw new Error(`Nouns subgraph HTTP ${response.status}`);
        const body = await response.json(); if (body.errors?.length) throw new Error(JSON.stringify(body.errors)); return body.data;
      } catch (caught) { error = caught; if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1))); }
    }
    throw error;
  }
  async head() { const data = await this.request(SNAPSHOT); const head = Number(data?._meta?.block?.number); if (!Number.isSafeInteger(head)) throw new Error("Nouns subgraph returned no safe head"); return Math.max(0, head - this.finalityDepth); }
  async page(query, field, fromBlock, toBlock, snapshot) {
    const rows = []; let after = "";
    while (true) {
      const data = await this.request(query, { first: this.pageSize, after, from: String(fromBlock), to: String(toBlock), snapshot: Number(snapshot) });
      const page = data?.[field]; if (!Array.isArray(page)) throw new Error(`Nouns subgraph response missing ${field} array`);
      rows.push(...page); if (page.length < this.pageSize) return rows;
      const next = String(page.at(-1).id); if (next <= after) throw new Error(`Nouns ${field} pagination did not advance`); after = next;
    }
  }
  async fetchRange(fromBlock, toBlock, snapshot = toBlock) { return this.page(PAGE, "votes", fromBlock, toBlock, snapshot); }
  async incrementalProposals(fromBlock, snapshot, context) {
    const rows = await this.page(NEW_PROPOSALS_PAGE, "proposals", fromBlock, snapshot, snapshot);
    const discovered = new Set(rows.map((row) => String(row.id)));
    const refreshIds = (context.refreshProposals || [])
      .filter((row) => !discovered.has(String(row.proposalId)))
      .map((row) => String(row.proposalId));
    for (let index = 0; index < refreshIds.length; index += 100) {
      const data = await this.request(REFRESH_PROPOSALS, { ids: refreshIds.slice(index, index + 100), snapshot: Number(snapshot) });
      const page = data?.proposals;
      if (!Array.isArray(page)) throw new Error("Nouns subgraph response missing proposals array");
      rows.push(...page);
    }
    return rows;
  }

  async fetchProposals(fromBlock, toBlock, snapshot = toBlock, context = {}) {
    const rows = context.full
      ? await this.page(PROPOSALS_PAGE, "proposals", 0, snapshot, snapshot)
      : await this.incrementalProposals(fromBlock, snapshot, context);
    return rows.map((proposal) => {
      const normalized = { ...normalizeProposal(proposal, { endpoint: this.endpoint, queriedAt: new Date().toISOString(), subgraphBlock: String(snapshot) }), dao: "nouns", chainId: 1, venue: "governor", timing: "block" };
      const payload = { id: proposal.id, title: proposal.title, description: proposal.description, proposer: proposal.proposer, targets: proposal.targets, values: proposal.values, signatures: proposal.signatures, calldatas: proposal.calldatas, createdTimestamp: proposal.createdTimestamp, createdBlock: proposal.createdBlock, startBlock: proposal.startBlock, endBlock: proposal.endBlock };
      return {
        raw: { daoId: "nouns", sourceId: this.id, sourceRecordKey: `proposal:${proposal.id}`, externalId: String(proposal.id), chainId: 1, contractAddress: this.config.contractAddress, transactionHash: null, logIndex: null, blockNumber: String(proposal.createdBlock), blockHash: null, recordType: "proposal", proposalId: normalized.id, contentHash: normalized.contentHash, payload, sourceKind: "nouns-subgraph", sourceEndpoint: this.endpoint, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(snapshot) },
        proposal: { daoId: "nouns", proposalId: normalized.id, contentHash: normalized.contentHash, normalized, actions: normalized.actions },
      };
    });
  }
  async normalizeLog(vote, head) {
    const normalized = normalizeVote(vote, { endpoint: this.endpoint, queriedAt: new Date().toISOString(), subgraphBlock: String(head) });
    const logIndex = parseInt(createHash("sha256").update(String(vote.id)).digest("hex").slice(0, 7), 16);
    const payload = { id: vote.id, supportDetailed: vote.supportDetailed, votesRaw: vote.votesRaw, reason: vote.reason, blockNumber: vote.blockNumber, blockTimestamp: vote.blockTimestamp, transactionHash: vote.transactionHash, clientId: vote.clientId, voter: { id: vote.voter.id }, proposalId: vote.proposal.id };
    const base = { daoId: "nouns", sourceId: this.id, sourceRecordKey: `vote:${vote.id}`, chainId: 1, contractAddress: this.config.contractAddress, transactionHash: normalized.source.transactionHash, logIndex: null, blockNumber: normalized.blockNumber, blockHash: null, recordType: "vote", proposalId: normalized.proposal.id, payload, sourceKind: "nouns-subgraph", sourceEndpoint: this.endpoint, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(head), externalId: String(vote.id) };
    return { raw: base, vote: { daoId: "nouns", sourceId: this.id, sourceRecordKey: `vote:${vote.id}`, chainId: 1, contractAddress: this.config.contractAddress, proposalId: normalized.proposalId, voter: getAddress(normalized.voter), support: normalized.support, reason: normalized.reason, voteWeight: normalized.voteWeight, blockNumber: normalized.blockNumber, timestamp: normalized.timestamp, transactionHash: normalized.source.transactionHash, logIndex, sourceKind: normalized.source.kind, sourceEndpoint: this.endpoint, sourcePublicEndpoint: this.publicEndpoint, observedHead: String(head), normalized } };
  }
}
module.exports = { NounsSubgraphSource, NOUNS_INDEX_QUERY: PAGE, NOUNS_PROPOSALS_QUERY: PROPOSALS_PAGE, NOUNS_NEW_PROPOSALS_QUERY: NEW_PROPOSALS_PAGE, NOUNS_REFRESH_PROPOSALS_QUERY: REFRESH_PROPOSALS };
