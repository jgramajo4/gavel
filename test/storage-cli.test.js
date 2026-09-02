const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { resolveDataDir, privatePath } = require("../packages/core/src/storage/private-state");

const root = path.resolve(__dirname, "..");
const cli = path.join(root, "packages", "cli", "bin", "gavel.js");
const VOTER = "0xF6e7501dFe7003299108020c5830C4c5B3CA6aA9";

test("custom GAVEL_DATA_DIR is runtime-owned and path traversal is rejected", () => {
  const configured = resolveDataDir({ cwd: root, env: { GAVEL_DATA_DIR: "private/runtime-a" } });
  assert.equal(configured, path.join(root, "private", "runtime-a"));
  assert.equal(privatePath(configured, "profiles", "voter.json"), path.join(configured, "profiles", "voter.json"));
  assert.throws(() => privatePath(configured, "..", "escape.json"), /escapes/);
});

test("CLI runs without Bankr and writes JSON state beneath custom GAVEL_DATA_DIR", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-cli-"));
  const dataDir = path.join(temporary, "state");
  const answersPath = path.join(temporary, "answers.json");
  fs.writeFileSync(answersPath, JSON.stringify({ answers: [{ questionId: "public-goods", answer: "FOR" }] }));
  const result = spawnSync(process.execPath, [cli, "onboard", VOTER, "--answers", answersPath], {
    cwd: temporary,
    encoding: "utf8",
    env: { ...process.env, GAVEL_DATA_DIR: dataDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.ok(path.resolve(output.output).startsWith(`${path.resolve(dataDir)}${path.sep}`));
  assert.equal(fs.existsSync(output.output), true);
});

test("legacy and canonical CLI entry points expose the same machine-readable contract", () => {
  for (const entry of [cli, path.join(root, "bin", "gavel.js")]) {
    const result = spawnSync(process.execPath, [entry, "onboard", VOTER, "--questions"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.ok(Array.isArray(output.questions));
    assert.deepEqual(output.answers, ["FOR", "AGAINST", "ABSTAIN", "DEPENDS", "SKIP"]);
  }
});
