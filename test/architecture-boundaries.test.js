const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const coreRoot = path.join(root, "packages", "core");

function jsFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return jsFiles(target);
    return entry.name.endsWith(".js") ? [target] : [];
  });
}

test("core imports remain inside core and never depend on host integrations or DAO adapters", () => {
  for (const filename of jsFiles(coreRoot)) {
    const source = fs.readFileSync(filename, "utf8");
    assert.doesNotMatch(source, /integrations[\\/](?:bankr|hermes)|packages[\\/]tui|nouns-adapter|adapters[\\/]nouns/i, filename);
    for (const match of source.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      const resolved = path.resolve(path.dirname(filename), match[1]);
      assert.ok(resolved === coreRoot || resolved.startsWith(`${coreRoot}${path.sep}`), `${filename} imports ${match[1]}`);
    }
  }
});

test("canonical monorepo boundaries and legacy CLI entry point coexist", () => {
  for (const target of [
    "packages/core/package.json",
    "packages/nouns-adapter/package.json",
    "packages/cli/package.json",
    "packages/tui/package.json",
    "packages/server/package.json",
    "integrations/bankr/package.json",
    "integrations/hermes/SKILL.md",
    "bin/gavel.js",
  ]) {
    assert.ok(fs.existsSync(path.join(root, target)), `missing ${target}`);
  }
  const legacy = fs.readFileSync(path.join(root, "bin", "gavel.js"), "utf8");
  assert.match(legacy, /packages\/cli\/bin\/gavel/);
  const cli = fs.readFileSync(path.join(root, "packages", "cli", "bin", "gavel.js"), "utf8");
  assert.doesNotMatch(cli, /require\(["'][^"']+\/src\//, "CLI must consume stable package entry points");
});
