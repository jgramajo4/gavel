#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cli = path.resolve(__dirname, "../../../packages/cli/bin/gavel.js");
const result = spawnSync(process.execPath, [cli, "--help"], {
  encoding: "utf8",
  env: process.env,
  timeout: 15_000,
});
const healthy = result.status === 0 && /gavel execution-status/.test(result.stdout || "");
process.stdout.write(`${JSON.stringify({
  ok: healthy,
  runtime: "hermes",
  cli,
  dataDirConfigured: Boolean(process.env.GAVEL_DATA_DIR),
  exitCode: result.status,
})}\n`);
if (!healthy) process.exitCode = 1;
