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

/**
 * Gate payment is a separate, bounded boundary.
 *
 * The Bankr advocate client signs one EIP-712 WalletSession proof and one
 * EIP-3009 authorization, and a SEPARATE relayer broadcasts one `settle` call
 * whose every field is derived from a quote the Gate server signed. That is not
 * the governance execution path and it is not reachable from a
 * natural-language target plus calldata, so the arbitrary-call invariant below
 * still holds. These files carry extra assertions of their own in the next test.
 */
const GATE_PAYMENT_BOUNDARY = new Set([
  path.join(root, "integrations", "bankr", "src", "wallet.js"),
  path.join(root, "integrations", "bankr", "src", "splitter.js"),
  path.join(root, "integrations", "bankr", "src", "relayer.js"),
  path.join(root, "integrations", "bankr", "src", "payment.js"),
  path.join(root, "integrations", "bankr", "src", "session.js"),
]);

function isTestFixture(filename) {
  return filename.includes(`${path.sep}test${path.sep}`);
}

function isGatePaymentBoundary(filename) {
  return GATE_PAYMENT_BOUNDARY.has(filename) || isTestFixture(filename);
}

test("neither runtime implements governance reasoning or execution", () => {
  // A runtime that reached for a governor ABI, a voter model, or a wallet
  // provider would be a second implementation, and the two would drift.
  const forbidden = [
    [/castVote|castRefundableVote|proposalSnapshot|hashProposal/, "governance contract calls", "all"],
    [/predictVote|buildVoterProfile|runChronologicalBacktest/, "voter modelling", "all"],
    [/safeTxHash|SafeApiKit|proposeTransaction|senderSignature/, "Safe provider calls", "all"],
    // Reading a key from the environment is forbidden everywhere, with no
    // exception: no runtime file and no test fixture may reach for one.
    [/AGENT_PRIVATE_KEY|GAVEL_PRIVATE_KEY|PRIVATE_KEY\b|privateKeyToAccount/, "private key handling", "all"],
    // A locally constructed signer is runtime-forbidden; a test fixture may
    // build a deterministic one to produce a real signature to assert against.
    [/new Wallet\(/, "a locally constructed signer", "runtime"],
    [/signTypedData|sendTransaction/, "transaction signing", "non-payment"],
    [/governanceIntentHash|executionIntentHash|createExecutionIntent/, "intent construction", "all"],
  ];

  for (const runtime of ["bankr", "hermes"]) {
    for (const filename of sourceFiles(path.join(root, "integrations", runtime))) {
      const source = fs.readFileSync(filename, "utf8");
      for (const [pattern, description, scope] of forbidden) {
        if (scope === "runtime" && isTestFixture(filename)) continue;
        if (scope === "non-payment" && isGatePaymentBoundary(filename)) continue;
        assert.doesNotMatch(source, pattern, `${filename} implements ${description}`);
      }
    }
  }
});

test("the Gate payment boundary signs only what a Gate quote determines", () => {
  const bankrSrc = path.join(root, "integrations", "bankr", "src");
  const read = (name) => fs.readFileSync(path.join(bankrSrc, name), "utf8");
  const payment = read("payment.js");
  const splitter = read("splitter.js");

  // One authorization consumed by one settle call. No approve path exists.
  assert.match(splitter, /function settle\(/);
  for (const source of [payment, splitter]) {
    assert.doesNotMatch(source, /function approve\(|"approve"|'approve'/);
  }

  // The destination and the chain come from the signed quote, never from a
  // caller, a config value, or a hard-coded address.
  assert.match(payment, /to: quote\.splitter/);
  for (const name of ["payment.js", "splitter.js", "relayer.js", "wallet.js"]) {
    assert.doesNotMatch(read(name), /0x[0-9a-fA-F]{40}/, `${name} hard-codes an address`);
  }

  // Payment cannot happen without an explicit confirmation.
  assert.match(payment, /confirmed !== true/);
  assert.match(payment, /CONFIRMATION_REQUIRED/);

  // There is no target+calldata entry point: the only calldata built here is
  // the splitter settle call encoded from the quote.
  const encodes = [...payment.matchAll(/encodeFunctionData\(([^)]*)\)/g), ...splitter.matchAll(/encodeFunctionData\(([^)]*)\)/g)];
  for (const [call] of encodes) {
    assert.match(call, /"settle"|"name"|"version"|"DOMAIN_SEPARATOR"|"balanceOf"/, `unexpected calldata: ${call}`);
  }
});

test("Bankr signs but never broadcasts, and the relayer only broadcasts", () => {
  // The Gate splitter does not require msg.sender == payer, so the payer signs
  // and a separate funded relayer pays gas. The capability split is what makes a
  // Bankr broadcast fallback impossible rather than merely discouraged.
  const bankrSrc = path.join(root, "integrations", "bankr", "src");
  const read = (name) => fs.readFileSync(path.join(bankrSrc, name), "utf8");

  const wallet = read("wallet.js");
  assert.match(wallet, /REQUIRED_CAPABILITIES = Object\.freeze\(\["getAddress", "getChainId", "signTypedData", "call"\]\)/);
  assert.doesNotMatch(wallet, /eth_sendTransaction/, "the Bankr wallet adapter can still broadcast");

  // Only the relayer module calls sendTransaction, and only on a relayer.
  const payment = read("payment.js");
  assert.doesNotMatch(payment, /wallet\.sendTransaction/, "payment.js broadcasts through the Bankr wallet");
  const relayer = read("relayer.js");
  assert.match(relayer, /relayer\.sendTransaction\(\{ to: safe\.to, data: safe\.data, value: safe\.value \}\)/);

  // The relayer boundary is exactly three fields, and the relayer is never the
  // payer. What actually crosses that boundary at runtime is asserted in
  // integrations/bankr/test/relayer.test.js.
  assert.match(relayer, /PREPARED_TX_FIELDS = Object\.freeze\(\["to", "data", "value"\]\)/);
  assert.match(relayer, /RELAYER_IS_PAYER/);
  // Every prepared transaction is re-derived from the quote before broadcast.
  assert.match(relayer, /assertPreparedTransaction\(prepared, quote, nowSeconds\)/);
});

test("both runtimes reach Gavel only through the canonical CLI", () => {
  // Hermes bootstraps a pinned revision and execs the CLI; it must not import
  // core or an adapter directly, which would let the two diverge in behaviour.
  const runner = fs.readFileSync(path.join(root, "integrations", "hermes", "scripts", "gavel.js"), "utf8");
  assert.match(runner, /packages["'\\/, ]+cli["'\\/, ]+bin["'\\/, ]+gavel/);
  assert.doesNotMatch(runner, /require\(["'].*packages\/core/);
  assert.doesNotMatch(runner, /require\(["'].*-adapter/);

  // Bankr ships no governance runtime code. Its only source is the Gate
  // advocate client, which is an HTTP client over Gate's own surfaces: it
  // imports no core module, no DAO adapter, and no CLI internal, so it cannot
  // grow a second implementation of anything Gavel core owns.
  const bankrSources = sourceFiles(path.join(root, "integrations", "bankr"));
  assert.ok(bankrSources.length > 0, "expected the Bankr Gate advocate client to exist");
  for (const filename of bankrSources) {
    const source = fs.readFileSync(filename, "utf8");
    assert.doesNotMatch(source, /require\(["'].*packages\/core/, `${filename} imports core`);
    assert.doesNotMatch(source, /require\(["'].*-adapter/, `${filename} imports a DAO adapter`);
    assert.doesNotMatch(source, /require\(["'].*packages\/cli/, `${filename} imports CLI internals`);
    assert.doesNotMatch(source, /require\(["'].*packages\/server/, `${filename} imports Gate server internals`);
  }

  // And it never reaches a voter-private Gate route: the payer is a different
  // actor from the recipient, and Bankr must not be able to read an inbox.
  for (const filename of bankrSources.filter((name) => name.includes(`${path.sep}src${path.sep}`))) {
    assert.doesNotMatch(
      fs.readFileSync(filename, "utf8"),
      /\/v1\/gate\/me\//,
      `${filename} reaches a voter-private Gate route`,
    );
  }
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
