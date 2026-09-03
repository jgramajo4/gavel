#!/usr/bin/env node

/**
 * Daily governance briefing for Nouns DAO.
 *
 * Read-only digest that composes the live auction state, the set of Active
 * governance proposals, and what has *changed* since the last briefing (bids,
 * settlements, new auctions, new proposals, and votes cast over a recent block
 * window) into a single summary an agent can post each morning. Never signs or
 * sends a transaction — it only needs an RPC URL.
 *
 * Environment:
 *   ETHEREUM_RPC_URL (optional advanced override)
 *   VOTER_ADDRESS    (optional) — annotate each Active proposal with whether
 *                                 this address has already voted
 *
 * Usage:
 *   node daily_briefing.js [--limit=10] [--voter=0xabc...]
 *                          [--since-hours=24] [--since-blocks=7200]
 *                          [--ending-soon-blocks=6500]
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getProvider } = require("./_utils");

const AUCTION_ADDRESS = "0x830BD73E4184ceF73443C15111a1DF14e495C706";
const GOVERNANCE_ADDRESS = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";

const REFERENCES = path.resolve(__dirname, "..", "references");

const SECONDS_PER_BLOCK = 12; // mainnet post-merge target
// ~12s blocks → ~7200/day. Default flags proposals ending within ~1 day.
const DEFAULT_ENDING_SOON_BLOCKS = 6500;
// Default change window — what happened in roughly the last 24h.
const DEFAULT_SINCE_HOURS = 24;
// How many of the most recent proposals to inspect when detecting new ones.
const RECENT_PROPOSAL_SCAN = 20;

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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function buildAuctionSection(auctionContract, nowSeconds) {
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

async function buildGovernanceSection(governanceContract, options) {
  const { limit, voter, endingSoonBlocks, currentBlock, proposalCount } = options;
  const total = proposalCount;

  const active = [];
  for (let id = total; id >= 1; id -= 1) {
    const state = num(await governanceContract.state(id));
    if (state !== 1) continue; // 1 = Active

    const proposal = await governanceContract.proposals(id);
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
      approxHoursRemaining:
        Math.round((blocksRemaining * SECONDS_PER_BLOCK) / 360) / 10,
      endingSoon: blocksRemaining > 0 && blocksRemaining <= endingSoonBlocks,
    };

    if (voter) {
      const receipt = await governanceContract.getReceipt(id, voter);
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

const SUPPORT_LABEL = { 0: "against", 1: "for", 2: "abstain" };

async function buildChangesSection(contracts, options) {
  const { auctionContract, governanceContract } = contracts;
  const { fromBlock, toBlock, sinceTimestamp, proposalCount } = options;

  // Auction activity from event logs over the window.
  const [bidLogs, createdLogs, settledLogs] = await Promise.all([
    auctionContract.queryFilter(auctionContract.filters.AuctionBid(), fromBlock, toBlock),
    auctionContract.queryFilter(auctionContract.filters.AuctionCreated(), fromBlock, toBlock),
    auctionContract.queryFilter(auctionContract.filters.AuctionSettled(), fromBlock, toBlock),
  ]);

  const bids = bidLogs.map((log) => ({
    nounId: num(log.args.nounId),
    bidder: log.args.sender,
    valueWei: log.args.value.toString(),
    valueEth: formatEth(log.args.value),
    extended: Boolean(log.args.extended),
    blockNumber: log.blockNumber,
  }));

  const newAuctions = createdLogs.map((log) => ({
    nounId: num(log.args.nounId),
    startTime: num(log.args.startTime),
    endTime: num(log.args.endTime),
    blockNumber: log.blockNumber,
  }));

  const settlements = settledLogs.map((log) => {
    const winner = log.args.winner;
    return {
      nounId: num(log.args.nounId),
      winner: winner === ZERO_ADDRESS ? null : winner,
      burned: winner === ZERO_ADDRESS, // no bids → Noun burned on settlement
      amountWei: log.args.amount.toString(),
      amountEth: formatEth(log.args.amount),
      blockNumber: log.blockNumber,
    };
  });

  // Votes cast in the window, grouped per proposal.
  const voteLogs = await governanceContract.queryFilter(
    governanceContract.filters.VoteCast(),
    fromBlock,
    toBlock
  );
  const byProposal = new Map();
  for (const log of voteLogs) {
    const pid = str(log.args.proposalId);
    if (!byProposal.has(pid)) {
      byProposal.set(pid, { proposalId: pid, total: 0, for: 0, against: 0, abstain: 0 });
    }
    const bucket = byProposal.get(pid);
    bucket.total += 1;
    bucket[SUPPORT_LABEL[num(log.args.support)] || "abstain"] += 1;
  }
  const votes = {
    total: voteLogs.length,
    byProposal: Array.from(byProposal.values()),
  };

  // New proposals: bounded scan of the most recent ids, kept if created in window.
  const newProposals = [];
  const scanFloor = Math.max(1, proposalCount - RECENT_PROPOSAL_SCAN + 1);
  for (let id = proposalCount; id >= scanFloor; id -= 1) {
    const proposal = await governanceContract.proposals(id);
    const created = num(proposal.creationTimestamp);
    if (created >= sinceTimestamp) {
      newProposals.push({
        id: str(proposal.id),
        proposer: proposal.proposer,
        creationTimestamp: created,
        startBlock: num(proposal.startBlock),
        state: num(await governanceContract.state(id)),
      });
    }
  }

  return {
    window: { fromBlock, toBlock, sinceTimestamp },
    auction: { bids, newAuctions, settlements },
    governance: { newProposals, votes },
  };
}

function buildHeadlines(auction, governance, changes) {
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

  if (changes) {
    const a = changes.auction;
    const g = changes.governance;
    const burned = a.settlements.filter((s) => s.burned).length;
    const settledParts = a.settlements.length
      ? `${a.settlements.length} settled${burned ? ` (${burned} burned)` : ""}`
      : null;
    const segments = [
      a.bids.length ? `${a.bids.length} new bid(s)` : null,
      settledParts,
      g.newProposals.length ? `${g.newProposals.length} new proposal(s)` : null,
      g.votes.total
        ? `${g.votes.total} vote(s) across ${g.votes.byProposal.length} proposal(s)`
        : null,
    ].filter(Boolean);
    lines.push(
      segments.length
        ? `Since the last briefing: ${segments.join(", ")}.`
        : "Since the last briefing: no on-chain activity."
    );
  }

  return lines;
}

async function main() {

  const limitArg = getArgValue("limit");
  const limit = limitArg ? Number(limitArg) : null;

  const voterArg = getArgValue("voter", process.env.VOTER_ADDRESS || null);
  const voter = voterArg ? ethers.getAddress(voterArg) : null;

  const endingSoonArg = getArgValue("ending-soon-blocks");
  const endingSoonBlocks = endingSoonArg
    ? Number(endingSoonArg)
    : DEFAULT_ENDING_SOON_BLOCKS;

  const sinceHours = Number(getArgValue("since-hours", DEFAULT_SINCE_HOURS));
  const sinceBlocksArg = getArgValue("since-blocks");
  const sinceBlocks = sinceBlocksArg
    ? Number(sinceBlocksArg)
    : Math.round((sinceHours * 3600) / SECONDS_PER_BLOCK);

  const provider = getProvider();
  const auctionAbi = readJson(path.join(REFERENCES, "auction-abi.json"));
  const governanceAbi = readJson(path.join(REFERENCES, "governance-abi.json"));
  const auctionContract = new ethers.Contract(AUCTION_ADDRESS, auctionAbi, provider);
  const governanceContract = new ethers.Contract(GOVERNANCE_ADDRESS, governanceAbi, provider);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const [currentBlock, proposalCount] = await Promise.all([
    provider.getBlockNumber(),
    governanceContract.proposalCount().then(num),
  ]);

  const fromBlock = Math.max(0, currentBlock - sinceBlocks);
  const sinceTimestamp = nowSeconds - sinceHours * 3600;

  const [auction, governance, changes] = await Promise.all([
    buildAuctionSection(auctionContract, nowSeconds),
    buildGovernanceSection(governanceContract, {
      limit,
      voter,
      endingSoonBlocks,
      currentBlock,
      proposalCount,
    }),
    buildChangesSection(
      { auctionContract, governanceContract },
      { fromBlock, toBlock: currentBlock, sinceTimestamp, proposalCount }
    ),
  ]);

  const output = {
    generatedAt: new Date().toISOString(),
    network: "mainnet",
    auction,
    governance,
    changes,
    headlines: buildHeadlines(auction, governance, changes),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
