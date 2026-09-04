const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const integration = path.join(root, "integrations", "hermes");

test("Hermes skill is thin, routes to the stable CLI, and preserves execution boundaries", () => {
  const skill = fs.readFileSync(path.join(integration, "SKILL.md"), "utf8");
  assert.match(skill, /^---[\s\S]*name: gavel-governance[\s\S]*---/);
  assert.match(skill, /bundled \[Gavel runner\]\(scripts\/gavel\.js\) as the only compatibility\s+boundary/);
  assert.match(skill, /Do not ask the user to clone[\s\S]*npm link/i);
  assert.match(skill, /Safe mode, propose only/i);
  assert.match(skill, /never submit arbitrary/i);
  assert.match(skill, /Gavel never creates or selects a Safe/i);
  assert.match(skill, /heuristic score/i);
  assert.doesNotMatch(skill, /AGENT_PRIVATE_KEY|GAVEL_PRIVATE_KEY/);
});

test("Hermes install instructions use supported CLI flags and the runner does not pass through the full environment", () => {
  const runtime = fs.readFileSync(path.join(integration, "references", "runtime.md"), "utf8");
  const runner = fs.readFileSync(path.join(integration, "scripts", "gavel.js"), "utf8");
  assert.match(runtime, /hermes skills install[^\n]+--yes/);
  assert.doesNotMatch(runtime, /--now/);
  assert.doesNotMatch(runner, /env:\s*(?:options\.env\s*\|\|\s*)?process\.env/);
});

test("Hermes runner bootstraps a pinned runtime once and reuses it", () => {
  const runner = path.join(integration, "scripts", "gavel.js");
  const { ensureRuntime, REPOSITORY_URL, RUNTIME_REF } = require(runner);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-hermes-bootstrap-"));
  const env = {
    ...process.env,
    HERMES_HOME: path.join(temporaryRoot, "hermes"),
  };
  const options = {
    // Fetch the advertised pin from GitHub. A local checkout SHA is often
    // unreachable after squash-merges (`not our ref`) and CI is depth-1.
    sourceConfig: { source: REPOSITORY_URL, ref: RUNTIME_REF },
    skipNpm: true,
  };

  try {
    assert.equal(REPOSITORY_URL, "https://github.com/jgramajo4/gavel.git");
    assert.match(RUNTIME_REF, /^[0-9a-f]{40}$/);

    const first = ensureRuntime(env, options);
    assert.equal(first.installed, true);
    assert.equal(first.runtimeRef, RUNTIME_REF);

    const second = ensureRuntime(env, options);
    assert.equal(second.installed, false);

    const versionedRuntime = path.join(env.HERMES_HOME, "runtimes", "gavel", RUNTIME_REF.slice(0, 12));
    assert.ok(fs.existsSync(path.join(versionedRuntime, "packages", "cli", "bin", "gavel.js")));
    assert.ok(fs.statSync(path.join(env.HERMES_HOME, "data", "gavel")).isDirectory());
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Hermes runner keeps managed runtime and private data separate", () => {
  const { resolveConfig } = require(path.join(integration, "scripts", "gavel.js"));
  const base = path.join(os.tmpdir(), "gavel-hermes-overlap");
  assert.throws(
    () => resolveConfig({ HERMES_HOME: base, GAVEL_RUNTIME_DIR: base, GAVEL_DATA_DIR: path.join(base, "data") }),
    /must not overlap/,
  );
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
