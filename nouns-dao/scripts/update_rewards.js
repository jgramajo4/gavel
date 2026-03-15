#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const REWARDS_CONTRACT_ADDRESS = "0x883860178f95d0c82413edc1d6de530cb4771d55";
const ABI_PATH = path.resolve(__dirname, "..", "references", "rewards-abi.json");
const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getArgValue(flag) {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function parseUint32(value, label) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
    throw new Error(`${label} must fit in uint32`);
  }
  return num >>> 0;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/update_rewards.js --last-proposal-id <uint32> --voting-client-ids <id1,id2,...>",
      "",
      "Env:",
      "  ETHEREUM_RPC_URL   Mainnet RPC endpoint",
      "  AGENT_PRIVATE_KEY  Signer private key",
    ].join("\n"),
  );
}

async function main() {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  const privateKey = process.env.AGENT_PRIVATE_KEY;

  const lastProposalIdArg = getArgValue("--last-proposal-id");
  const votingClientIdsArg = getArgValue("--voting-client-ids");

  if (!rpcUrl || !privateKey) {
    console.error("Missing ETHEREUM_RPC_URL or AGENT_PRIVATE_KEY in env.");
    usage();
    process.exit(1);
  }

  if (!lastProposalIdArg || !votingClientIdsArg) {
    console.error("Missing required arguments.");
    usage();
    process.exit(1);
  }

  const lastProposalId = parseUint32(lastProposalIdArg, "lastProposalId");

  const votingClientIds = votingClientIdsArg
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value, index) => parseUint32(value, `votingClientIds[${index}]`));

  if (votingClientIds.length === 0) {
    throw new Error("votingClientIds must include at least one uint32 value");
  }

  const config = readJson(CONFIG_PATH);
  const clientId = Number(config.clientId);
  if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) {
    throw new Error("clientId in config.json must be a uint32");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const rewardsAbi = readJson(ABI_PATH);
  const contract = new ethers.Contract(
    REWARDS_CONTRACT_ADDRESS,
    rewardsAbi,
    wallet,
  );

  console.log(
    `Updating rewards for proposals up to ${lastProposalId} with clientIds [${votingClientIds.join(
      ", ",
    )}]`,
  );

  const tx = await contract.updateRewardsForProposalWritingAndVoting(
    lastProposalId,
    votingClientIds,
  );

  console.log(`Submitted tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
