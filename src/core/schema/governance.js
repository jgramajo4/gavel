const { z } = require("zod");

const Support = Object.freeze({
  AGAINST: "AGAINST",
  FOR: "FOR",
  ABSTAIN: "ABSTAIN",
});

const supportSchema = z.enum(Object.values(Support));
const decimalStringSchema = z.string().regex(/^\d+$/, "expected an unsigned integer string");
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x-prefixed hex");
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected an EVM address");

const proposalActionSchema = z.object({
  index: z.number().int().nonnegative(),
  target: addressSchema,
  valueWei: decimalStringSchema,
  signature: z.string(),
  calldata: hexSchema,
});

const normalizedProposalSchema = z.object({
  id: decimalStringSchema,
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string(),
  description: z.string(),
  proposer: addressSchema,
  state: z.string().min(1),
  outcome: z.string().min(1),
  createdBlock: decimalStringSchema,
  createdAt: z.string().datetime(),
  startBlock: decimalStringSchema,
  endBlock: decimalStringSchema,
  quorumVotes: decimalStringSchema,
  forVotes: decimalStringSchema,
  againstVotes: decimalStringSchema,
  abstainVotes: decimalStringSchema,
  actions: z.array(proposalActionSchema),
});

const sourceProvenanceSchema = z.object({
  kind: z.literal("nouns-subgraph"),
  endpoint: z.string().url(),
  entityId: z.string().min(1),
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  subgraphBlock: decimalStringSchema,
  queriedAt: z.string().datetime(),
});

const normalizedVoteSchema = z.object({
  dao: z.literal("nouns"),
  chainId: z.literal(1),
  proposalId: decimalStringSchema,
  proposalContentHash: z.string().regex(/^[0-9a-f]{64}$/),
  voter: addressSchema,
  support: supportSchema,
  reason: z.string().nullable(),
  blockNumber: decimalStringSchema,
  timestamp: z.string().datetime(),
  voteWeight: decimalStringSchema,
  clientId: z.number().int().min(0).max(0xffffffff),
  proposal: normalizedProposalSchema,
  source: sourceProvenanceSchema,
});

const historyDocumentSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    dao: z.literal("nouns"),
    chainId: z.literal(1),
    voter: addressSchema,
    generatedAt: z.string().datetime(),
    source: z.object({
      kind: z.literal("nouns-subgraph"),
      endpoint: z.string().url(),
      subgraphBlock: decimalStringSchema,
    }),
    voteCount: z.number().int().nonnegative(),
    votes: z.array(normalizedVoteSchema),
  })
  .refine((document) => document.voteCount === document.votes.length, {
    message: "voteCount must equal votes.length",
    path: ["voteCount"],
  });

function supportFromNouns(value) {
  const support = Number(value);
  if (support === 0) return Support.AGAINST;
  if (support === 1) return Support.FOR;
  if (support === 2) return Support.ABSTAIN;
  throw new RangeError(`Unknown Nouns support value: ${value}`);
}

module.exports = {
  Support,
  supportFromNouns,
  proposalActionSchema,
  normalizedProposalSchema,
  normalizedVoteSchema,
  historyDocumentSchema,
};
