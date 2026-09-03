#!/usr/bin/env node

/**
 * Create a Nouns DAO proposal (clientId-aware, uint32).
 *
 * Env:
 *  - ETHEREUM_RPC_URL (optional advanced override)
 *  - AGENT_PRIVATE_KEY (required)
 *
 * Usage:
 *  node scripts/propose.js \
 *    --targets <comma-separated-addresses> \
 *    --values <comma-separated-wei> \
 *    --signatures <comma-separated-signatures-or-empty> \
 *    --calldatas <comma-separated-hex> \
 *    --description "Proposal description"
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { getProvider } = require("./_utils");

const GOVERNANCE_ADDRESS = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getArgValue(flag) {
  const idx = process.argv.findIndex((arg) => arg === flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function parseCsv(value) {
  if (!value || value.trim() === "") return [];
  return value.split(",").map((v) => v.trim());
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/propose.js --targets <comma-separated-addresses> --values <comma-separated-wei> --signatures <comma-separated-signatures-or-empty> --calldatas <comma-separated-hex> --description \"...\"",
      "",
      "Env:",
      "  ETHEREUM_RPC_URL   Optional mainnet RPC override",
      "  AGENT_PRIVATE_KEY  Signer private key",
    ].join("\n"),
  );
}

async function main() {
  const privateKey = process.env.AGENT_PRIVATE_KEY;

  if (!privateKey) {
    console.error("Missing AGENT_PRIVATE_KEY in env.");
    usage();
    process.exit(1);
  }

  const targetsRaw = getArgValue("--targets");
  const valuesRaw = getArgValue("--values");
  const signaturesRaw = getArgValue("--signatures");
  const calldatasRaw = getArgValue("--calldatas");
  const description = getArgValue("--description");

  if (!targetsRaw || !valuesRaw || !signaturesRaw || !calldatasRaw || !description) {
    console.error("Missing required arguments.");
    usage();
    process.exit(1);
  }

  const targets = parseCsv(targetsRaw);
  const values = parseCsv(valuesRaw).map((v) => {
    if (!/^\d+$/.test(v)) {
      throw new Error(`Invalid value (wei): ${v}`);
    }
    return v;
  });
  const signatures = parseCsv(signaturesRaw);
  const calldatas = parseCsv(calldatasRaw);

  if (
    targets.length === 0 ||
    targets.length !== values.length ||
    targets.length !== signatures.length ||
    targets.length !== calldatas.length
  ) {
    throw new Error("Targets, values, signatures, and calldatas must be the same non-zero length.");
  }

  for (const target of targets) {
    if (!ethers.isAddress(target)) {
      throw new Error(`Invalid target address: ${target}`);
    }
  }

  for (const data of calldatas) {
    if (!ethers.isHexString(data)) {
      throw new Error(`Invalid calldata hex: ${data}`);
    }
  }

  const rootDir = path.resolve(__dirname, "..");
  const abiPath = path.join(rootDir, "references", "governance-abi.json");
  const configPath = path.join(rootDir, "config.json");
  const governanceAbi = readJson(abiPath);
  const config = readJson(configPath);

  const clientId = Number(config.clientId);
  if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) {
    throw new Error("clientId in config.json must be a uint32");
  }
  const clientIdUint32 = clientId >>> 0;

  const provider = getProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const governance = new ethers.Contract(GOVERNANCE_ADDRESS, governanceAbi, wallet);

  const tx = await governance.propose(
    targets,
    values,
    signatures,
    calldatas,
    description,
    clientIdUint32,
  );

  console.log("txHash:", tx.hash);
  const receipt = await tx.wait();
  console.log("status:", receipt.status);
  console.log("proposalCreatedInBlock:", receipt.blockNumber);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
