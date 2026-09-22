/**
 * The canonical, provider-neutral execution intent.
 *
 * An ExecutionIntent says exactly which onchain call represents a governance
 * decision. It is the last artifact a DAO adapter produces and the first one an
 * execution adapter sees. It knows nothing about Safe, WaaP, EOAs or bundlers:
 * `actor` is whichever address must originate the call, and how that address is
 * made to originate it is the execution layer's problem.
 */

const { getAddress } = require("ethers");

const { executionIntentSchema } = require("../schema/intent");
const { createVoteIntent, voteIntentHash } = require("./vote-intent");
const {
  deepFreeze,
  domainHash,
  normalizeChainId,
  normalizeHex,
  normalizeReason,
  normalizeUint,
  selectorOf,
} = require("./canonical");

const EXECUTION_INTENT_DOMAIN = "gavel.execution-intent.v1";

/**
 * Build an ExecutionIntent from a VoteIntent plus the call a DAO adapter
 * derived for it.
 *
 * `actor` defaults to the VoteIntent's voter. It differs whenever voting power
 * is delegated to a separate execution address -- a Safe, a WaaP wallet -- and
 * the DAO adapter is what establishes that the delegation actually exists.
 */
function createExecutionIntent(input) {
  const voteIntent = createVoteIntent(input.voteIntent);
  const chainId = normalizeChainId(input.chainId ?? voteIntent.chainId);
  if (chainId !== voteIntent.chainId) {
    throw new Error("ExecutionIntent chain must match the governance intent chain");
  }
  const operation = String(input.operation ?? "CALL").toUpperCase();
  if (operation !== "CALL") {
    throw new Error("Only CALL execution intents are supported; delegatecall is never a governance vote");
  }
  // Frozen at construction, `source` included: the DAO an execution intent
  // was built for is settled here and cannot be rewritten in place later.
  return deepFreeze(executionIntentSchema.parse({
    version: 1,
    chainId,
    actor: getAddress(input.actor ?? voteIntent.voterAddress),
    target: getAddress(input.target),
    value: normalizeUint(input.value ?? 0n, "value"),
    data: normalizeHex(input.data, "data"),
    operation,
    source: {
      type: "governance-vote",
      dao: voteIntent.dao,
      action: String(input.action ?? "CAST_VOTE"),
      proposalId: voteIntent.proposalId,
      support: voteIntent.support,
      reason: normalizeReason(voteIntent.reason),
      voteIntentHash: voteIntentHash(voteIntent),
    },
  }));
}

/**
 * The stable identity of an execution intent across the whole system.
 *
 * Hashed: every field that decides what happens onchain, plus the governance
 * provenance that decides whether it is allowed to. Not hashed: anything a
 * provider or a retry invents. That split is what makes the hash usable at once
 * for deduplication, replay rejection, retry safety, audit correlation and
 * executor state keys.
 */
function executionIntentHash(intent) {
  const parsed = executionIntentSchema.parse(intent);
  return domainHash(EXECUTION_INTENT_DOMAIN, [
    parsed.version,
    parsed.chainId,
    getAddress(parsed.actor),
    getAddress(parsed.target),
    parsed.value,
    parsed.data.toLowerCase(),
    parsed.operation,
    parsed.source.type,
    parsed.source.dao,
    parsed.source.action,
    parsed.source.proposalId,
    parsed.source.support,
    parsed.source.reason,
    parsed.source.voteIntentHash,
  ]);
}

/** The 4-byte selector the intent will actually invoke, read from the calldata
 * rather than taken on trust from a caller. */
function executionIntentSelector(intent) {
  return selectorOf(executionIntentSchema.parse(intent).data);
}

module.exports = {
  EXECUTION_INTENT_DOMAIN,
  createExecutionIntent,
  executionIntentHash,
  executionIntentSelector,
};
