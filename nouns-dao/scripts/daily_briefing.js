#!/usr/bin/env node

/**
 * Daily governance briefing for Nouns DAO.
 *
 * Read-only digest that composes the live auction state and the set of
 * Active governance proposals into a single summary an agent can post each
 * morning. Never signs or sends a transaction — it only needs an RPC URL.
 *
 * Environment:
 *   ETHEREUM_RPC_URL (required)
 *   VOTER_ADDRESS    (optional) — annotate each Active proposal with whether
 *                                 this address has already voted
 *
 * Usage:
 *   node daily_briefing.js [--limit=10] [--voter=0xabc...] [--ending-soon-blocks=6500]
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const AUCTION_ADDRESS = "0x830BD73E4184ceF73443C15111a1DF14e495C706";
const GOVERNANCE_ADDRESS = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";

const REFERENCES = path.resolve(__dirname, "..", "references");

// ~12s blocks → ~7200/day. Default flags proposals ending within ~1 day.
const DEFAULT_ENDING_SOON_BLOCKS = 6500;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getArgValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return fallback;
  return arg.slice(prefix.length);
}

function num(value) {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function str(value) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function formatEth(wei) {
  try {
    return ethers.formatEther(wei);
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  if (seconds == null) return null;
  const sign = seconds < 0 ? "-" : "";
  let s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  return `${sign}${h}h ${m}m`;
}

async function buildAuctionSection(provider, nowSeconds) {
  const abi = readJson(path.join(REFERENCES, "auction-abi.json"));
  const auctionContract = new ethers.Contract(AUCTION_ADDRESS, abi, provider);

  const [auction, reservePrice, minIncrementPct, timeBuffer] = await Promise.all([
    auctionContract.auction(),
    auctionContract.reservePrice(),
    auctionContract.minBidIncrementPercentage(),
    auctionContract.timeBuffer(),
  ]);

  const nounId = num(auction.nounId);
  const amount = auction.amount;
  const endTime = num(auction.endTime);
  const settled = Boolean(auction.settled);
  const hasBid = amount > 0n;

  const secondsRemaining = endTime - nowSeconds;
  const live = !settled && secondsRemaining > 0;
  const needsSettlement = !settled && secondsRemaining <= 0;

  const minNextBidWei = hasBid
    ? amount + (amount * BigInt(minIncrementPct)) / 100n
    : reservePrice;

  return {
    contract: AUCTION_ADDRESS,
    nounId,
    isNoundersNoun: nounId % 10 === 0, // every 10th Noun is not auctioned
    highBidWei: amount.toString(),
    highBidEth: formatEth(amount),
    bidder: hasBid ? auction.bidder : null,
    endTime,
    secondsRemaining,
    timeRemaining: formatDuration(secondsRemaining),
    status: settled ? "settled" : live ? "live" : "ended",
    live,
    needsSettlement,
    minNextBidWei: minNextBidWei.toString(),
    minNextBidEth: formatEth(minNextBidWei),
    minBidIncrementPercentage: num(minIncrementPct),
    timeBufferSeconds: num(timeBuffer),
  };
}

async function buildGovernanceSection(provider, options) {
  const { limit, voter, endingSoonBlocks } = options;
  const abi = readJson(path.join(REFERENCES, "governance-abi.json"));
  const governance = new ethers.Contract(GOVERNANCE_ADDRESS, abi, provider);

  const [proposalCount, currentBlock] = await Promise.all([
    governance.proposalCount(),
    provider.getBlockNumber(),
  ]);
  const total = num(proposalCount);

  const active = [];
  for (let id = total; id >= 1; id -= 1) {
    const state = num(await governance.state(id));
    if (state !== 1) continue; // 1 = Active

    const proposal = await governance.proposals(id);
    const endBlock = num(proposal.endBlock);
    const blocksRemaining = endBlock - currentBlock;

    const entry = {
      id: str(proposal.id),
      proposer: proposal.proposer,
      forVotes: str(proposal.forVotes),
      againstVotes: str(proposal.againstVotes),
      abstainVotes: str(proposal.abstainVotes),
      quorumVotes: str(proposal.quorumVotes),
      endBlock,
      blocksRemaining,
      approxHoursRemaining: Math.round((blocksRemaining * 12) / 360) / 10,
      endingSoon: blocksRemaining > 0 && blocksRemaining <= endingSoonBlocks,
    };

    if (voter) {
      const receipt = await governance.getReceipt(id, voter);
      entry.voter = {
        address: voter,
        hasVoted: Boolean(receipt.hasVoted),
        support: receipt.hasVoted ? num(receipt.support) : null,
      };
    }

    active.push(entry);
    if (limit && active.length >= limit) break;
  }

  return {
    contract: GOVERNANCE_ADDRESS,
    currentBlock,
    proposalCount: total,
    activeCount: active.length,
    proposals: active,
  };
}

function buildHeadlines(auction, governance) {
  const lines = [];

  if (auction.isNoundersNoun) {
    lines.push(`Noun ${auction.nounId} is a Nounders' Noun — not auctioned.`);
  } else if (auction.needsSettlement) {
    lines.push(
      `Noun ${auction.nounId} auction has ended (${auction.timeRemaining}) and is unsettled — settle to start the next one.`
    );
  } else if (auction.live) {
    const bid = auction.highBidEth ? `${auction.highBidEth} ETH` : "no bids yet";
    lines.push(
      `Noun ${auction.nounId} auction is live: ${bid}, ${auction.timeRemaining} left ` +
        `(min next bid ${auction.minNextBidEth} ETH).`
    );
  } else {
    lines.push(`Noun ${auction.nounId} auction is settled.`);
  }

  if (governance.activeCount === 0) {
    lines.push("No Active governance proposals.");
  } else {
    lines.push(
      `${governance.activeCount} Active proposal(s): ` +
        governance.proposals
          .map((p) => {
            const soon = p.endingSoon ? " (ending soon)" : "";
            const voted =
              p.voter && p.voter.hasVoted ? " (you voted)" : p.voter ? " (not voted)" : "";
            return `#${p.id} ${p.forVotes}F/${p.againstVotes}A/${p.abstainVotes}Ab${soon}${voted}`;
          })
          .join(", ")
    );
  }

  return lines;
}

async function main() {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) {
    console.error("Missing ETHEREUM_RPC_URL.");
    process.exit(1);
  }

  const limitArg = getArgValue("limit");
  const limit = limitArg ? Number(limitArg) : null;

  const voterArg = getArgValue("voter", process.env.VOTER_ADDRESS || null);
  const voter = voterArg ? ethers.getAddress(voterArg) : null;

  const endingSoonArg = getArgValue("ending-soon-blocks");
  const endingSoonBlocks = endingSoonArg
    ? Number(endingSoonArg)
    : DEFAULT_ENDING_SOON_BLOCKS;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const [auction, governance] = await Promise.all([
    buildAuctionSection(provider, nowSeconds),
    buildGovernanceSection(provider, { limit, voter, endingSoonBlocks }),
  ]);

  const output = {
    generatedAt: new Date().toISOString(),
    network: "mainnet",
    auction,
    governance,
    headlines: buildHeadlines(auction, governance),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
