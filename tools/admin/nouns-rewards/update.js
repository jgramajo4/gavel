#!/usr/bin/env node

const { getAdminContract, getArg, parseUint32 } = require("./_shared");

async function main() {
  const lastProposalId = parseUint32(getArg("--last-proposal-id"), "lastProposalId");
  const clientIdsRaw = getArg("--voting-client-ids");
  if (!clientIdsRaw) throw new Error("Missing --voting-client-ids");
  const votingClientIds = clientIdsRaw
    .split(",")
    .map((value, index) => parseUint32(value.trim(), `votingClientIds[${index}]`));
  if (votingClientIds.length === 0) throw new Error("At least one voting client ID is required");

  const { contract } = await getAdminContract();
  const tx = await contract.updateRewardsForProposalWritingAndVoting(
    lastProposalId,
    votingClientIds,
  );
  process.stdout.write(`${JSON.stringify({ submitted: true, txHash: tx.hash })}\n`);
  const receipt = await tx.wait();
  process.stdout.write(
    `${JSON.stringify({ confirmed: receipt.status === 1, blockNumber: receipt.blockNumber })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`gavel rewards admin: ${error.message || error}\n`);
  process.exitCode = 1;
});
