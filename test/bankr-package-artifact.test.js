"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { packageContentId } = require("../integrations/bankr/scripts/content-id");

const root = path.resolve(__dirname, "..");
const skillDir = path.join(root, "integrations", "bankr");
const manifestPath = path.join(skillDir, "references", "skill-manifest.json");
const buildScript = path.join(skillDir, "scripts", "build-artifact.js");

function walkMarkdown(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "test"].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    assert.equal(fs.lstatSync(absolute).isSymbolicLink(), false, `${absolute} must not be a symlink`);
    if (entry.isDirectory()) files.push(...walkMarkdown(absolute));
    else if (entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

test("the installed prompt package is self-contained and every loaded reference exists", () => {
  const markdown = walkMarkdown(skillDir);
  assert.ok(markdown.length > 2, "expected the umbrella skill and companion references");

  for (const file of markdown) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:^|[(`])\.\.\//m, `${path.relative(skillDir, file)} must not escape the skill`);
    for (const match of source.matchAll(/`(references\/[a-z0-9-]+\.md)`/g)) {
      const target = path.join(skillDir, match[1]);
      assert.ok(fs.statSync(target).isFile(), `${match[1]} loaded by ${path.basename(file)} must ship`);
    }
  }
});

test("the source manifest exposes a content-derived build ID and distinguishes source from stamped builds", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(skillDir, "package.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

  assert.equal(manifest.name, "gavel");
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.buildId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(manifest.buildId, packageContentId({ repoRoot: root, skillDir }));
  assert.deepEqual(manifest.build, { kind: "source", gitSha: null });
  assert.equal(manifest.runtime.ref, "main");
  assert.match(skill, /references\/skill-manifest\.json/);
  assert.match(skill, new RegExp(`version: ${pkg.version.replaceAll(".", "\\.")}`));
});

test("the deterministic builder stamps a supplied git SHA without changing the source manifest", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-bankr-build-"));
  const secondOutput = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-bankr-build-"));
  const sha = "a".repeat(40); // deterministic test fixture, never represented as a repository commit
  execFileSync(process.execPath, [buildScript, "--output", output, "--build-sha", sha], { cwd: root });
  execFileSync(process.execPath, [buildScript, "--output", secondOutput, "--build-sha", sha], { cwd: root });

  const builtText = fs.readFileSync(path.join(output, "references", "skill-manifest.json"), "utf8");
  const built = JSON.parse(builtText);
  const source = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(built.build, { kind: "git", gitSha: sha });
  assert.equal(built.runtime.ref, sha);
  assert.equal(
    builtText,
    fs.readFileSync(path.join(secondOutput, "references", "skill-manifest.json"), "utf8"),
    "the same source manifest and SHA must produce the same stamped manifest",
  );
  assert.deepEqual(source.build, { kind: "source", gitSha: null });
});

test("a packed artifact contains both routes and a vendored private Gate dependency", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-bankr-pack-"));
  const stage = path.join(work, "stage");
  execFileSync(process.execPath, [buildScript, "--output", stage], { cwd: root });
  const packJson = JSON.parse(execFileSync("npm", ["pack", stage, "--json"], {
    cwd: work,
    encoding: "utf8",
  }));
  const files = new Set(packJson[0].files.map(({ path: packedPath }) => packedPath));
  for (const required of [
    "SKILL.md",
    "references/skill-manifest.json",
    "references/voter-copilot.md",
    "references/gate-advocate-client.md",
    "vendor/gate/package.json",
    "vendor/gate/src/index.js",
  ]) assert.ok(files.has(required), `${required} must be present in the packed artifact`);

  const builtPackage = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8"));
  assert.equal(builtPackage.dependencies["@gavel/gate"], "file:vendor/gate");
  assert.match(builtPackage.dependencies.ethers, /^\^/);

  const installRoot = path.join(work, "install");
  fs.mkdirSync(installRoot);
  const tarball = path.join(work, packJson[0].filename);
  execFileSync("tar", ["-xzf", tarball, "-C", installRoot]);
  const installedPackage = path.join(installRoot, "package");
  execFileSync("npm", ["install", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"], {
    cwd: installedPackage,
  });
  const artifact = require(installedPackage);
  assert.equal(typeof artifact.createBankrGateFlow, "function");

  // Bankr installs the published artifact itself, not an unpacked directory.
  // npm treats nested file: dependencies differently in that path, so prove the
  // tarball is independently loadable instead of relying on workspace hoisting.
  const tarballInstall = path.join(work, "tarball-install");
  fs.mkdirSync(tarballInstall);
  execFileSync("npm", ["install", tarball, "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"], {
    cwd: tarballInstall,
  });
  const packedArtifact = require(path.join(tarballInstall, "node_modules", "@gavel", "integration-bankr"));
  assert.equal(typeof packedArtifact.createBankrGateFlow, "function");
});