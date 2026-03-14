#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const AUCTION_ADDRESS = "0x830BD73E4184ceF73443C15111a1DF14e495C706";

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function formatEth(wei) {
  try {
    return ethers.formatEther(wei);
  } catch {
    return null;
  }
}

async function main() {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) {
    throw new Error("Missing ETHEREUM_RPC_URL in environment.");
  }

  const abiPath = path.join(__dirname, "..", "references", "auction-abi.json");
  const auctionAbi = readJson(abiPath);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const auctionContract = new ethers.Contract(AUCTION_ADDRESS, auctionAbi, provider);

  const auction = await auctionContract.auction();
  const reservePrice = await auctionContract.reservePrice();
  const minBidIncrementPercentage = await auctionContract.minBidIncrementPercentage();
  const duration = await auctionContract.duration();
  const timeBuffer = await auctionContract.timeBuffer();

  const response = {
    contract: AUCTION_ADDRESS,
    auction: {
      nounId: auction.nounId.toString(),
      amountWei: auction.amount.toString(),
      amountEth: formatEth(auction.amount),
      startTime: Number(auction.startTime),
      endTime: Number(auction.endTime),
      bidder: auction.bidder,
      settled: Boolean(auction.settled),
    },
    config: {
      reservePriceWei: reservePrice.toString(),
      reservePriceEth: formatEth(reservePrice),
      minBidIncrementPercentage: Number(minBidIncrementPercentage),
      durationSeconds: Number(duration),
      timeBufferSeconds: Number(timeBuffer),
    },
    fetchedAt: new Date().toISOString(),
  };

  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
