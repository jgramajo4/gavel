#!/usr/bin/env node

/**
 * Cast a refundable governance vote with reason (clientId-aware).
 *
 * Env:
 *  - ETHEREUM_RPC_URL (optional advanced override)
 *  - AGENT_PRIVATE_KEY (required)
 *  - MAX_FEE_PER_GAS_GWEI (optional)
 *  - MAX_PRIORITY_FEE_PER_GAS_GWEI (optional)
 *
 * Usage:
 *  node scripts/cast_vote.js <proposalId> <support> [reason]
 *    support: 0=Against, 1=For, 2=Abstain
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getProvider } = require("./_utils");

const GOVERNANCE_ADDRESS = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getEnv(name, required = false) {
  const value = process.env[name];
  if (required && (!value || value.trim() === "")) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseGwei(name) {
  const val = process.env[name];
  if (!val) return null;
  return ethers.parseUnits(val, "gwei");
}

async function main() {
  const proposalId = process.argv[2];
  const supportRaw = process.argv[3];
  const reason = process.argv.slice(4).join(" ") || "Vote cast by Bankr agent";

  if (!proposalId || !supportRaw) {
    throw new Error(
      "Usage: node scripts/cast_vote.js <proposalId> <support> [reason]",
    );
  }

  const support = Number(supportRaw);
  if (![0, 1, 2].includes(support)) {
    throw new Error("Support must be 0 (Against), 1 (For), or 2 (Abstain)");
  }

  const privateKey = getEnv("AGENT_PRIVATE_KEY", true);

  const rootDir = path.resolve(__dirname, "..");
  const abiPath = path.join(rootDir, "references", "governance-abi.json");
  const configPath = path.join(rootDir, "config.json");
  const governanceAbi = readJson(abiPath);
  const config = readJson(configPath);

  const clientId = Number(config.clientId);
  if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) {
    throw new Error("clientId in config.json must be a uint32");
  }
  const clientIdUint32 = clientId >>> 0;

  const provider = getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const governance = new ethers.Contract(
    GOVERNANCE_ADDRESS,
    governanceAbi,
    wallet,
  );

  const state = await governance.state(proposalId);
  if (Number(state) !== 1) {
    throw new Error(
      `Proposal ${proposalId} is not Active (state=${state}). Refusing to vote.`,
    );
  }

  const receipt = await governance.getReceipt(proposalId, wallet.address);
  if (receipt && receipt.hasVoted) {
    throw new Error(
      `Address ${wallet.address} already voted on proposal ${proposalId}`,
    );
  }

  const overrides = {};
  const maxFeePerGas = parseGwei("MAX_FEE_PER_GAS_GWEI");
  const maxPriorityFeePerGas = parseGwei("MAX_PRIORITY_FEE_PER_GAS_GWEI");
  if (maxFeePerGas) overrides.maxFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas) {
    overrides.maxPriorityFeePerGas = maxPriorityFeePerGas;
  }

  const tx = await governance.castRefundableVoteWithReason(
    proposalId,
    support,
    reason,
    clientIdUint32,
    overrides,
  );

  console.log("txHash:", tx.hash);
  const receiptTx = await tx.wait();
  console.log("status:", receiptTx.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
