#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const REWARDS_CONTRACT_ADDRESS = "0x883860178f95d0c82413edc1d6de530cb4771d55";
const ABI_PATH = path.resolve(
  __dirname,
  "..",
  "references",
  "rewards-abi.json",
);
const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getArgValue(flag) {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node withdraw_rewards.js --to <address> (--amount-wei <wei> | --amount-eth <eth>)",
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
  const to = getArgValue("--to");
  const amountWei = getArgValue("--amount-wei");
  const amountEth = getArgValue("--amount-eth");

  if (!rpcUrl || !privateKey) {
    console.error("Missing ETHEREUM_RPC_URL or AGENT_PRIVATE_KEY in env.");
    usage();
    process.exit(1);
  }

  if (!to || (!amountWei && !amountEth)) {
    console.error("Missing required arguments.");
    usage();
    process.exit(1);
  }

  const config = readJson(CONFIG_PATH);
  const clientId = Number(config.clientId);
  if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) {
    console.error("Invalid clientId in config.json.");
    process.exit(1);
  }
  const clientIdUint32 = clientId >>> 0;

  let amount;
  if (amountWei) {
    if (!/^\d+$/.test(amountWei)) {
      console.error("Invalid --amount-wei (must be an integer string).");
      process.exit(1);
    }
    amount = ethers.BigNumber
      ? ethers.BigNumber.from(amountWei)
      : BigInt(amountWei);
  } else {
    amount = ethers.parseEther
      ? ethers.parseEther(amountEth)
      : ethers.utils.parseEther(amountEth);
  }

  const provider = ethers.JsonRpcProvider
    ? new ethers.JsonRpcProvider(rpcUrl)
    : new ethers.providers.JsonRpcProvider(rpcUrl);

  const wallet = new ethers.Wallet(privateKey, provider);

  const rewardsAbi = readJson(ABI_PATH);
  const contract = new ethers.Contract(
    REWARDS_CONTRACT_ADDRESS,
    rewardsAbi,
    wallet,
  );

  console.log(
    `Withdrawing rewards: clientId=${clientIdUint32}, to=${to}, amount=${amount.toString()}`,
  );

  const tx = await contract.withdrawClientBalance(clientIdUint32, to, amount);
  console.log(`Submitted tx: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
