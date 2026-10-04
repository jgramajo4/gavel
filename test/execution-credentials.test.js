"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalCredential, resolveCredential } = require("../packages/core/src/execution/credentials");

function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(), "gavel-credential-")); }
const context = (dataDir, reference = "local:proposer") => ({ dataDir, credentialRef: reference, label: "proposer", passphraseEnv: "TEST_PROPOSER_SECRET", env: {} });

test("local credential is exclusive and resolves without exposing its value in errors", async () => {
  const dataDir = fixture();
  const secret = "test-only-proposer-passphrase";
  await createLocalCredential({ dataDir, label: "proposer", secret });
  const target = path.join(dataDir, "credentials", "proposer.secret");
  assert.equal(fs.readFileSync(target, "utf8"), secret);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
  assert.equal(await resolveCredential(context(dataDir)), secret);
  await createLocalCredential({ dataDir, label: "second", secret: "another-secret" });
  assert.equal(fs.readFileSync(path.join(dataDir, "credentials", "second.secret"), "utf8"), "another-secret");
  await assert.rejects(createLocalCredential({ dataDir, label: "proposer", secret: "replacement" }));
  assert.equal(fs.readFileSync(target, "utf8"), secret);
  assert.deepEqual(fs.readdirSync(path.dirname(target)).sort(), ["proposer.secret", "second.secret"]);
});

test("env override precedes local file, including insecure local file", async () => {
  const dataDir = fixture();
  await createLocalCredential({ dataDir, label: "proposer", secret: "local" });
  fs.chmodSync(path.join(dataDir, "credentials", "proposer.secret"), 0o644);
  assert.equal(await resolveCredential({ ...context(dataDir), env: { TEST_PROPOSER_SECRET: "env-secret" } }), "env-secret");
  await assert.rejects(resolveCredential({ ...context(dataDir), env: { TEST_PROPOSER_SECRET: "" } }), /empty/i);
  await assert.rejects(resolveCredential(context(dataDir)), /credential/i);
});

test("local resolution rejects missing, empty, symlinked, insecure and malformed references", async () => {
  const dataDir = fixture();
  await assert.rejects(resolveCredential(context(dataDir)), /credential/i);
  await assert.rejects(createLocalCredential({ dataDir, label: "../escape", secret: "x" }), /label/i);
  await assert.rejects(resolveCredential(context(dataDir, "local:../escape")), /reference/i);
  await createLocalCredential({ dataDir, label: "proposer", secret: "nonempty" });
  const target = path.join(dataDir, "credentials", "proposer.secret");
  fs.writeFileSync(target, "");
  await assert.rejects(resolveCredential(context(dataDir)), /credential/i);
  fs.unlinkSync(target);
  fs.symlinkSync(path.join(dataDir, "external"), target);
  await assert.rejects(resolveCredential(context(dataDir)), /credential/i);
  fs.unlinkSync(target);
  fs.writeFileSync(target, "secret", { mode: 0o600 });
  fs.chmodSync(path.dirname(target), 0o755);
  await assert.rejects(resolveCredential(context(dataDir)), /credential/i);
  fs.chmodSync(path.dirname(target), 0o700);
  fs.unlinkSync(target);
  fs.rmdirSync(path.dirname(target));
  fs.mkdirSync(path.join(dataDir, "elsewhere"), { mode: 0o700 });
  fs.symlinkSync(path.join(dataDir, "elsewhere"), path.dirname(target));
  await assert.rejects(resolveCredential(context(dataDir)), /credential/i);
  await assert.rejects(createLocalCredential({ dataDir, label: "different", secret: "secret" }), /credential/i);
});
