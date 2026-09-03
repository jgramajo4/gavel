const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JsonRpcProvider } = require("ethers");

const { NounsVotePreparationAdapter } = require("../packages/nouns-adapter/src/vote");

const configured = Boolean(
  process.env.MAINNET_FORK_RPC_URL &&
  process.env.GAVEL_FORK_PREDICTION &&
  process.env.GAVEL_FORK_PROPOSAL &&
  process.env.GAVEL_FORK_VOTING_ADDRESS,
);

function fixture(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

test("mainnet fork: prepares a canonical unsigned vote and fails closed on local drift", { skip: !configured }, async () => {
  const provider = new JsonRpcProvider(process.env.MAINNET_FORK_RPC_URL, 1, { staticNetwork: false });
  const adapter = new NounsVotePreparationAdapter({ provider });
  const prediction = fixture(process.env.GAVEL_FORK_PREDICTION);
  const proposalInput = fixture(process.env.GAVEL_FORK_PROPOSAL);
  const proposal = proposalInput.proposal || proposalInput;
  const input = {
    prediction,
    proposal,
    selectedSupport: prediction.recommendation,
    votingAddress: process.env.GAVEL_FORK_VOTING_ADDRESS,
    reason: process.env.GAVEL_FORK_REASON || "Deterministic Gavel mainnet-fork validation",
    acknowledgeSecurityReview: true,
    acknowledgePredictionReview: true,
  };

  const ready = await adapter.prepare(input);
  assert.equal(ready.status, "READY_TO_SIGN");
  assert.equal(ready.verification.freshness.verifiedFromCanonicalEvents, true);
  assert.equal(ready.verification.freshness.descriptionMatches, true);
  assert.equal(ready.verification.simulation.succeeded, true);
  assert.equal(ready.transaction.kind, "UNSIGNED_EVM_TRANSACTION");

  const stale = await adapter.prepare({ ...input, proposal: { ...proposal, description: `${proposal.description}\nlocal drift` } });
  assert.equal(stale.status, "BLOCKED");
  assert.ok(stale.blockers.some((blocker) => blocker.code === "PROPOSAL_DESCRIPTION_STALE"));

  const noPower = await adapter.prepare({ ...input, votingAddress: "0x0000000000000000000000000000000000000001" });
  assert.equal(noPower.status, "BLOCKED");
  assert.ok(noPower.blockers.some((blocker) => blocker.code === "NO_SNAPSHOT_VOTING_POWER"));
});
