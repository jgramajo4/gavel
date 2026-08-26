const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertNoTemporalLeakage,
  chronologicalHoldouts,
} = require("../src/core/backtest/chronology");

function record(id, blockNumber, outcome = "EXECUTED") {
  return {
    blockNumber: String(blockNumber),
    proposalId: String(id),
    proposal: { outcome },
    source: { entityId: `vote-${id}` },
  };
}

test("chronological holdouts contain only strictly earlier votes", () => {
  const votes = [record(3, 30), record(1, 10), record(2, 20), record(4, 30)];
  const holdouts = chronologicalHoldouts(votes, { minTrainingVotes: 1 });

  assert.deepEqual(
    holdouts.map(({ target, training }) => ({
      target: target.proposalId,
      training: training.map((vote) => vote.proposalId),
    })),
    [
      { target: "2", training: ["1"] },
      { target: "3", training: ["1", "2"] },
      { target: "4", training: ["1", "2"] },
    ],
  );
});

test("the held-out vote and future outcomes cannot leak into training", () => {
  const target = record(2, 20, "DEFEATED");
  const future = record(3, 30, "EXECUTED");
  const [{ training }] = chronologicalHoldouts([record(1, 10), target, future], {
    minTrainingVotes: 1,
  });

  assert.ok(!training.includes(target));
  assert.ok(!training.includes(future));
  assert.ok(!training.some((vote) => vote.proposal.outcome === "DEFEATED"));
});

test("temporal leakage assertion rejects same-block and future evidence", () => {
  const target = record(2, 20);
  assert.throws(() => assertNoTemporalLeakage([record(1, 20)], target), /Temporal leakage/);
  assert.throws(() => assertNoTemporalLeakage([record(3, 30)], target), /Temporal leakage/);
});
