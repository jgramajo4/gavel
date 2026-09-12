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

/**
 * The deprecated single-phase executors, and only those.
 *
 * `executors/waap.js` takes a DAO adapter and reads its governor address --
 * precisely the boundary violation the execution-adapter refactor removes. It
 * stays until the legacy path is dropped, so it is exempted by name rather
 * than by a pattern that would let new violations in. Nothing may be added to
 * this list: a new file needing an exemption means the boundary moved.
 */
const DEPRECATED_EXECUTORS = Object.freeze([
  path.join("executors", "safe.js"),
  path.join("executors", "waap.js"),
]);

test("the execution layer contains no governance logic and no DAO names in code", () => {
  const executionRoot = path.join(coreRoot, "src", "execution");
  const exempt = [];
  for (const filename of jsFiles(executionRoot)) {
    if (DEPRECATED_EXECUTORS.some((deprecated) => filename.endsWith(deprecated))) {
      assert.match(fs.readFileSync(filename, "utf8"), /^\/\*\*\n \* DEPRECATED\./, `${filename} must say it is deprecated`);
      exempt.push(filename);
      continue;
    }
    // Doc comments may name a DAO to explain why a rule exists -- Railgun's
    // repeatable partial votes are the motivating case for DAO-declared
    // semantics -- but no code path may branch on one.
    const source = fs
      .readFileSync(filename, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const pattern of [/nouns/i, /railgun/i, /\bens\b/i, /governor/i, /castVote/i, /proposalSnapshot/i]) {
      assert.doesNotMatch(source, pattern, `${filename} contains governance-specific code: ${pattern}`);
    }
  }
  assert.equal(exempt.length, DEPRECATED_EXECUTORS.length, "the deprecated-executor exemption list is stale");
});

test("the governance layer never reaches for an execution provider", () => {
  // The other direction of the same boundary: DAO adapters may build calldata
  // and address roles, but must not know Safe, WaaP, or any wallet provider.
  for (const adapter of ["nouns-adapter", "ens-adapter", "railgun-adapter"]) {
    const adapterRoot = path.join(root, "packages", adapter, "src");
    for (const filename of jsFiles(adapterRoot)) {
      const source = fs
        .readFileSync(filename, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const pattern of [/safeTxHash/i, /SafeApiKit/, /transactionService/i, /\bwaap\b/i, /safeNonce/i, /ProposalIdentity/]) {
        assert.doesNotMatch(source, pattern, `${filename} knows about an execution provider: ${pattern}`);
      }
    }
  }
});

test("nothing outside the validated-intent module can mint a validated intent", () => {
  // The governance invariant, enforced as a boundary rather than a convention:
  // ValidatedExecutionIntent's constructor is sealed by a module-scoped symbol
  // that is never exported, so `new ValidatedExecutionIntent(...)` outside its
  // own module cannot succeed no matter what a caller passes.
  const validated = path.join(coreRoot, "src", "intent", "validated.js");
  const source = fs.readFileSync(validated, "utf8");
  assert.match(source, /const SEAL = Symbol\(/, "the seal must be module-scoped");
  assert.doesNotMatch(source, /exports[\s\S]*\bSEAL\b/, "the seal must never be exported");

  for (const filename of jsFiles(path.join(root, "packages")).concat(jsFiles(path.join(root, "integrations")))) {
    if (filename === validated) continue;
    const other = fs.readFileSync(filename, "utf8");
    assert.doesNotMatch(other, /new ValidatedExecutionIntent\(/, `${filename} constructs the boundary type directly`);
  }
});
