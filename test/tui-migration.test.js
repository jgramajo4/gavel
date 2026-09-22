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

test("TUI bootstrap cannot load a signing key from configuration", () => {
  // Stronger than the migration-era check: the config type no longer has a
  // place to put a key at all, and the signer factory that read one is gone.
  // Signing authority reaches the TUI only through a wallet provider, which
  // holds a reference to a signer the host already has.
  // Comments are stripped first: a doc comment saying the key path is gone
  // must not read as the key path still being there.
  const code = (...segments) =>
    fs
      .readFileSync(path.join(tuiRoot, "src", ...segments), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  const config = code("config.ts");
  const cli = code("cli.tsx");
  const clients = code("chain", "clients.ts");
  assert.doesNotMatch(config, /GAVEL_PRIVATE_KEY|process\.env\.[A-Z_]*PRIVATE_KEY/);
  assert.doesNotMatch(config, /privateKey/);
  assert.doesNotMatch(cli, /makeSigner|GAVEL_PRIVATE_KEY|--wizard|--no-signing/);
  assert.doesNotMatch(clients, /makeSigner|privateKeyToAccount|privateKey/);
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

test("TUI index adapter displays effectiveStatus when the API exposes it", () => {
  const adapter = fs.readFileSync(path.join(tuiRoot, "src", "data", "governanceIndex.ts"), "utf8");
  assert.match(adapter, /effectiveStatus \?\? p\.outcome \?\? p\.state/);
  assert.match(adapter, /sourceState\?:/);
  assert.match(adapter, /trackingState\?:/);
});

test("commands the TUI prints always name their DAO", () => {
  // A copyable `gavel proposal 123` means different proposals to different
  // readers. Every command the vote panel shows carries --dao.
  const panel = fs.readFileSync(path.join(tuiRoot, "src", "components", "VoteFlow.tsx"), "utf8");
  // Comments explain why the rule exists and may quote a bad command, so the
  // check runs over rendered code only.
  const rendered = panel.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
  for (const line of rendered.split("\n")) {
    if (!/gavel [a-z]/.test(line)) continue;
    assert.match(line, /--dao/, `printed command without a DAO: ${line.trim()}`);
  }
  assert.match(panel, /gavel proposal \{proposal\.id\} --dao \{proposal\.dao\}/);
});

test("the TUI has no single implicit DAO", () => {
  // The whole point of the multi-DAO refactor: no screen may default to one
  // governance system, and the home route is the unified inbox rather than
  // one DAO's proposal list.
  const navigation = fs.readFileSync(path.join(tuiRoot, "src", "navigation.ts"), "utf8");
  assert.match(navigation, /screen: 'inbox'/);
  assert.match(navigation, /screen: 'daoProposals'; dao: string/);

  const app = fs.readFileSync(path.join(tuiRoot, "src", "App.tsx"), "utf8");
  assert.match(app, /useState<Route\[\]>\(\[\{ screen: 'inbox' \}\]\)/);

  // Nouns-specific surfaces are allowed, but only where they are explicitly
  // Nouns: the chain-reader registry, the Nouns subgraph module, the Nouns
  // rewards badge and the Nouns passport screens.
  const daoSpecific = new Set([
    path.join("chain", "daoReaders.ts"),
    path.join("chain", "abis.ts"),
    path.join("constants.ts"),
    path.join("data", "subgraph.ts"),
    path.join("data", "votes.ts"),
    path.join("data", "rewards.ts"),
    path.join("data", "eas.ts"),
    path.join("actions", "vote.ts"),
    path.join("actions", "delegate.ts"),
    path.join("actions", "attest.ts"),
    path.join("components", "RewardsBadge.tsx"),
    path.join("components", "VoteFlow.tsx"),
    path.join("hooks", "useDelegate.ts"),
    path.join("hooks", "useInbox.ts"),
    path.join("screens", "PassportFeed.tsx"),
    path.join("screens", "PassportDetail.tsx"),
    path.join("screens", "PassportValidate.tsx"),
    path.join("App.tsx"),
    path.join("utils", "schemaEncoder.ts"),
  ]);
  const sourceRoot = path.join(tuiRoot, "src");
  const walk = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(target);
      return /\.tsx?$/.test(entry.name) ? [target] : [];
    });
  for (const file of walk(sourceRoot)) {
    const relative = path.relative(sourceRoot, file);
    if (daoSpecific.has(relative)) continue;
    const source = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /nouns/i, `${relative} assumes a single DAO`);
  }
});
