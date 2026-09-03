const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const {
  DEFAULT_ETHEREUM_RPC_URL,
  createEthereumProvider,
} = require("../../packages/nouns-adapter");

const ROOT = path.resolve(__dirname, "..");
const REFERENCES = path.join(ROOT, "references");

const ADDRESSES = {
  AUCTION_HOUSE: "0x830BD73E4184ceF73443C15111a1DF14e495C706",
  GOVERNANCE: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d",
  NOUNS_TOKEN: "0x9C8fF314C9Bc7F6e59A9d9225Fb22946427eDC03",
  REWARDS: "0x883860178f95d0c82413edc1d6de530cb4771d55",
};

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function getConfig() {
  const configPath = path.join(ROOT, "config.json");
  return readJson(configPath);
}

function getClientId() {
  const config = getConfig();
  const clientId = Number(config.clientId);
  if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) {
    throw new Error("config.json must include uint32 clientId");
  }
  return clientId >>> 0;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function getRpcUrl(env = process.env) {
  return env.ETHEREUM_RPC_URL || DEFAULT_ETHEREUM_RPC_URL;
}

function getProvider() {
  return createEthereumProvider();
}

function getSigner() {
  const provider = getProvider();
  const privateKey = requireEnv("AGENT_PRIVATE_KEY");
  return new ethers.Wallet(privateKey, provider);
}

function getAbi(fileName) {
  const filePath = path.join(REFERENCES, fileName);
  return readJson(filePath);
}

function getContract(address, abiFileName, signerOrProvider) {
  const abi = getAbi(abiFileName);
  return new ethers.Contract(address, abi, signerOrProvider);
}

function parseEth(value) {
  return ethers.parseEther(value);
}

function formatEth(value) {
  return ethers.formatEther(value);
}

function decodeBase64Json(base64Data) {
  const jsonText = Buffer.from(base64Data, "base64").toString("utf8");
  return JSON.parse(jsonText);
}

function decodeTokenUri(tokenUri) {
  const prefix = "data:application/json;base64,";
  if (!tokenUri.startsWith(prefix)) {
    throw new Error("Unexpected tokenURI format");
  }
  const base64 = tokenUri.slice(prefix.length);
  return decodeBase64Json(base64);
}

function safeNumber(value) {
  if (value == null) return null;
  return typeof value === "bigint" ? Number(value) : Number(value);
}

async function getMinBid(auctionContract) {
  const [auction, reservePrice, minBidIncrementPercentage] = await Promise.all([
    auctionContract.auction(),
    auctionContract.reservePrice(),
    auctionContract.minBidIncrementPercentage(),
  ]);

  const currentAmount = auction.amount;
  if (currentAmount > 0n) {
    return (
      currentAmount + (currentAmount * BigInt(minBidIncrementPercentage)) / 100n
    );
  }
  return reservePrice;
}

module.exports = {
  ADDRESSES,
  DEFAULT_ETHEREUM_RPC_URL,
  getConfig,
  getClientId,
  getRpcUrl,
  getProvider,
  getSigner,
  getAbi,
  getContract,
  parseEth,
  formatEth,
  decodeTokenUri,
  safeNumber,
  getMinBid,
};
