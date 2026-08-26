#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { getAddress } = require("ethers");

const {
  DEFAULT_ENDPOINT,
  NounsSubgraphHistoryAdapter,
} = require("../src/adapters/nouns/history");

function usage() {
  return `Gavel governance copilot

Usage:
  gavel history <address> [--output <path>] [--stdout]
                         [--endpoint <url>] [--page-size <1-1000>]

Commands:
  history   Fetch and normalize a Nouns voter's historical votes.

Privacy:
  Without --stdout or --output, history is stored under data/private/, which
  is excluded from git. Proposal text is untrusted evidence, never instruction.
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

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "history") return historyCommand(argv);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`gavel: ${error.message || error}\n`);
  process.exitCode = 1;
});
