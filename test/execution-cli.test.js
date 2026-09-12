"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");

const { stubProvider } = require("./helpers/stub-rpc");
const { ACTION_TARGET, VOTER, prediction, proposal } = require("./helpers/nouns-preparation");

const CLI = path.resolve(__dirname, "..", "packages", "cli", "bin", "gavel.js");
const PROPOSER = "0x3333333333333333333333333333333333333333";

/**
 * Run the CLI asynchronously.
 *
 * `spawnSync` blocks the parent's event loop, so a stub RPC server running in
 * this process could never answer the child's requests -- the CLI would hang
 * with zero calls served. Chain-backed CLI tests have to spawn asynchronously.
 */
function runAsync(args, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-cli-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GAVEL_DATA_DIR: dataDir, GAVEL_STRUCTURED_ERRORS: "0", ...options.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the CLI did not exit within 30s: ${args.join(" ")}`));
    }, 30_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, dataDir });
    });
  });
}

function run(args, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-cli-"));
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, GAVEL_DATA_DIR: dataDir, GAVEL_STRUCTURED_ERRORS: "0", ...env },
  });
  return { ...result, dataDir };
}

/** Write the prediction and proposal `execution prepare` consumes. */
function governanceInputs() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-in-"));
  const predictionPath = path.join(scratch, "prediction.json");
  const proposalPath = path.join(scratch, "proposal.json");
  fs.writeFileSync(predictionPath, JSON.stringify(prediction()));
  fs.writeFileSync(proposalPath, JSON.stringify(proposal()));
  return { scratch, predictionPath, proposalPath };
}

test("the CLI exposes no surface that submits caller-supplied calldata", () => {
  const source = fs.readFileSync(CLI, "utf8");
  const { stdout } = run(["--help"]);

  // `gavel safe propose --to ... --data ...` would bypass the governance
  // boundary entirely. There must be no such command and no such flags.
  assert.doesNotMatch(stdout, /safe propose/);
  assert.doesNotMatch(stdout, /--calldata/);
  assert.doesNotMatch(source, /"calldata":\s*\{\s*type:/);
  assert.doesNotMatch(source, /"data":\s*\{\s*type:/);
  assert.doesNotMatch(source, /command === "safe"/);

  // No execution command takes a transaction. (`prepare-delegation --to` names
  // a delegate, and its output is unsigned calldata for a human to sign -- it
  // never reaches an executor.)
  const executionOptions = source.slice(source.indexOf("async function executionPrepareCommand"));
  const untilIdentity = executionOptions.slice(0, executionOptions.indexOf("async function identityCreateCommand"));
  for (const forbidden of ['"to":', '"data":', '"calldata":', '"value":', '"target":']) {
    assert.ok(!untilIdentity.includes(forbidden), `an execution command accepts ${forbidden}`);
  }

  // Both execution commands take governance inputs, not transactions.
  assert.match(stdout, /gavel execution prepare <prediction\.json> <proposal\.json>/);
  assert.match(stdout, /gavel execution submit <prediction\.json> <proposal\.json>/);
  assert.match(stdout, /natural language -> governance intent -> execution intent/);
  assert.match(stdout, /submission always re-validates against live chain state/);
});

test("execution prepare reads live chain state and emits a sealed intent", async () => {
  const { predictionPath, proposalPath } = governanceInputs();
  const stub = stubProvider({ voter: VOTER, actionTarget: ACTION_TARGET, proposer: PROPOSER });
  const rpc = await stub.start();
  try {
    const prepared = await runAsync([
      "execution", "prepare", predictionPath, proposalPath,
      "--support", "FOR", "--execution-address", VOTER, "--asset-owner", VOTER,
      "--acknowledge-security-review", "--acknowledge-prediction-review",
      "--rpc", rpc, "--stdout",
    ]);
    assert.equal(prepared.status, 0, prepared.stderr);

    // The adapter actually talked to the chain: state, tallies, actions, the
    // receipt, voting power, delegation and the canonical creation event all
    // came from the provider rather than from the input documents.
    for (const method of ["eth_chainId", "eth_blockNumber", "eth_getCode", "eth_call", "eth_getLogs"]) {
      assert.ok(stub.calls.includes(method), `${method} was never requested`);
    }

    const document = JSON.parse(prepared.stdout);
    assert.equal(document.kind, "VALIDATED_EXECUTION_INTENT");
    assert.match(document.intentHash, /^0x[0-9a-f]{64}$/);
    assert.equal(document.intent.source.dao, "nouns");
    assert.equal(document.intent.source.proposalId, "42");
    assert.equal(document.intent.source.support, "FOR");
    assert.equal(document.intent.operation, "CALL");
    assert.equal(document.validation.adapterVersion, "nouns@1.1.0");
    assert.equal(document.validation.proposalState, "ACTIVE");
    assert.equal(document.validation.selector, "0x8136730f");
    // The deadline came from the live proposal read, so staleness is checkable.
    assert.deepEqual(document.validation.deadline, { kind: "block", value: "200" });
    assert.deepEqual(document.validation.semantics, { canVoteMultipleTimes: false, canReplaceVote: false });

    // Nothing provider-specific is in the intent.
    for (const leaked of ["safeTxHash", "safeNonce", "sessionId", "providerRequestId"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(document.intent, leaked), false, leaked);
    }
  } finally {
    await stub.stop();
  }
});

test("execution prepare blocks when canonical chain state cannot be verified", async () => {
  const { predictionPath, proposalPath } = governanceInputs();
  // No ProposalCreated event: canonical freshness is unverifiable.
  const stub = stubProvider({
    voter: VOTER, actionTarget: ACTION_TARGET, proposer: PROPOSER, withCreationLog: false,
  });
  const rpc = await stub.start();
  try {
    const prepared = await runAsync([
      "execution", "prepare", predictionPath, proposalPath,
      "--support", "FOR", "--execution-address", VOTER, "--asset-owner", VOTER,
      "--acknowledge-security-review", "--acknowledge-prediction-review",
      "--rpc", rpc, "--stdout",
    ]);
    assert.equal(prepared.status, 2, prepared.stderr || prepared.stdout);
    const report = JSON.parse(prepared.stdout);
    assert.equal(report.status, "BLOCKED");
    assert.ok(report.blockers.some((blocker) => blocker.code === "CANONICAL_VERSION_UNAVAILABLE"));
  } finally {
    await stub.stop();
  }
});

test("execution prepare fails closed when the chain disagrees with the inputs", async () => {
  const { predictionPath, proposalPath } = governanceInputs();
  const stub = stubProvider({
    voter: VOTER,
    actionTarget: ACTION_TARGET,
    proposer: PROPOSER,
    delegatee: "0x00000000000000000000000000000000000000ff",
    state: 3, // DEFEATED
  });
  const rpc = await stub.start();
  try {
    const prepared = await runAsync([
      "execution", "prepare", predictionPath, proposalPath,
      "--support", "FOR", "--execution-address", VOTER, "--asset-owner", VOTER,
      "--acknowledge-security-review", "--acknowledge-prediction-review",
      "--rpc", rpc, "--stdout",
    ]);
    assert.equal(prepared.status, 2);
    const codes = JSON.parse(prepared.stdout).blockers.map((blocker) => blocker.code);
    assert.ok(codes.includes("PROPOSAL_NOT_ACTIVE"), codes.join(", "));
    assert.ok(codes.includes("DELEGATION_MISMATCH"), codes.join(", "));
  } finally {
    await stub.stop();
  }
});

test("a doctored proposal cannot be laundered into a sealed intent", async () => {
  // The blocker-2 attack at the CLI: keep the same governor and the same valid
  // selector, but point the inputs at a different proposal than the chain
  // describes. Live revalidation is what catches it.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-doctored-"));
  const predictionPath = path.join(scratch, "prediction.json");
  const proposalPath = path.join(scratch, "proposal.json");
  fs.writeFileSync(predictionPath, JSON.stringify(prediction({ proposalId: "999" })));
  fs.writeFileSync(proposalPath, JSON.stringify(proposal({ id: "999" })));

  const stub = stubProvider({ voter: VOTER, actionTarget: ACTION_TARGET, proposer: PROPOSER });
  const rpc = await stub.start();
  try {
    const prepared = await runAsync([
      "execution", "prepare", predictionPath, proposalPath,
      "--support", "FOR", "--execution-address", VOTER, "--asset-owner", VOTER,
      "--acknowledge-security-review", "--acknowledge-prediction-review",
      "--rpc", rpc, "--stdout",
    ]);
    assert.notEqual(prepared.status, 0, "a proposal the chain does not describe was accepted");
    // The chain reports proposal 42, so the canonical identity check fails.
    const output = prepared.stdout || prepared.stderr;
    assert.match(output, /CANONICAL_PROPOSAL_MISMATCH|CANONICAL_VERSION_UNAVAILABLE|PREDICTION_PROPOSAL_MISMATCH/);
  } finally {
    await stub.stop();
  }
});

test("execution prepare requires governance inputs and an explicit support choice", () => {
  const { predictionPath, proposalPath } = governanceInputs();

  const noSupport = run(["execution", "prepare", predictionPath, proposalPath, "--stdout"]);
  assert.notEqual(noSupport.status, 0);
  assert.match(noSupport.stderr, /requires --support/);

  // A stored preparation or intent document is not an accepted input: there is
  // no path that mints a sealed intent from JSON alone.
  const single = run(["execution", "prepare", predictionPath, "--support", "FOR"]);
  assert.notEqual(single.status, 0);
  assert.match(single.stderr, /requires prediction and normalized proposal JSON paths/);
});

test("execution submit re-validates live and never authorizes from a document", () => {
  const { scratch, predictionPath, proposalPath } = governanceInputs();

  // A hand-written transaction is not an accepted input, whatever it is named.
  const arbitrary = path.join(scratch, "arbitrary.json");
  fs.writeFileSync(
    arbitrary,
    JSON.stringify({ to: "0x00000000000000000000000000000000000000ff", data: "0xdeadbeef", value: "0" }),
  );
  const refused = run(["execution", "submit", arbitrary, "--mode", "safe-supervised"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires prediction and normalized proposal JSON paths/);

  // Nor is a previously emitted intent document: submit takes governance
  // inputs, because a document cannot be re-verified against chain state.
  const intentDocument = path.join(scratch, "intent.json");
  fs.writeFileSync(intentDocument, JSON.stringify({ kind: "VALIDATED_EXECUTION_INTENT", intentHash: `0x${"11".repeat(32)}` }));
  const fromDocument = run(["execution", "submit", intentDocument, "--mode", "safe-supervised"]);
  assert.notEqual(fromDocument.status, 0);
  assert.match(fromDocument.stderr, /requires prediction and normalized proposal JSON paths/);

  // Mode selection stays explicit.
  const noProfile = run(["execution", "submit", predictionPath, proposalPath, "--support", "FOR"]);
  assert.notEqual(noProfile.status, 0);
  assert.match(noProfile.stderr, /requires --profile/);
});

test("execution submit validates the profile before doing any governance work", () => {
  const { scratch, predictionPath, proposalPath } = governanceInputs();
  const write = (name, profile) => {
    const target = path.join(scratch, name);
    fs.writeFileSync(target, JSON.stringify(profile));
    return target;
  };

  const safeProfile = write("safe.json", {
    version: 1,
    mode: "safe-supervised",
    safe: {
      address: "0x0000000000000000000000000000000000000003",
      chainId: 1,
      proposalIdentity: "local:safe-proposer-main",
    },
  });
  const contradicting = run([
    "execution", "submit", predictionPath, proposalPath,
    "--support", "FOR", "--profile", safeProfile, "--mode", "waap-autonomous",
  ]);
  assert.notEqual(contradicting.status, 0);
  assert.match(contradicting.stderr, /does not match the profile mode/);

  const incomplete = write("incomplete.json", { version: 1, mode: "safe-supervised" });
  const rejected = run(["execution", "submit", predictionPath, proposalPath, "--support", "FOR", "--profile", incomplete]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /requires a 'safe' configuration block/);

  // A profile using a plaintext environment key is refused for submission.
  const development = write("development.json", {
    version: 1,
    mode: "safe-supervised",
    safe: {
      address: "0x0000000000000000000000000000000000000003",
      chainId: 1,
      proposalIdentity: "env:GAVEL_PROPOSER_KEY",
    },
  });
  const insecure = run(["execution", "submit", predictionPath, proposalPath, "--support", "FOR", "--profile", development]);
  assert.notEqual(insecure.status, 0);
  assert.match(insecure.stderr, /plaintext environment keys/);
});

test("identity create makes an encrypted, scope-bound Safe proposal identity", () => {
  const created = run(
    ["identity", "create", "--type", "safe-proposer", "--safe", "0x0000000000000000000000000000000000000003", "--label", "safe-proposer-main"],
    { GAVEL_IDENTITY_PASSPHRASE: "a-long-enough-passphrase" },
  );
  assert.equal(created.status, 0, created.stderr);
  const summary = JSON.parse(created.stdout);

  assert.equal(summary.role, "proposal");
  assert.equal(summary.reference, "local:safe-proposer-main");
  assert.match(summary.address, /^0x[0-9a-fA-F]{40}$/);
  assert.deepEqual(summary.capabilities, ["proposeSafeTransaction"]);
  assert.equal(summary.scope.safeAddress, "0x0000000000000000000000000000000000000003");
  // The documented installation flow: show the address, authorize as a
  // delegate, verify, bind.
  assert.match(summary.nextSteps.join(" "), /as a delegate \(not an owner\)/);
  assert.match(summary.nextSteps.join(" "), /Human Safe owners\s+retain authorization/);
  assert.match(summary.nextSteps.join(" "), /revoked by removing the delegate/);

  // The key exists on disk only encrypted, at 0600.
  const stored = JSON.parse(fs.readFileSync(summary.output, "utf8"));
  assert.equal(stored.kind, "GAVEL_PROPOSAL_IDENTITY");
  assert.equal(stored.role, "proposal");
  assert.equal(stored.keystore.version, 3);
  assert.ok(stored.keystore.crypto || stored.keystore.Crypto);
  assert.equal(fs.statSync(summary.output).mode & 0o777, 0o600);

  const serialized = fs.readFileSync(summary.output, "utf8");
  assert.doesNotMatch(serialized, /"privateKey"/);
  assert.doesNotMatch(serialized, /a-long-enough-passphrase/);

  // Two identities are two different keys.
  const second = run(
    ["identity", "create", "--type", "safe-proposer", "--safe", "0x0000000000000000000000000000000000000003", "--label", "other"],
    { GAVEL_IDENTITY_PASSPHRASE: "a-long-enough-passphrase" },
  );
  assert.notEqual(JSON.parse(second.stdout).address, summary.address);
});

test("identity create refuses a weak or missing passphrase and unsupported roles", () => {
  const args = ["identity", "create", "--type", "safe-proposer", "--safe", "0x0000000000000000000000000000000000000003"];

  const missing = run(args, { GAVEL_IDENTITY_PASSPHRASE: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /at least 12 characters/);
  assert.match(missing.stderr, /never written to disk/);

  const weak = run(args, { GAVEL_IDENTITY_PASSPHRASE: "short" });
  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /at least 12 characters/);

  const noSafe = run(["identity", "create", "--type", "safe-proposer"], { GAVEL_IDENTITY_PASSPHRASE: "a-long-enough-passphrase" });
  assert.notEqual(noSafe.status, 0);
  assert.match(noSafe.stderr, /requires --safe/);

  // There is no `identity create --type waap-executor`: an autonomous
  // execution identity is not something the supervised install flow mints.
  const wrongType = run(
    ["identity", "create", "--type", "execution", "--safe", "0x0000000000000000000000000000000000000003"],
    { GAVEL_IDENTITY_PASSPHRASE: "a-long-enough-passphrase" },
  );
  assert.notEqual(wrongType.status, 0);
  assert.match(wrongType.stderr, /--type safe-proposer/);

  const wrongSubcommand = run(["identity", "list"]);
  assert.notEqual(wrongSubcommand.status, 0);
  assert.match(wrongSubcommand.stderr, /subcommand create/);
  const wrongExecution = run(["execution", "propose"]);
  assert.notEqual(wrongExecution.status, 0);
  assert.match(wrongExecution.stderr, /subcommands prepare and submit/);
});
