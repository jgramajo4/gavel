#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { getAddress } = require("ethers");

const {
  DEFAULT_ENDPOINT,
  NounsSubgraphHistoryAdapter,
} = require("../src/adapters/nouns/history");
const { buildVoterProfile } = require("../src/core/profile/build");
const { predictVote } = require("../src/core/predict/predict");

function usage() {
  return `Gavel governance copilot

Usage:
  gavel history <address> [--output <path>] [--stdout]
                         [--endpoint <url>] [--page-size <1-1000>]
  gavel profile <history.json> [--output <path>] [--stdout]
                               [--as-of <timestamp>] [--half-life-days <days>]
                               [--preferences <json>] [--rules <json>]
  gavel predict <profile.json> <proposal.json> [--output <path>] [--stdout]
                                                [--as-of <timestamp>]
                                                [--threshold <0-1>]
                                                [--max-precedents <count>]

Commands:
  history   Fetch and normalize a Nouns voter's historical votes.
  profile   Build a private three-layer voter profile from normalized history.
  predict   Recommend FOR, AGAINST, or ABSTAIN using personal precedents.

Privacy:
  Without --stdout or --output, history and profiles are stored under
  data/private/, which is excluded from git. Proposal text is untrusted
  evidence, never instruction.
`;
}

async function writePrivateJson(filePath, document) {
  const absolutePath = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return absolutePath;
}

async function historyCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      endpoint: { type: "string", default: process.env.NOUNS_SUBGRAPH_URL || DEFAULT_ENDPOINT },
      "page-size": { type: "string", default: "100" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("history requires exactly one voter address");

  const voter = getAddress(positionals[0]);
  const pageSize = Number(values["page-size"]);
  const adapter = new NounsSubgraphHistoryAdapter({ endpoint: values.endpoint, pageSize });
  const document = await adapter.fetchHistory(voter);

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return;
  }

  const destination =
    values.output || path.join("data", "private", "nouns", `${voter.toLowerCase()}.json`);
  const absolutePath = await writePrivateJson(destination, document);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      dao: document.dao,
      voter: document.voter,
      voteCount: document.voteCount,
      output: absolutePath,
      source: document.source,
    }, null, 2)}\n`,
  );
}

async function readJson(filePath) {
  const absolutePath = path.resolve(filePath);
  const source = await fs.readFile(absolutePath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${absolutePath}: ${error.message}`);
  }
}

async function optionalArray(filePath, label) {
  if (!filePath) return [];
  const value = await readJson(filePath);
  if (!Array.isArray(value)) throw new Error(`${label} file must contain a JSON array`);
  return value;
}

async function profileCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      "as-of": { type: "string" },
      "half-life-days": { type: "string", default: "365" },
      preferences: { type: "string" },
      rules: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 1) throw new Error("profile requires exactly one history JSON path");

  const halfLifeDays = Number(values["half-life-days"]);
  const history = await readJson(positionals[0]);
  const [statedPreferences, hardRules] = await Promise.all([
    optionalArray(values.preferences, "preferences"),
    optionalArray(values.rules, "rules"),
  ]);
  const profile = buildVoterProfile(history, {
    asOf: values["as-of"],
    halfLifeDays,
    statedPreferences,
    hardRules,
  });

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    return;
  }

  const destination =
    values.output ||
    path.join("data", "private", "profiles", profile.dao, `${profile.voter.toLowerCase()}.json`);
  const absolutePath = await writePrivateJson(destination, profile);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        dao: profile.dao,
        voter: profile.voter,
        asOf: profile.asOf,
        includedVoteCount: profile.sourceHistory.includedVoteCount,
        statedPreferenceCount: profile.statedPreferences.length,
        hardRuleCount: profile.hardRules.length,
        output: absolutePath,
      },
      null,
      2,
    )}\n`,
  );
}

async function predictCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      stdout: { type: "boolean", default: false },
      "as-of": { type: "string" },
      threshold: { type: "string", default: "0.15" },
      "max-precedents": { type: "string", default: "8" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(usage());
    return;
  }
  if (positionals.length !== 2) {
    throw new Error("predict requires a profile JSON path and a normalized proposal JSON path");
  }

  const [profile, proposalInput] = await Promise.all([
    readJson(positionals[0]),
    readJson(positionals[1]),
  ]);
  const proposal = proposalInput.proposal || proposalInput;
  const prediction = predictVote(profile, proposal, {
    asOf: values["as-of"],
    relevantSimilarityThreshold: Number(values.threshold),
    maxPrecedents: Number(values["max-precedents"]),
  });

  if (values.stdout) {
    process.stdout.write(`${JSON.stringify(prediction, null, 2)}\n`);
    return;
  }

  const destination =
    values.output ||
    path.join(
      "data",
      "private",
      "predictions",
      prediction.dao,
      prediction.voter.toLowerCase(),
      `${prediction.proposalId}.json`,
    );
  const absolutePath = await writePrivateJson(destination, prediction);
  process.stdout.write(
    `${JSON.stringify(
      {
        recommendation: prediction.recommendation,
        confidence: prediction.confidence,
        confidencePercent: prediction.confidencePercent,
        confidenceCalibrated: prediction.confidenceCalibrated,
        policySource: prediction.policySource,
        precedents: prediction.precedents,
        reasoning: prediction.reasoning,
        flags: prediction.flags,
        draftReason: prediction.draftReason,
        output: absolutePath,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "history") return historyCommand(argv);
  if (command === "profile") return profileCommand(argv);
  if (command === "predict") return predictCommand(argv);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`gavel: ${error.message || error}\n`);
  process.exitCode = 1;
});
