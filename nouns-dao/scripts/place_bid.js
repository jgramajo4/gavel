#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getProvider } = require("./_utils");

const AUCTION_HOUSE = "0x830BD73E4184ceF73443C15111a1DF14e495C706";

function loadJson(relativePath) {
  const fullPath = path.resolve(__dirname, "..", relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function getEnv(name, fallback = null) {
  return process.env[name] ?? fallback;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--amount-wei") {
      args.amountWei = argv[i + 1];
      i++;
    } else if (a === "--amount-eth") {
      args.amountEth = argv[i + 1];
      i++;
    } else if (a === "--noun-id") {
      args.nounId = argv[i + 1];
      i++;
    }
  }
  return args;
}

function toBigInt(value, label) {
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

async function main() {
  const privateKey = getEnv("AGENT_PRIVATE_KEY");
  if (!privateKey) {
    throw new Error("Missing AGENT_PRIVATE_KEY.");
  }

  const config = loadJson("config.json");
  const clientId = Number(config.clientId);
  if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) {
    throw new Error("clientId in config.json must be a uint32");
  }
  const clientIdUint32 = clientId >>> 0;

  const auctionAbi = loadJson("references/auction-abi.json");

  const provider = getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const auction = new ethers.Contract(AUCTION_HOUSE, auctionAbi, wallet);

  const args = parseArgs(process.argv.slice(2));

  let bidAmountWei;
  if (args.amountWei) {
    bidAmountWei = toBigInt(args.amountWei, "amountWei");
  } else if (args.amountEth) {
    bidAmountWei = ethers.parseEther(args.amountEth);
  } else if (getEnv("BID_AMOUNT_WEI")) {
    bidAmountWei = toBigInt(getEnv("BID_AMOUNT_WEI"), "BID_AMOUNT_WEI");
  } else if (getEnv("BID_AMOUNT_ETH")) {
    bidAmountWei = ethers.parseEther(getEnv("BID_AMOUNT_ETH"));
  } else {
    throw new Error(
      "Bid amount not provided. Use --amount-wei, --amount-eth, BID_AMOUNT_WEI, or BID_AMOUNT_ETH.",
    );
  }

  const initialAuction = await auction.auction();
  const {
    nounId: initialNounId,
    amount: currentAmount,
    endTime,
    settled,
  } = initialAuction;

  if (settled) {
    throw new Error("Auction already settled.");
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now >= endTime) {
    throw new Error("Auction has ended.");
  }

  if (initialNounId % 10n === 0n) {
    throw new Error(
      `Noun ${initialNounId} is a Nounders' noun (multiple of 10) and is not auctioned.`,
    );
  }

  const reservePrice = await auction.reservePrice();
  const minBidIncrementPercentage = await auction.minBidIncrementPercentage();

  const minBid =
    currentAmount > 0n
      ? currentAmount +
        (currentAmount * BigInt(minBidIncrementPercentage)) / 100n
      : reservePrice;

  if (bidAmountWei < minBid) {
    throw new Error(
      `Bid too low. Minimum bid is ${ethers.formatEther(minBid)} ETH.`,
    );
  }

  // Re-fetch auction just before broadcasting to avoid stale state.
  const latestAuction = await auction.auction();
  if (
    latestAuction.settled ||
    latestAuction.nounId !== initialNounId ||
    BigInt(Math.floor(Date.now() / 1000)) >= latestAuction.endTime
  ) {
    throw new Error("Auction state changed. Re-run to bid with latest state.");
  }

  const maxFeeGwei = getEnv("MAX_FEE_GWEI");
  const maxPriorityFeeGwei = getEnv("MAX_PRIORITY_FEE_GWEI");

  const txOverrides = {
    value: bidAmountWei,
  };

  if (maxFeeGwei) {
    txOverrides.maxFeePerGas = ethers.parseUnits(maxFeeGwei, "gwei");
  }
  if (maxPriorityFeeGwei) {
    txOverrides.maxPriorityFeePerGas = ethers.parseUnits(
      maxPriorityFeeGwei,
      "gwei",
    );
  }

  const nounIdToBid = args.nounId
    ? toBigInt(args.nounId, "nounId")
    : latestAuction.nounId;

  if (nounIdToBid !== latestAuction.nounId) {
    throw new Error(
      `Provided nounId ${nounIdToBid} does not match current auction nounId ${latestAuction.nounId}.`,
    );
  }

  console.log(
    `Placing bid on Noun ${nounIdToBid} with ${ethers.formatEther(
      bidAmountWei,
    )} ETH (clientId=${clientIdUint32})...`,
  );

  const tx = await auction.createBid(nounIdToBid, clientIdUint32, txOverrides);
  console.log(`Tx sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Tx confirmed in block ${receipt.blockNumber}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
