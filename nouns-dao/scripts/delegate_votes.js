#!/usr/bin/env node

/**
 * Delegate Nouns voting power to a delegatee address.
 *
 * Env:
 *  - ETHEREUM_RPC_URL (optional advanced override)
 *  - AGENT_PRIVATE_KEY (required)
 *
 * Usage:
 *  node scripts/delegate_votes.js <delegatee>
 *  node scripts/delegate_votes.js --to <delegatee>
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getProvider } = require("./_utils");

const NOUNS_TOKEN_ADDRESS = "0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03";

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

function getArgValue(flag) {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

async function main() {
  const delegateeArg = process.argv[2];
  const delegateeFlag = getArgValue("--to");
  const delegatee = delegateeFlag || delegateeArg;

  if (!delegatee) {
    throw new Error("Usage: node scripts/delegate_votes.js <delegatee> or --to <delegatee>");
  }

  const privateKey = getEnv("AGENT_PRIVATE_KEY", true);

  if (!ethers.isAddress(delegatee)) {
    throw new Error(`Invalid delegatee address: ${delegatee}`);
  }

  const rootDir = path.resolve(__dirname, "..");
  const abiPath = path.join(rootDir, "references", "nouns-token-abi.json");
  const nounsTokenAbi = readJson(abiPath);

  const provider = getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const nounsToken = new ethers.Contract(
    NOUNS_TOKEN_ADDRESS,
    nounsTokenAbi,
    wallet
  );

  console.log(`Delegating votes from ${wallet.address} to ${delegatee}...`);

  const tx = await nounsToken.delegate(delegatee);
  console.log(`Tx sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Tx confirmed in block ${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
