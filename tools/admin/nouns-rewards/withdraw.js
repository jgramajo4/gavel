#!/usr/bin/env node

const { ethers, getAdminContract, getArg } = require("./_shared");

async function main() {
  const to = getArg("--to");
  const amountWei = getArg("--amount-wei");
  const amountEth = getArg("--amount-eth");
  if (!to || !ethers.isAddress(to)) throw new Error("A valid --to address is required");
  if (Boolean(amountWei) === Boolean(amountEth)) {
    throw new Error("Provide exactly one of --amount-wei or --amount-eth");
  }
  if (amountWei && !/^\d+$/.test(amountWei)) throw new Error("--amount-wei must be an integer");
  const amount = amountWei ? BigInt(amountWei) : ethers.parseEther(amountEth);
  if (amount <= 0n) throw new Error("Withdrawal amount must be positive");

  const { clientId, contract } = await getAdminContract();
  const tx = await contract.withdrawClientBalance(clientId, ethers.getAddress(to), amount);
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
