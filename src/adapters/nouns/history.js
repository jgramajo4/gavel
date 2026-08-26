const { createHash } = require("node:crypto");
const { getAddress } = require("ethers");

const { GovernanceHistoryAdapter } = require("../../core/history/adapter");
const {
  historyDocumentSchema,
  normalizedVoteSchema,
  supportFromNouns,
} = require("../../core/schema/governance");

const DEFAULT_ENDPOINT = "https://www.nouns.camp/subgraphs/nouns";
const DEFAULT_PAGE_SIZE = 100;

const VOTE_FIELDS = `
  id
  supportDetailed
  votesRaw
  reason
  blockNumber
  blockTimestamp
  transactionHash
  clientId
  voter { id }
  proposal {
    id
    title
    description
    status
    proposer { id }
    targets
    values
    signatures
    calldatas
    createdTimestamp
    createdBlock
    startBlock
    endBlock
    quorumVotes
    forVotes
    againstVotes
    abstainVotes
  }
`;

const SNAPSHOT_QUERY = `
  query SnapshotBlock {
    _meta { block { number } }
  }
`;

const HISTORY_QUERY = `
  query VoterHistory($voter: String!, $first: Int!, $skip: Int!, $block: Int!) {
    votes(
      first: $first
      skip: $skip
      block: { number: $block }
      where: { voter: $voter }
      orderBy: blockNumber
      orderDirection: asc
    ) {
      ${VOTE_FIELDS}
    }
  }
`;

function isoFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError(`Invalid Unix timestamp: ${value}`);
  }
  return new Date(seconds * 1000).toISOString();
}

function proposalContentHash(proposal) {
  const material = JSON.stringify({
    description: proposal.description || "",
    targets: proposal.targets || [],
    values: proposal.values || [],
    signatures: proposal.signatures || [],
    calldatas: proposal.calldatas || [],
  });
  return createHash("sha256").update(material).digest("hex");
}

function proposalOutcome(proposal, subgraphBlock) {
  const state = String(proposal.status || "UNKNOWN").toUpperCase();
  if (["EXECUTED", "CANCELLED", "CANCELED", "VETOED", "QUEUED"].includes(state)) {
    return state === "CANCELED" ? "CANCELLED" : state;
  }
  if (BigInt(subgraphBlock) <= BigInt(proposal.endBlock)) return state;

  const passed =
    BigInt(proposal.forVotes) > BigInt(proposal.againstVotes) &&
    BigInt(proposal.forVotes) >= BigInt(proposal.quorumVotes);
  return passed ? "SUCCEEDED" : "DEFEATED";
}

function normalizeActions(proposal) {
  const targets = proposal.targets || [];
  const values = proposal.values || [];
  const signatures = proposal.signatures || [];
  const calldatas = proposal.calldatas || [];
  const lengths = [targets.length, values.length, signatures.length, calldatas.length];
  if (!lengths.every((length) => length === targets.length)) {
    throw new Error(`Proposal ${proposal.id} has misaligned action arrays: ${lengths.join(",")}`);
  }
  return targets.map((target, index) => ({
    index,
    target: getAddress(target),
    valueWei: String(values[index]),
    signature: signatures[index] || "",
    calldata: calldatas[index] || "0x",
  }));
}

function normalizeVote(rawVote, context) {
  const proposal = rawVote.proposal;
  if (!proposal) throw new Error(`Vote ${rawVote.id} has no proposal`);

  const contentHash = proposalContentHash(proposal);
  const queriedAt = context.queriedAt;
  const normalized = {
    dao: "nouns",
    chainId: 1,
    proposalId: String(proposal.id),
    proposalContentHash: contentHash,
    voter: getAddress(rawVote.voter.id),
    support: supportFromNouns(rawVote.supportDetailed),
    reason: rawVote.reason == null || rawVote.reason === "" ? null : String(rawVote.reason),
    blockNumber: String(rawVote.blockNumber),
    timestamp: isoFromUnixSeconds(rawVote.blockTimestamp),
    voteWeight: String(rawVote.votesRaw),
    clientId: Number(rawVote.clientId),
    proposal: {
      id: String(proposal.id),
      contentHash,
      title: String(proposal.title || ""),
      description: String(proposal.description || ""),
      proposer: getAddress(proposal.proposer.id),
      state: String(proposal.status || "UNKNOWN").toUpperCase(),
      outcome: proposalOutcome(proposal, context.subgraphBlock),
      createdBlock: String(proposal.createdBlock),
      createdAt: isoFromUnixSeconds(proposal.createdTimestamp),
      startBlock: String(proposal.startBlock),
      endBlock: String(proposal.endBlock),
      quorumVotes: String(proposal.quorumVotes),
      forVotes: String(proposal.forVotes),
      againstVotes: String(proposal.againstVotes),
      abstainVotes: String(proposal.abstainVotes),
      actions: normalizeActions(proposal),
    },
    source: {
      kind: "nouns-subgraph",
      endpoint: context.endpoint,
      entityId: String(rawVote.id),
      transactionHash: String(rawVote.transactionHash),
      subgraphBlock: String(context.subgraphBlock),
      queriedAt,
    },
  };

  return normalizedVoteSchema.parse(normalized);
}

class NounsSubgraphHistoryAdapter extends GovernanceHistoryAdapter {
  constructor(options = {}) {
    super();
    this.endpoint = options.endpoint || process.env.NOUNS_SUBGRAPH_URL || DEFAULT_ENDPOINT;
    this.fetch = options.fetch || globalThis.fetch;
    this.pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
    this.timeoutMs = options.timeoutMs || 30_000;
    if (typeof this.fetch !== "function") throw new Error("A fetch implementation is required");
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 1000) {
      throw new RangeError("pageSize must be an integer from 1 to 1000");
    }
  }

  async request(query, variables = {}) {
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Nouns subgraph HTTP ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    if (body.errors?.length) {
      throw new Error(`Nouns subgraph error: ${JSON.stringify(body.errors)}`);
    }
    return body.data;
  }

  async snapshotBlock() {
    const data = await this.request(SNAPSHOT_QUERY);
    if (!data?._meta?.block?.number) {
      throw new Error("Nouns subgraph returned no snapshot block");
    }
    return String(data._meta.block.number);
  }

  async query(variables) {
    const data = await this.request(HISTORY_QUERY, variables);
    if (!Array.isArray(data?.votes)) {
      throw new Error("Nouns subgraph returned an unexpected history payload");
    }
    return data.votes;
  }

  async fetchHistory(voter) {
    const checksummedVoter = getAddress(voter);
    const queryVoter = checksummedVoter.toLowerCase();
    const queriedAt = new Date().toISOString();
    const rawVotes = [];
    let skip = 0;
    const subgraphBlock = await this.snapshotBlock();
    const block = Number(subgraphBlock);
    if (!Number.isSafeInteger(block)) throw new Error(`Unsafe subgraph block: ${subgraphBlock}`);

    while (true) {
      const votes = await this.query({
        voter: queryVoter,
        first: this.pageSize,
        skip,
        block,
      });
      rawVotes.push(...votes);
      if (votes.length < this.pageSize) break;
      skip += votes.length;
    }

    const context = { endpoint: this.endpoint, queriedAt, subgraphBlock };
    const votes = rawVotes.map((vote) => normalizeVote(vote, context));
    for (const vote of votes) {
      if (vote.voter !== checksummedVoter) {
        throw new Error(`History response included vote for unexpected voter ${vote.voter}`);
      }
    }

    return historyDocumentSchema.parse({
      schemaVersion: "1.0.0",
      dao: "nouns",
      chainId: 1,
      voter: checksummedVoter,
      generatedAt: queriedAt,
      source: {
        kind: "nouns-subgraph",
        endpoint: this.endpoint,
        subgraphBlock,
      },
      voteCount: votes.length,
      votes,
    });
  }
}

module.exports = {
  DEFAULT_ENDPOINT,
  SNAPSHOT_QUERY,
  HISTORY_QUERY,
  isoFromUnixSeconds,
  proposalContentHash,
  proposalOutcome,
  normalizeActions,
  normalizeVote,
  NounsSubgraphHistoryAdapter,
};
