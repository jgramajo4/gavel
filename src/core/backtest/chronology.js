function compareVotes(a, b) {
  const blockOrder = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  if (blockOrder < 0n) return -1;
  if (blockOrder > 0n) return 1;
  return a.source.entityId.localeCompare(b.source.entityId);
}

function assertNoTemporalLeakage(trainingVotes, targetVote) {
  const targetBlock = BigInt(targetVote.blockNumber);
  for (const vote of trainingVotes) {
    if (BigInt(vote.blockNumber) >= targetBlock) {
      throw new Error(
        `Temporal leakage: training vote ${vote.source.entityId} is not earlier than target ${targetVote.source.entityId}`,
      );
    }
  }
}

function toTrainingEvidence(vote) {
  // These proposal fields reflect the ingestion-time/final chain view, not
  // necessarily what was knowable when a later held-out vote was cast.
  const {
    state: _state,
    outcome: _outcome,
    forVotes: _forVotes,
    againstVotes: _againstVotes,
    abstainVotes: _abstainVotes,
    ...proposalKnownAtVote
  } = vote.proposal;
  return {
    ...vote,
    proposal: proposalKnownAtVote,
  };
}

function chronologicalHoldouts(votes, options = {}) {
  const minTrainingVotes = options.minTrainingVotes ?? 1;
  if (!Number.isInteger(minTrainingVotes) || minTrainingVotes < 0) {
    throw new RangeError("minTrainingVotes must be a non-negative integer");
  }

  const ordered = [...votes].sort(compareVotes);
  const holdouts = [];

  for (const target of ordered) {
    // Exclude the target, every vote from the same block, and all future votes.
    // Without transaction/log indexes, same-block ordering is not safe evidence.
    const training = ordered
      .filter((candidate) => BigInt(candidate.blockNumber) < BigInt(target.blockNumber))
      .map(toTrainingEvidence);
    if (training.length < minTrainingVotes) continue;
    assertNoTemporalLeakage(training, target);
    holdouts.push({ training, target });
  }

  return holdouts;
}

module.exports = {
  compareVotes,
  assertNoTemporalLeakage,
  toTrainingEvidence,
  chronologicalHoldouts,
};
