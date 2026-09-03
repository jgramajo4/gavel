const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getProvider } = require("./_utils");

const AUCTION_HOUSE_PROXY = "0x830BD73E4184ceF73443C15111a1DF14e495C706";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const privateKey = getEnv("AGENT_PRIVATE_KEY");

  const provider = getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);

  const abiPath = path.join(__dirname, "..", "references", "auction-abi.json");
  const auctionAbi = readJson(abiPath);
  const auctionHouse = new ethers.Contract(AUCTION_HOUSE_PROXY, auctionAbi, wallet);

  const auction = await auctionHouse.auction();
  const now = Math.floor(Date.now() / 1000);

  if (auction.settled) {
    console.log("Auction already settled.");
    console.log({ nounId: auction.nounId.toString(), endTime: auction.endTime.toString() });
    return;
  }

  if (now < Number(auction.endTime)) {
    console.log("Auction has not ended yet.");
    console.log({
      nounId: auction.nounId.toString(),
      endTime: auction.endTime.toString(),
      now,
    });
    return;
  }

  console.log("Settling auction...", {
    nounId: auction.nounId.toString(),
    endTime: auction.endTime.toString(),
  });

  try {
    const tx = await auctionHouse.settleCurrentAndCreateNewAuction();
    console.log("Sent settleCurrentAndCreateNewAuction tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("Settlement confirmed in block:", receipt.blockNumber);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log("settleCurrentAndCreateNewAuction failed, trying settleAuction...", message);

    const tx = await auctionHouse.settleAuction();
    console.log("Sent settleAuction tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("Settlement confirmed in block:", receipt.blockNumber);
  }
}

main().catch((err) => {
  console.error("Settlement script failed:", err);
  process.exit(1);
});
