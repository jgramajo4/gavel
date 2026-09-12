"use strict";

/**
 * Opt-in real Safe acceptance test.
 *
 * This file deliberately contains no transaction fixture and no credential. An
 * operator must supply a reviewed, currently valid governance fixture and pin
 * its expected intent hash before the test will create a real pending proposal.
 * The test never supplies an owner signature and never executes the proposal.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const test = require("node:test");
const Safe = require("@safe-global/protocol-kit").default;
const SafeApiKit = require("@safe-global/api-kit").default;
const { getAddress } = require("ethers");

const execFileAsync = promisify(execFile);
const enabled = process.env.GAVEL_SAFE_INTEGRATION_TEST === "1";
const skip = enabled ? false : "set GAVEL_SAFE_INTEGRATION_TEST=1 to run the real Safe proposal test";

const REQUIRED = [
  "GAVEL_SAFE_TEST_RPC_URL",
  "GAVEL_SAFE_TEST_SERVICE_URL",
  "GAVEL_SAFE_API_KEY",
  "GAVEL_SAFE_TEST_SAFE_ADDRESS",
  "GAVEL_SAFE_TEST_CHAIN_ID",
  "GAVEL_SAFE_TEST_PROFILE",
  "GAVEL_SAFE_TEST_IDENTITY_REFERENCE",
  "GAVEL_SAFE_TEST_PREDICTION",
  "GAVEL_SAFE_TEST_PROPOSAL",
  "GAVEL_SAFE_TEST_SUPPORT",
  "GAVEL_SAFE_TEST_ASSET_OWNER",
  "GAVEL_SAFE_TEST_EXPECTED_INTENT_HASH",
  "GAVEL_SAFE_TEST_REVIEWED_FIXTURE",
  "GAVEL_DATA_DIR",
];

function jsonFile(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function findRecord(root, id) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findRecord(target, id);
      if (found) return found;
    } else if (entry.name.endsWith(".json")) {
      const document = jsonFile(target);
      if (document.id === id) return { document, path: target };
    }
  }
  return null;
}

async function runGavel(args) {
  const cli = path.join(__dirname, "..", "packages", "cli", "bin", "gavel.js");
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function allDelegates(apiKit, safeAddress, delegateAddress) {
  const results = [];
  const seenOffsets = new Set();
  let offset;
  do {
    const page = await apiKit.getSafeDelegates({
      safeAddress,
      delegateAddress,
      ...(offset === undefined ? {} : { offset }),
    });
    assert.ok(page && Array.isArray(page.results), "Safe service returned malformed delegate data");
    results.push(...page.results);
    if (!page.next) break;
    const next = Number(new URL(page.next, "https://safe.invalid").searchParams.get("offset"));
    assert.ok(
      Number.isSafeInteger(next) && next >= 0 && !seenOffsets.has(next),
      "Safe service returned malformed delegate pagination",
    );
    seenOffsets.add(next);
    offset = next;
  } while (true);
  return results;
}

test("live Safe: validated reviewed intent is proposed by a non-owner delegate and read back by safeTxHash", {
  skip,
  timeout: 180_000,
}, async () => {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  assert.deepEqual(missing, [], `live Safe test is fail-closed; set: ${missing.join(", ")}`);
  assert.equal(
    process.env.GAVEL_SAFE_TEST_REVIEWED_FIXTURE,
    "1",
    "GAVEL_SAFE_TEST_REVIEWED_FIXTURE=1 is required after reviewing the fixture and Safe queue side effect",
  );

  const chainId = Number(process.env.GAVEL_SAFE_TEST_CHAIN_ID);
  assert.ok(Number.isSafeInteger(chainId) && chainId > 0, "GAVEL_SAFE_TEST_CHAIN_ID must be a positive integer");
  const safeAddress = getAddress(process.env.GAVEL_SAFE_TEST_SAFE_ADDRESS);
  const expectedIntentHash = process.env.GAVEL_SAFE_TEST_EXPECTED_INTENT_HASH;
  assert.match(expectedIntentHash, /^0x[0-9a-f]{64}$/, "GAVEL_SAFE_TEST_EXPECTED_INTENT_HASH must pin the reviewed intent");

  const profile = jsonFile(process.env.GAVEL_SAFE_TEST_PROFILE);
  assert.equal(profile.mode, "safe-supervised");
  assert.equal(getAddress(profile.safe.address), safeAddress);
  assert.equal(Number(profile.safe.chainId), chainId);
  assert.equal(profile.safe.proposalIdentity, process.env.GAVEL_SAFE_TEST_IDENTITY_REFERENCE);
  assert.equal(
    profile.safe.transactionServiceUrl,
    process.env.GAVEL_SAFE_TEST_SERVICE_URL,
    "the profile and live-test Transaction Service URL must match",
  );

  const identityMatch = /^local:([A-Za-z0-9._-]+)$/.exec(process.env.GAVEL_SAFE_TEST_IDENTITY_REFERENCE);
  assert.ok(identityMatch, "the live test requires a local:<label> encrypted proposal identity");
  const identityPath = path.join(process.env.GAVEL_DATA_DIR, "identities", `${identityMatch[1]}.json`);
  const identity = jsonFile(identityPath);
  const proposer = getAddress(identity.address);
  assert.equal(getAddress(identity.scope.safeAddress), safeAddress);
  assert.equal(Number(identity.scope.chainId), chainId);
  assert.ok(identity.passphraseEnv, "identity document must name its passphrase environment variable");
  assert.ok(process.env[identity.passphraseEnv], `set ${identity.passphraseEnv} to unlock the encrypted identity`);

  const protocolKit = await Safe.init({ provider: process.env.GAVEL_SAFE_TEST_RPC_URL, safeAddress });
  const owners = (await protocolKit.getOwners()).map(getAddress);
  assert.ok(owners.length > 0, "Safe owner set must be available");
  assert.equal(owners.includes(proposer), false, "proposal identity must not be a Safe owner");

  const apiKit = new SafeApiKit({
    chainId: BigInt(chainId),
    txServiceUrl: process.env.GAVEL_SAFE_TEST_SERVICE_URL,
    apiKey: process.env.GAVEL_SAFE_API_KEY,
  });
  const delegates = await allDelegates(apiKit, safeAddress, proposer);
  assert.ok(
    delegates.some((entry) =>
      getAddress(entry.safe) === safeAddress &&
      getAddress(entry.delegate) === proposer &&
      owners.includes(getAddress(entry.delegator)) &&
      Date.parse(entry.expiryDate) > Date.now()),
    "proposal identity must be an unexpired delegate authorized by a current Safe owner",
  );

  const common = [
    process.env.GAVEL_SAFE_TEST_PREDICTION,
    process.env.GAVEL_SAFE_TEST_PROPOSAL,
    "--support", process.env.GAVEL_SAFE_TEST_SUPPORT,
    "--execution-address", safeAddress,
    "--asset-owner", process.env.GAVEL_SAFE_TEST_ASSET_OWNER,
    "--acknowledge-security-review",
    "--acknowledge-prediction-review",
    "--rpc", process.env.GAVEL_SAFE_TEST_RPC_URL,
  ];
  if (process.env.GAVEL_SAFE_TEST_REASON) common.push("--reason", process.env.GAVEL_SAFE_TEST_REASON);

  const prepared = JSON.parse(await runGavel(["execution", "prepare", ...common, "--stdout"]));
  assert.equal(prepared.intentHash, expectedIntentHash, "live validation no longer matches the reviewed intent hash");
  assert.equal(getAddress(prepared.intent.actor), safeAddress);
  assert.equal(Number(prepared.intent.chainId), chainId);
  assert.equal(prepared.intent.operation, "CALL");

  const status = await runGavel([
    "safe", "delegate", "status",
    "--safe", safeAddress,
    "--chain-id", String(chainId),
    "--identity", process.env.GAVEL_SAFE_TEST_IDENTITY_REFERENCE,
    "--rpc", process.env.GAVEL_SAFE_TEST_RPC_URL,
    "--safe-api-url", process.env.GAVEL_SAFE_TEST_SERVICE_URL,
  ]);
  assert.equal(status, "authorized");

  const submitted = JSON.parse(await runGavel([
    "execution", "submit", ...common,
    "--profile", process.env.GAVEL_SAFE_TEST_PROFILE,
    "--mode", "safe-supervised",
    "--expect-intent", expectedIntentHash,
  ]));
  assert.equal(submitted.ok, true);
  assert.equal(submitted.mode, "safe-supervised");
  assert.equal(getAddress(submitted.safe), safeAddress);
  assert.match(submitted.safeTxHash, /^0x[0-9a-fA-F]{64}$/);

  // A new CLI process must reconcile/deduplicate from the durable record rather
  // than proposing a second Safe transaction.
  const restarted = JSON.parse(await runGavel([
    "execution", "submit", ...common,
    "--profile", process.env.GAVEL_SAFE_TEST_PROFILE,
    "--mode", "safe-supervised",
    "--expect-intent", expectedIntentHash,
  ]));
  assert.equal(restarted.ok, true);
  assert.equal(restarted.safeTxHash.toLowerCase(), submitted.safeTxHash.toLowerCase());
  assert.equal(restarted.deduplicated, true);

  const readback = await apiKit.getTransaction(submitted.safeTxHash);
  assert.equal(String(readback.safeTxHash).toLowerCase(), submitted.safeTxHash.toLowerCase());
  assert.equal(getAddress(readback.safe), safeAddress);
  assert.equal(getAddress(readback.to), getAddress(prepared.intent.target));
  assert.equal(String(readback.data).toLowerCase(), prepared.intent.data.toLowerCase());
  assert.equal(BigInt(readback.value), BigInt(prepared.intent.value));
  assert.equal(Number(readback.operation), 0);
  assert.equal(String(readback.nonce), String(submitted.nonce));
  assert.equal(
    getAddress(readback.proposedByDelegate),
    proposer,
    "Safe service proposedByDelegate must be the configured proposal identity",
  );
  assert.equal(readback.isExecuted, false, "the acceptance boundary is a pending proposal, never execution");
  assert.equal(
    (readback.confirmations || []).some((confirmation) => getAddress(confirmation.owner) === proposer),
    false,
    "the proposal identity must not count as a Safe owner confirmation",
  );

  const record = findRecord(path.join(process.env.GAVEL_DATA_DIR, "executions"), submitted.executionRecord);
  assert.ok(record, "execution record must be persisted under GAVEL_DATA_DIR/executions");
  assert.equal(record.document.providerData.safeTxHash.toLowerCase(), submitted.safeTxHash.toLowerCase());
  assert.equal(record.document.intentHash, expectedIntentHash);
});
