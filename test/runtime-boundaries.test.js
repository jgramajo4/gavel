"use strict";

/**
 * Runtime boundaries: Bankr and Hermes are clients of Gavel core, not
 * alternative implementations of it.
 *
 *   gavel/core   governance + intent + execution
 *      /     \
 *  Bankr     Hermes
 *
 * The invariant this file exists to enforce is the arbitrary-call one: neither
 * runtime may turn a natural-language request into a wallet call. Every action
 * must travel natural language -> governance intent -> canonical execution
 * intent -> validation -> executor.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function sourceFiles(directory, extensions = [".js"]) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(target, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [target] : [];
  });
}

test("neither runtime implements governance reasoning or execution", () => {
  // A runtime that reached for a governor ABI, a voter model, or a wallet
  // provider would be a second implementation, and the two would drift.
  const forbidden = [
    [/castVote|castRefundableVote|proposalSnapshot|hashProposal/, "governance contract calls"],
    [/predictVote|buildVoterProfile|runChronologicalBacktest/, "voter modelling"],
    [/safeTxHash|SafeApiKit|proposeTransaction|senderSignature/, "Safe provider calls"],
    [/new Wallet\(|privateKeyToAccount|signTypedData|sendTransaction/, "transaction signing"],
    [/governanceIntentHash|executionIntentHash|createExecutionIntent/, "intent construction"],
  ];

  for (const runtime of ["bankr", "hermes"]) {
    for (const filename of sourceFiles(path.join(root, "integrations", runtime))) {
      const source = fs.readFileSync(filename, "utf8");
      for (const [pattern, description] of forbidden) {
        assert.doesNotMatch(source, pattern, `${filename} implements ${description}`);
      }
    }
  }
});

test("both runtimes reach Gavel only through the canonical CLI", () => {
  // Hermes bootstraps a pinned revision and execs the CLI; it must not import
  // core or an adapter directly, which would let the two diverge in behaviour.
  const runner = fs.readFileSync(path.join(root, "integrations", "hermes", "scripts", "gavel.js"), "utf8");
  assert.match(runner, /packages["'\\/, ]+cli["'\\/, ]+bin["'\\/, ]+gavel/);
  assert.doesNotMatch(runner, /require\(["'].*packages\/core/);
  assert.doesNotMatch(runner, /require\(["'].*-adapter/);

  // Bankr is a skill wrapper over the same CLI and ships no runtime code at all.
  assert.deepEqual(sourceFiles(path.join(root, "integrations", "bankr")), []);
});

test("both runtime skills forbid arbitrary calldata and name the intent path", () => {
  const surfaces = [
    path.join(root, "integrations", "hermes", "SKILL.md"),
    path.join(root, "nouns-dao", "references", "bankr-runtime.md"),
  ];
  for (const filename of surfaces) {
    const text = fs.readFileSync(filename, "utf8");
    // Each surface must say, in its own words, that arbitrary submission is out.
    assert.match(text, /never submit arbitrary|never become a wallet call|no command that accepts a target and calldata/i, filename);
    // And must route transaction construction through the CLI.
    assert.match(text, /prepare-vote/, filename);
    assert.doesNotMatch(text, /AGENT_PRIVATE_KEY|GAVEL_PRIVATE_KEY/, filename);
  }

  const bankr = fs.readFileSync(path.join(root, "nouns-dao", "references", "bankr-runtime.md"), "utf8");
  assert.match(bankr, /governance intent/i);
  assert.match(bankr, /ValidatedExecutionIntent/);
  assert.match(bankr, /owns\s+no governance logic and no execution logic/i);
  // A BLOCKED preparation is a refusal, not a suggestion to retry differently.
  assert.match(bankr, /`BLOCKED` preparation is a refusal/);
});

test("the core CLI is the only place transactions are constructed", () => {
  // If a second entry point grew its own preparation logic, the runtimes would
  // no longer get identical behaviour for the same intent.
  const entryPoints = [
    path.join(root, "bin", "gavel.js"),
    path.join(root, "integrations", "hermes", "scripts", "gavel.js"),
  ];
  for (const filename of entryPoints) {
    const source = fs.readFileSync(filename, "utf8");
    assert.doesNotMatch(source, /encodeFunctionData|new Interface\(/, `${filename} builds calldata`);
  }
  const legacy = fs.readFileSync(path.join(root, "bin", "gavel.js"), "utf8");
  assert.match(legacy, /packages\/cli\/bin\/gavel/);
});

test("the legacy direct-signing scripts are outside the execution path", () => {
  // nouns-dao/scripts/* still sign directly with AGENT_PRIVATE_KEY. They are
  // legacy tools, and the boundary they must respect is that nothing in the
  // execution layer or the CLI depends on them.
  const signing = sourceFiles(path.join(root, "nouns-dao", "scripts")).filter((filename) =>
    /AGENT_PRIVATE_KEY/.test(fs.readFileSync(filename, "utf8")),
  );
  assert.ok(signing.length > 0, "expected the legacy signing scripts to still exist");

  const reachable = [
    ...sourceFiles(path.join(root, "packages", "core", "src")),
    ...sourceFiles(path.join(root, "packages", "cli")),
  ];
  for (const filename of reachable) {
    const source = fs.readFileSync(filename, "utf8");
    assert.doesNotMatch(source, /nouns-dao[\\/]scripts/, `${filename} depends on a legacy signing script`);
    assert.doesNotMatch(source, /AGENT_PRIVATE_KEY/, `${filename} reads a raw private key`);
  }
});
