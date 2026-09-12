/**
 * The canonical, DAO-agnostic governance intent.
 *
 * A VoteIntent is the whole of what Gavel decided: this voter, this proposal,
 * this support, for this reason. It contains no calldata, no target contract,
 * and nothing naming an execution provider. A DAO adapter turns it into an
 * ExecutionIntent; nothing else may.
 */

const { getAddress } = require("ethers");

const { voteIntentSchema, VoteSupport } = require("../schema/intent");
const {
  domainHash,
  normalizeChainId,
  normalizeReason,
  normalizeTimestamp,
} = require("./canonical");

const VOTE_INTENT_DOMAIN = "gavel.vote-intent.v1";

function createVoteIntent(input) {
  const support = String(input?.support ?? "").toUpperCase();
  if (!(support in VoteSupport)) throw new TypeError("support must be FOR, AGAINST, or ABSTAIN");
  const document = {
    version: 1,
    dao: String(input.dao ?? ""),
    chainId: normalizeChainId(input.chainId),
    voterAddress: getAddress(input.voterAddress),
    proposalId: String(input.proposalId ?? ""),
    support,
    reason: normalizeReason(input.reason),
    createdAt: normalizeTimestamp(input.createdAt, "createdAt"),
  };
  if (input.metadata != null) {
    if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw new TypeError("VoteIntent metadata must be an object");
    }
    document.metadata = input.metadata;
  }
  return voteIntentSchema.parse(document);
}

/**
 * `createdAt` and `metadata` are excluded on purpose.
 *
 * The brief requires that the same logical intent always hash the same, and
 * this hash is folded into the ExecutionIntent hash. Hashing a wall-clock
 * timestamp would make two identical governance decisions -- the same voter
 * voting FOR the same proposal with the same reason -- hash differently, which
 * would in turn defeat execution-level deduplication. `metadata` is
 * caller-supplied annotation with no security meaning and is excluded for the
 * same reason.
 */
function voteIntentHash(intent) {
  const parsed = voteIntentSchema.parse(intent);
  return domainHash(VOTE_INTENT_DOMAIN, [
    parsed.version,
    parsed.dao,
    parsed.chainId,
    getAddress(parsed.voterAddress),
    parsed.proposalId,
    parsed.support,
    parsed.reason,
  ]);
}

module.exports = { VOTE_INTENT_DOMAIN, createVoteIntent, voteIntentHash };
