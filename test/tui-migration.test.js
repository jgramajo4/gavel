const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const tuiRoot = path.join(root, "packages", "tui");

test("TUI migration uses its own package and binary identity", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(tuiRoot, "package.json"), "utf8"));
  assert.equal(pkg.name, "@gavel/tui");
  assert.equal(pkg.license, "GPL-3.0-only");
  assert.deepEqual(pkg.bin, { "gavel-tui": "dist/cli.js" });
  assert.equal(pkg.bin.gavel, undefined);
});

test("TUI bootstrap cannot load the legacy environment signing key", () => {
  const config = fs.readFileSync(path.join(tuiRoot, "src", "config.ts"), "utf8");
  const cli = fs.readFileSync(path.join(tuiRoot, "src", "cli.tsx"), "utf8");
  assert.doesNotMatch(config, /GAVEL_PRIVATE_KEY|process\.env\.[A-Z_]*PRIVATE_KEY/);
  assert.match(config, /privateKey:\s*undefined/);
  assert.doesNotMatch(cli, /makeSigner|GAVEL_PRIVATE_KEY|--wizard|--no-signing/);
});

test("legacy private-key wizard is not imported", () => {
  assert.equal(fs.existsSync(path.join(tuiRoot, "scripts", "wizard.sh")), false);
});

test("migration provenance and replacement checklist are recorded", () => {
  const migration = fs.readFileSync(
    path.join(root, "docs", "architecture", "TUI_MIGRATION.md"),
    "utf8",
  );
  assert.match(migration, /39ddf1e8fbb2f378b0b62c44df206dcfa4900466/);
  assert.match(migration, /Replace proposal ingestion/);
  assert.match(migration, /canonical wallet handoff/);
});
