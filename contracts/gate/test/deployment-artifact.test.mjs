import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const VALIDATOR = join(ROOT, "script/capture-base-sepolia-deployment.mjs");
const REAL_CAST = process.env.REAL_CAST || "/home/pi/.foundry/bin/cast";
const ADDRESS = {
  token: "0x1111111111111111111111111111111111111111",
  splitter: "0x2222222222222222222222222222222222222222",
  recipient: "0x3333333333333333333333333333333333333333",
  signer: "0x4444444444444444444444444444444444444444",
};
const TX = { token: `0x${"a".repeat(64)}`, splitter: `0x${"b".repeat(64)}` };
const CODE = { token: "0x60006000", splitter: "0x60016001" };

function cast(...args) {
  return execFileSync(REAL_CAST, args, { encoding: "utf8" }).trim();
}

function domain(name, version, verifyingContract) {
  const encoded = cast(
    "abi-encode",
    "f(bytes32,bytes32,bytes32,uint256,address)",
    cast("keccak", "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    cast("keccak", name),
    cast("keccak", version),
    "84532",
    verifyingContract,
  );
  return cast("keccak", encoded);
}

const EXPECTED = {
  tokenCodeHash: cast("keccak", CODE.token),
  splitterCodeHash: cast("keccak", CODE.splitter),
  tokenDomain: domain("USD Coin", "2", ADDRESS.token),
  splitterDomain: domain("GavelGateSplitter", "1", ADDRESS.splitter),
};

function setupSyntheticFixture() {
  const dir = mkdtempSync(join(tmpdir(), "gavel-gate-synthetic-deployment-"));
  const mockCast = join(dir, "cast-mock.mjs");
  writeFileSync(mockCast, `#!/usr/bin/env node
const [command, ...args] = process.argv.slice(2);
const A = ${JSON.stringify(ADDRESS)};
const T = ${JSON.stringify(TX)};
const C = ${JSON.stringify(CODE)};
const E = ${JSON.stringify(EXPECTED)};
const mode = process.env.SYNTHETIC_CAST_MODE || "ok";
if (command === "keccak" || command === "abi-encode") {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(${JSON.stringify(REAL_CAST)}, [command, ...args], { encoding: "utf8" });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
}
if (command === "chain-id") { console.log(mode === "wrong-chain" ? "8453" : "84532"); process.exit(0); }
if (command === "receipt") {
  const tx = args[0];
  if (mode === "missing-receipt") process.exit(1);
  const token = tx === T.token;
  const receipt = { transactionHash: tx, status: mode === "failed-receipt" && token ? "0x0" : "0x1", blockNumber: token ? "0x64" : "0xc8", contractAddress: token ? A.token : A.splitter };
  if (mode === "mismatched-receipt" && token) receipt.contractAddress = A.recipient;
  console.log(JSON.stringify(receipt)); process.exit(0);
}
if (command === "code") {
  const value = args[0] === A.token ? C.token : C.splitter;
  console.log(mode === "empty-rpc-code" && args[0] === A.token ? "0x" : value); process.exit(0);
}
if (command === "call") {
  const [address, signature] = args;
  const values = {
    "name()(string)": '"USD Coin"', "version()(string)": '"2"', "symbol()(string)": '"USDC"',
    "decimals()(uint8)": "6", "DOMAIN_SEPARATOR()(bytes32)": address === A.token ? E.tokenDomain : E.splitterDomain,
    "usdc()(address)": A.token, "gavelRecipient()(address)": A.recipient,
    "quoteSigner()(address)": A.signer, "GAVEL_FEE_AMOUNT()(uint256)": "250000",
  };
  if (!(signature in values)) process.exit(1);
  console.log(values[signature]); process.exit(0);
}
process.exit(1);
`);
  chmodSync(mockCast, 0o755);
  const tokenRun = join(dir, "token-run.json");
  const splitterRun = join(dir, "splitter-run.json");
  writeFileSync(tokenRun, JSON.stringify({ syntheticFixture: true, transactions: [{ contractName: "BaseSepoliaTestUSDC3009", hash: TX.token, contractAddress: ADDRESS.token }] }));
  writeFileSync(splitterRun, JSON.stringify({ syntheticFixture: true, transactions: [{ contractName: "GavelGateSplitter", hash: TX.splitter, contractAddress: ADDRESS.splitter }] }));
  return { dir, mockCast, tokenRun, splitterRun, artifact: join(dir, "synthetic-artifact.json") };
}

function run(args, fixture, extraEnv = {}) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CAST: fixture.mockCast, BASE_SEPOLIA_RPC_URL: "synthetic://not-a-live-rpc", SYNTHETIC_DEPLOYMENT_TEST: "yes", ...extraEnv },
  });
}

function mutateArtifact(fixture, mutate) {
  const value = JSON.parse(readFileSync(fixture.artifact, "utf8"));
  mutate(value);
  const path = join(fixture.dir, `mutated-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

test("synthetic capture builds and validates one fail-closed deployment artifact", () => {
  const fixture = setupSyntheticFixture();
  const captured = run(["capture", "--token-run", fixture.tokenRun, "--splitter-run", fixture.splitterRun, "--output", fixture.artifact], fixture);
  assert.equal(captured.status, 0, captured.stderr);
  assert.equal(captured.stdout.includes("synthetic://not-a-live-rpc"), false);
  const artifact = JSON.parse(readFileSync(fixture.artifact, "utf8"));
  assert.equal(artifact.token.label, "base-sepolia-test-usdc3009-unrestricted-mint");
  assert.equal(artifact.token.code.runtimeCodeHash, EXPECTED.tokenCodeHash);
  assert.equal(artifact.splitter.code.runtimeCodeHash, EXPECTED.splitterCodeHash);
  const validated = run(["validate", fixture.artifact], fixture);
  assert.equal(validated.status, 0, validated.stderr);
});

test("synthetic validator rejects every required malformed or mismatched evidence class", async (t) => {
  const fixture = setupSyntheticFixture();
  assert.equal(run(["capture", "--token-run", fixture.tokenRun, "--splitter-run", fixture.splitterRun, "--output", fixture.artifact], fixture).status, 0);
  const cases = [
    ["wrong environment", (a) => { a.environment = "production"; }],
    ["wrong artifact chain", (a) => { a.chainId = "8453"; }],
    ["blank source commit", (a) => { a.sourceCommit = ""; }],
    ["invalid source commit", (a) => { a.sourceCommit = "f".repeat(40); }],
    ["zero token", (a) => { a.token.address = `0x${"0".repeat(40)}`; }],
    ["malformed splitter", (a) => { a.splitter.address = "0x1234"; }],
    ["zero recipient", (a) => { a.splitter.gavelRecipient = `0x${"0".repeat(40)}`; }],
    ["zero signer", (a) => { a.splitter.quoteSigner = `0x${"0".repeat(40)}`; }],
    ["missing transaction hash", (a) => { delete a.token.deployment.hash; }],
    ["missing deployment block", (a) => { delete a.splitter.deployment.block; }],
    ["empty runtime bytecode", (a) => { a.token.code.runtimeBytecode = "0x"; }],
    ["runtime code hash mismatch", (a) => { a.splitter.code.runtimeCodeHash = `0x${"c".repeat(64)}`; }],
    ["wrong token name", (a) => { a.token.name = "USDC"; }],
    ["wrong token version", (a) => { a.token.version = "1"; }],
    ["wrong token decimals", (a) => { a.token.decimals = 18; }],
    ["wrong token domain", (a) => { a.token.domainSeparator = `0x${"d".repeat(64)}`; }],
    ["splitter token mismatch", (a) => { a.splitter.token = ADDRESS.recipient; }],
    ["splitter recipient mismatch", (a) => { a.splitter.gavelRecipient = ADDRESS.token; }],
    ["splitter signer mismatch", (a) => { a.splitter.quoteSigner = ADDRESS.token; }],
    ["splitter fee mismatch", (a) => { a.splitter.gavelFeeAmount = "1"; }],
    ["wrong splitter domain", (a) => { a.splitter.domainSeparator = `0x${"e".repeat(64)}`; }],
    ["null required evidence", (a) => { a.token.deployment = null; }],
    ["unknown schema field", (a) => { a.rpcUrl = "forbidden"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const result = run(["validate", mutateArtifact(fixture, mutate)], fixture);
      assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
      assert.equal(`${result.stdout}${result.stderr}`.includes("synthetic://not-a-live-rpc"), false);
    });
  }
  for (const mode of ["wrong-chain", "missing-receipt", "failed-receipt", "mismatched-receipt", "empty-rpc-code"]) {
    await t.test(mode, () => {
      const result = run(["validate", fixture.artifact], fixture, { SYNTHETIC_CAST_MODE: mode });
      assert.notEqual(result.status, 0, `${mode} unexpectedly passed`);
    });
  }
});
