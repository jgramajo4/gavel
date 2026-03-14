#!/usr/bin/env node

/**
 * List active Nouns DAO proposals from the governance contract.
 * Environment:
 *   ETHEREUM_RPC_URL (required)
 *
 * Usage:
 *   node list_proposals.js [--limit=10]
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const GOVERNANCE_ADDRESS = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";
const ABI_PATH = path.resolve(__dirname, "../references/governance-abi.json");

function getArgValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return fallback;
  return arg.slice(prefix.length);
}

function toNumberSafe(value) {
  if (typeof value === "bigint") return Number(value);
  if (ethers.BigNumber && ethers.BigNumber.isBigNumber(value))
    return value.toNumber();
  return Number(value);
}

function toStringSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (ethers.BigNumber && ethers.BigNumber.isBigNumber(value))
    return value.toString();
  return String(value);
}

async function main() {
  const rpcUrl = process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) {
    console.error("Missing ETHEREUM_RPC_URL.");
    process.exit(1);
  }

  const limitArg = getArgValue("limit");
  const limit = limitArg ? Number(limitArg) : null;

  const abi = JSON.parse(fs.readFileSync(ABI_PATH, "utf8"));
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const governance = new ethers.Contract(GOVERNANCE_ADDRESS, abi, provider);

  const proposalCount = await governance.proposalCount();
  const total = toNumberSafe(proposalCount);

  const activeProposals = [];
  for (let id = total; id >= 1; id -= 1) {
    const state = await governance.state(id);
    const stateNum = toNumberSafe(state);
    if (stateNum !== 1) {
      continue;
    }

    const proposal = await governance.proposals(id);

    activeProposals.push({
      id: toStringSafe(proposal.id),
      proposer: proposal.proposer,
      proposalThreshold: toStringSafe(proposal.proposalThreshold),
      quorumVotes: toStringSafe(proposal.quorumVotes),
      eta: toStringSafe(proposal.eta),
      targets: proposal.targets,
      values: proposal.values.map(toStringSafe),
      signatures: proposal.signatures,
      calldatas: proposal.calldatas,
      startBlock: toStringSafe(proposal.startBlock),
      endBlock: toStringSafe(proposal.endBlock),
      forVotes: toStringSafe(proposal.forVotes),
      againstVotes: toStringSafe(proposal.againstVotes),
      abstainVotes: toStringSafe(proposal.abstainVotes),
      canceled: proposal.canceled,
      executed: proposal.executed,
      vetoed: proposal.vetoed,
      vetoer: proposal.vetoer,
      creationTimestamp: toStringSafe(proposal.creationTimestamp),
      state: stateNum,
    });

    if (limit && activeProposals.length >= limit) {
      break;
    }
  }

  const output = {
    contract: GOVERNANCE_ADDRESS,
    activeCount: activeProposals.length,
    proposals: activeProposals,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
