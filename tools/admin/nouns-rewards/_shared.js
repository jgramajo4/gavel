const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const REWARDS_ADDRESS = "0x883860178f95d0c82413edc1d6de530cb4771d55";

function requireAdminMode() {
  if (process.env.GAVEL_ADMIN_MODE !== "1") {
    throw new Error(
      "Builder-only operation refused. Set GAVEL_ADMIN_MODE=1 explicitly to use rewards administration.",
    );
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseUint32(value, label) {
  if (!/^\d+$/.test(value || "")) throw new Error(`${label} must be an unsigned integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 0xffffffff) {
    throw new Error(`${label} must fit in uint32`);
  }
  return parsed;
}

function getArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

async function getAdminContract() {
  requireAdminMode();
  const provider = new ethers.JsonRpcProvider(requireEnv("ETHEREUM_RPC_URL"));
  const network = await provider.getNetwork();
  if (network.chainId !== 1n) {
    throw new Error(`Rewards administration requires Ethereum mainnet (chainId 1), got ${network.chainId}`);
  }
  const wallet = new ethers.Wallet(requireEnv("AGENT_PRIVATE_KEY"), provider);
  const abi = readJson(path.join(REPOSITORY_ROOT, "nouns-dao", "references", "rewards-abi.json"));
  const config = readJson(path.join(REPOSITORY_ROOT, "nouns-dao", "config.json"));
  const clientId = parseUint32(String(config.clientId), "config.clientId");
  return {
    clientId,
    contract: new ethers.Contract(REWARDS_ADDRESS, abi, wallet),
  };
}

module.exports = {
  ethers,
  getAdminContract,
  getArg,
  parseUint32,
  requireAdminMode,
};
