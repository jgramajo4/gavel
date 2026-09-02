const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const integration = path.join(root, "integrations", "hermes");

test("Hermes skill is thin, routes to the stable CLI, and preserves execution boundaries", () => {
  const skill = fs.readFileSync(path.join(integration, "SKILL.md"), "utf8");
  assert.match(skill, /^---[\s\S]*name: gavel-governance[\s\S]*---/);
  assert.match(skill, /installed `gavel` executable as the only Gavel compatibility boundary/);
  assert.match(skill, /Safe mode, propose only/i);
  assert.match(skill, /never submit arbitrary/i);
  assert.doesNotMatch(skill, /AGENT_PRIVATE_KEY|GAVEL_PRIVATE_KEY/);
});

test("Hermes health check invokes the canonical CLI and emits JSON", () => {
  const result = spawnSync(process.execPath, [path.join(integration, "scripts", "health-check.js")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GAVEL_DATA_DIR: path.join(root, "private", "hermes-test") },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.runtime, "hermes");
  assert.equal(output.dataDirConfigured, true);
});
