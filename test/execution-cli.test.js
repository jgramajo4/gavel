"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "..", "packages", "cli", "bin", "gavel.js");

function run(args, env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-cli-"));
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, GAVEL_DATA_DIR: dataDir, GAVEL_STRUCTURED_ERRORS: "0", ...env },
  });
  return { ...result, dataDir };
}

test("the CLI exposes no surface that submits caller-supplied calldata", () => {
  const source = fs.readFileSync(CLI, "utf8");
  const { stdout } = run(["--help"]);

  // `gavel safe propose --to ... --data ...` would bypass the governance
  // boundary entirely. There must be no such command and no such flags.
  assert.doesNotMatch(stdout, /safe propose/);
  assert.doesNotMatch(stdout, /--calldata/);
  assert.doesNotMatch(source, /"calldata":\s*\{\s*type:/);
  assert.doesNotMatch(source, /command === "safe"/);

  // The execution commands read Gavel-generated documents, not transactions.
  assert.match(stdout, /gavel execution prepare <preparation\.json>/);
  assert.match(stdout, /gavel execution submit <validated-intent\.json>/);
  assert.match(stdout, /natural language -> governance intent -> execution intent/);
});

test("execution prepare lifts a validated preparation into a canonical intent", async () => {
  const { prepareNounsVote } = require("./helpers/nouns-preparation");
  const { proposal } = require("./helpers/nouns-preparation");
  const preparation = await prepareNounsVote();

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-in-"));
  const preparationPath = path.join(scratch, "preparation.json");
  const proposalPath = path.join(scratch, "proposal.json");
  fs.writeFileSync(preparationPath, JSON.stringify(preparation));
  fs.writeFileSync(proposalPath, JSON.stringify(proposal()));

  const prepared = run(["execution", "prepare", preparationPath, "--proposal", proposalPath, "--stdout"]);
  assert.equal(prepared.status, 0, prepared.stderr);
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
  // The proposal supplied the deadline, and Nouns is block-timed.
  assert.deepEqual(document.validation.deadline, { kind: "block", value: "200" });
  // Nouns permits neither repeat nor replacement votes.
  assert.deepEqual(document.validation.semantics, { canVoteMultipleTimes: false, canReplaceVote: false });

  // Nothing provider-specific is in the intent.
  for (const leaked of ["safeTxHash", "safeNonce", "sessionId", "providerRequestId"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(document.intent, leaked), false, leaked);
  }

  // Without a proposal the intent is still valid, but the deadline is unknown.
  const noDeadline = run(["execution", "prepare", preparationPath, "--stdout"]);
  assert.equal(noDeadline.status, 0, noDeadline.stderr);
  const bare = JSON.parse(noDeadline.stdout);
  assert.deepEqual(bare.validation.deadline, { kind: "none", value: null });
  assert.equal(bare.intentHash, document.intentHash, "the deadline changed the intent identity");

  // A blocked preparation cannot be lifted.
  const blocked = await prepareNounsVote({ state: 3 });
  const blockedPath = path.join(scratch, "blocked.json");
  fs.writeFileSync(blockedPath, JSON.stringify(blocked));
  const refused = run(["execution", "prepare", blockedPath, "--stdout"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /READY_TO_SIGN/);

  // Retargeted calldata does not survive re-validation against the adapter.
  const retargeted = {
    ...preparation,
    transaction: { ...preparation.transaction, to: "0x00000000000000000000000000000000000000ff" },
  };
  const retargetedPath = path.join(scratch, "retargeted.json");
  fs.writeFileSync(retargetedPath, JSON.stringify(retargeted));
  const rejected = run(["execution", "prepare", retargetedPath, "--stdout"]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /not a declared nouns governance contract/);
});

test("execution prepare writes the intent under GAVEL_DATA_DIR with restrictive permissions", async () => {
  const { prepareNounsVote } = require("./helpers/nouns-preparation");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-out-"));
  const preparationPath = path.join(scratch, "preparation.json");
  fs.writeFileSync(preparationPath, JSON.stringify(await prepareNounsVote()));

  const prepared = run(["execution", "prepare", preparationPath]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const summary = JSON.parse(prepared.stdout);

  assert.ok(summary.output.startsWith(prepared.dataDir), summary.output);
  assert.ok(summary.output.includes(path.join("intents", "nouns")));
  assert.match(summary.intentHash, /^0x[0-9a-f]{64}$/);
  assert.equal(summary.autonomyAllowed, false);
  assert.equal(fs.statSync(summary.output).mode & 0o777, 0o600);
});

test("execution submit refuses anything that is not a Gavel-generated intent", async () => {
  const { prepareNounsVote } = require("./helpers/nouns-preparation");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-submit-"));

  // A hand-written transaction is not an intent, whatever it is named.
  const arbitrary = path.join(scratch, "arbitrary.json");
  fs.writeFileSync(
    arbitrary,
    JSON.stringify({ to: "0x00000000000000000000000000000000000000ff", data: "0xdeadbeef", value: "0" }),
  );
  const refused = run(["execution", "submit", arbitrary, "--mode", "safe-supervised"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /only a document produced by `gavel execution prepare`/);

  // The preparation itself is also not an intent.
  const preparationPath = path.join(scratch, "preparation.json");
  fs.writeFileSync(preparationPath, JSON.stringify(await prepareNounsVote()));
  const wrongDocument = run(["execution", "submit", preparationPath, "--mode", "safe-supervised"]);
  assert.notEqual(wrongDocument.status, 0);
  assert.match(wrongDocument.stderr, /only a document produced by/);
});

test("execution submit requires an explicit execution profile and a matching mode", async () => {
  const { prepareNounsVote } = require("./helpers/nouns-preparation");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-exec-profile-"));
  const preparationPath = path.join(scratch, "preparation.json");
  fs.writeFileSync(preparationPath, JSON.stringify(await prepareNounsVote()));
  const prepared = run(["execution", "prepare", preparationPath, "--stdout"]);
  const intentPath = path.join(scratch, "intent.json");
  fs.writeFileSync(intentPath, prepared.stdout);

  // Mode selection is explicit: there is no implicit default.
  const noProfile = run(["execution", "submit", intentPath, "--mode", "safe-supervised"]);
  assert.notEqual(noProfile.status, 0);
  assert.match(noProfile.stderr, /requires --profile/);

  const profilePath = path.join(scratch, "profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify({
      version: 1,
      mode: "safe-supervised",
      safe: {
        address: "0x0000000000000000000000000000000000000003",
        chainId: 1,
        proposalIdentity: "local:safe-proposer-main",
      },
    }),
  );

  // A valid profile with no registered backend refuses loudly rather than
  // pretending to submit.
  const noBackend = run(["execution", "submit", intentPath, "--profile", profilePath]);
  assert.notEqual(noBackend.status, 0);
  assert.match(noBackend.stderr, /No execution backend is registered for safe-supervised/);
  assert.match(noBackend.stderr, /proposal=local:safe-proposer-main/);

  // A mode that contradicts the profile is an error, not a silent override.
  const contradicting = run(["execution", "submit", intentPath, "--profile", profilePath, "--mode", "waap-autonomous"]);
  assert.notEqual(contradicting.status, 0);
  assert.match(contradicting.stderr, /does not match the profile mode/);

  // A profile missing its mode's configuration block is rejected.
  const incomplete = path.join(scratch, "incomplete.json");
  fs.writeFileSync(incomplete, JSON.stringify({ version: 1, mode: "safe-supervised" }));
  const rejected = run(["execution", "submit", intentPath, "--profile", incomplete]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /requires a 'safe' configuration block/);
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
