#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const CHAIN_ID = "84532";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const BYTECODE = /^0x(?:[0-9a-fA-F]{2})+$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CAST = process.env.CAST || `${process.env.HOME}/.foundry/bin/cast`;
const FORGE = process.env.FORGE || `${process.env.HOME}/.foundry/bin/forge`;
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const OUTPUT_ROOT = resolve(ROOT, "deployments/base-sepolia");

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, required, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has inconsistent fields`);
  }
}

function address(value, label) {
  if (!ADDRESS.test(String(value ?? "")) || String(value).toLowerCase() === ZERO_ADDRESS) {
    fail(`${label} must be a nonzero address`);
  }
  return String(value);
}

function bytes32(value, label) {
  if (!BYTES32.test(String(value ?? "")) || String(value).toLowerCase() === ZERO_BYTES32) {
    fail(`${label} must be nonzero bytes32`);
  }
  return String(value).toLowerCase();
}

function uint(value, label) {
  if (!UINT.test(String(value ?? ""))) fail(`${label} must be an unsigned decimal string`);
  return String(value);
}

function positiveUint(value, label) {
  const parsed = uint(value, label);
  if (parsed === "0") fail(`${label} must be greater than zero`);
  return parsed;
}

function same(left, right, label) {
  if (String(left).toLowerCase() !== String(right).toLowerCase()) fail(`${label} mismatch`);
}

function run(command, args = []) {
  try {
    return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    fail("required local command failed");
  }
}

function cast(args, rpc = null) {
  return run(CAST, rpc ? [...args, "--rpc-url", rpc] : args);
}

function call(rpc, target, signature) {
  return cast(["call", target, signature], rpc);
}

function callString(rpc, target, signature) {
  const raw = call(rpc, target, signature);
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch {
    // Some cast versions print an unquoted decoded string.
  }
  return raw;
}

function decimal(value, label) {
  try {
    return BigInt(value).toString(10);
  } catch {
    fail(`${label} is not an integer`);
  }
}

function keccak(value) {
  return bytes32(cast(["keccak", value]), "keccak result");
}

function domainSeparator(name, version, verifyingContract) {
  const encoded = cast([
    "abi-encode",
    "f(bytes32,bytes32,bytes32,uint256,address)",
    keccak("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak(name),
    keccak(version),
    CHAIN_ID,
    verifyingContract,
  ]);
  return keccak(encoded);
}

function rpcUrl() {
  const value = process.env.BASE_SEPOLIA_RPC_URL;
  if (typeof value !== "string" || value.trim() === "") fail("BASE_SEPOLIA_RPC_URL is required");
  return value;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function assertCommit(commit) {
  if (!COMMIT.test(commit)) fail("sourceCommit must be a lowercase 40-byte git SHA");
  if (run("git", ["rev-parse", "HEAD"]) !== commit) fail("sourceCommit must equal the reviewed checkout HEAD");
}

function validateStructure(artifact) {
  exactKeys(artifact, ["schemaVersion", "environment", "chainId", "sourceCommit", "token", "splitter"], "artifact");
  if (artifact.schemaVersion !== 1 || artifact.environment !== "test" || artifact.chainId !== CHAIN_ID) {
    fail("artifact identity is invalid");
  }
  assertCommit(artifact.sourceCommit);
  exactKeys(artifact.token, ["label", "productionSafe", "address", "deployment", "code", "name", "version", "symbol", "decimals", "domainSeparator"], "token");
  if (artifact.token.label !== "base-sepolia-test-usdc3009-unrestricted-mint" || artifact.token.productionSafe !== false) {
    fail("token test-only identity is invalid");
  }
  address(artifact.token.address, "token.address");
  exactKeys(artifact.token.deployment, ["hash", "block"], "token.deployment");
  bytes32(artifact.token.deployment.hash, "token.deployment.hash");
  positiveUint(artifact.token.deployment.block, "token.deployment.block");
  exactKeys(artifact.token.code, ["runtimeBytecode", "runtimeCodeHash"], "token.code");
  if (!BYTECODE.test(String(artifact.token.code.runtimeBytecode ?? ""))) fail("token runtime bytecode is empty or malformed");
  bytes32(artifact.token.code.runtimeCodeHash, "token runtime code hash");
  if (artifact.token.name !== "USD Coin" || artifact.token.version !== "2" || artifact.token.symbol !== "USDC" || artifact.token.decimals !== 6) {
    fail("token metadata is invalid");
  }
  bytes32(artifact.token.domainSeparator, "token domain separator");

  exactKeys(artifact.splitter, ["address", "deployment", "code", "token", "gavelRecipient", "quoteSigner", "gavelFeeAmount", "domainSeparator"], "splitter");
  address(artifact.splitter.address, "splitter.address");
  address(artifact.splitter.token, "splitter.token");
  address(artifact.splitter.gavelRecipient, "splitter.gavelRecipient");
  address(artifact.splitter.quoteSigner, "splitter.quoteSigner");
  exactKeys(artifact.splitter.deployment, ["hash", "block"], "splitter.deployment");
  bytes32(artifact.splitter.deployment.hash, "splitter.deployment.hash");
  positiveUint(artifact.splitter.deployment.block, "splitter.deployment.block");
  exactKeys(artifact.splitter.code, ["runtimeBytecode", "runtimeCodeHash"], "splitter.code");
  if (!BYTECODE.test(String(artifact.splitter.code.runtimeBytecode ?? ""))) fail("splitter runtime bytecode is empty or malformed");
  bytes32(artifact.splitter.code.runtimeCodeHash, "splitter runtime code hash");
  if (artifact.splitter.gavelFeeAmount !== "250000") fail("splitter fee is invalid");
  bytes32(artifact.splitter.domainSeparator, "splitter domain separator");
  same(artifact.splitter.token, artifact.token.address, "splitter token binding");
}

function localCreationBytecode(contract, label) {
  const value = run(FORGE, ["inspect", contract, "bytecode"]);
  if (!BYTECODE.test(value)) fail(`${label} local creation bytecode is empty or malformed`);
  return value;
}

function expectedCreationInputs(artifact) {
  const token = localCreationBytecode(
    "src/test-only/BaseSepoliaTestUSDC3009.sol:BaseSepoliaTestUSDC3009",
    "token",
  );
  const splitter = localCreationBytecode("src/GavelGateSplitter.sol:GavelGateSplitter", "splitter");
  const constructorArgs = cast([
    "abi-encode",
    "f(address,address,address)",
    artifact.splitter.token,
    artifact.splitter.gavelRecipient,
    artifact.splitter.quoteSigner,
  ]);
  if (!BYTECODE.test(constructorArgs)) fail("splitter constructor encoding is malformed");
  return { token, splitter: `${splitter}${constructorArgs.slice(2)}` };
}

function creationTransaction(rpc, deployment, expectedInput, label) {
  let value;
  try {
    value = JSON.parse(cast(["tx", deployment.hash, "--json"], rpc));
  } catch {
    fail(`${label} deployment transaction is missing or malformed`);
  }
  object(value, `${label} deployment transaction`);
  if (!("hash" in value) || !("to" in value) || !("input" in value)) {
    fail(`${label} deployment transaction is incomplete`);
  }
  same(bytes32(value.hash, `${label} transaction hash`), deployment.hash, `${label} transaction hash`);
  if (value.to !== null) fail(`${label} deployment transaction must be contract creation`);
  if (!BYTECODE.test(String(value.input ?? ""))) fail(`${label} deployment input is malformed`);
  same(value.input, expectedInput, `${label} local creation input`);
}

function receipt(rpc, deployment, expectedAddress, label) {
  let value;
  try {
    value = JSON.parse(cast(["receipt", deployment.hash, "--json"], rpc));
  } catch {
    fail(`${label} deployment receipt is missing or malformed`);
  }
  object(value, `${label} deployment receipt`);
  if (decimal(value.status, `${label} receipt status`) !== "1") fail(`${label} deployment failed`);
  same(value.transactionHash, deployment.hash, `${label} receipt transaction`);
  same(address(value.contractAddress, `${label} receipt contractAddress`), expectedAddress, `${label} receipt contractAddress`);
  if (decimal(value.blockNumber, `${label} receipt block`) !== deployment.block) fail(`${label} receipt block mismatch`);
}

function readOnchain(rpc, tokenAddress, splitterAddress) {
  const tokenCode = cast(["code", tokenAddress], rpc);
  const splitterCode = cast(["code", splitterAddress], rpc);
  if (!BYTECODE.test(tokenCode) || !BYTECODE.test(splitterCode)) fail("deployed runtime bytecode is empty or malformed");
  return {
    token: {
      code: tokenCode,
      codeHash: keccak(tokenCode),
      name: callString(rpc, tokenAddress, "name()(string)"),
      version: callString(rpc, tokenAddress, "version()(string)"),
      symbol: callString(rpc, tokenAddress, "symbol()(string)"),
      decimals: Number(decimal(call(rpc, tokenAddress, "decimals()(uint8)"), "token decimals")),
      domain: bytes32(call(rpc, tokenAddress, "DOMAIN_SEPARATOR()(bytes32)"), "token onchain domain"),
    },
    splitter: {
      code: splitterCode,
      codeHash: keccak(splitterCode),
      token: address(call(rpc, splitterAddress, "usdc()(address)"), "onchain splitter token"),
      recipient: address(call(rpc, splitterAddress, "gavelRecipient()(address)"), "onchain splitter recipient"),
      signer: address(call(rpc, splitterAddress, "quoteSigner()(address)"), "onchain splitter signer"),
      fee: decimal(call(rpc, splitterAddress, "GAVEL_FEE_AMOUNT()(uint256)"), "onchain splitter fee"),
      domain: bytes32(call(rpc, splitterAddress, "DOMAIN_SEPARATOR()(bytes32)"), "splitter onchain domain"),
    },
  };
}

function validate(artifact, rpc) {
  validateStructure(artifact);
  if (decimal(cast(["chain-id"], rpc), "RPC chain") !== CHAIN_ID) fail("RPC is not Base Sepolia");
  const creationInputs = expectedCreationInputs(artifact);
  creationTransaction(rpc, artifact.token.deployment, creationInputs.token, "token");
  creationTransaction(rpc, artifact.splitter.deployment, creationInputs.splitter, "splitter");
  receipt(rpc, artifact.token.deployment, artifact.token.address, "token");
  receipt(rpc, artifact.splitter.deployment, artifact.splitter.address, "splitter");
  const onchain = readOnchain(rpc, artifact.token.address, artifact.splitter.address);
  same(onchain.token.code, artifact.token.code.runtimeBytecode, "token runtime bytecode");
  same(onchain.splitter.code, artifact.splitter.code.runtimeBytecode, "splitter runtime bytecode");
  same(keccak(artifact.token.code.runtimeBytecode), artifact.token.code.runtimeCodeHash, "token local runtime code hash");
  same(keccak(artifact.splitter.code.runtimeBytecode), artifact.splitter.code.runtimeCodeHash, "splitter local runtime code hash");
  same(onchain.token.codeHash, artifact.token.code.runtimeCodeHash, "token onchain runtime code hash");
  same(onchain.splitter.codeHash, artifact.splitter.code.runtimeCodeHash, "splitter onchain runtime code hash");
  if (onchain.token.name !== artifact.token.name || onchain.token.version !== artifact.token.version
      || onchain.token.symbol !== artifact.token.symbol || onchain.token.decimals !== artifact.token.decimals) {
    fail("onchain token metadata mismatch");
  }
  const expectedTokenDomain = domainSeparator("USD Coin", "2", artifact.token.address);
  same(artifact.token.domainSeparator, expectedTokenDomain, "token expected domain");
  same(onchain.token.domain, expectedTokenDomain, "token onchain domain");
  same(onchain.splitter.token, artifact.token.address, "onchain splitter token");
  same(onchain.splitter.recipient, artifact.splitter.gavelRecipient, "onchain splitter recipient");
  same(onchain.splitter.signer, artifact.splitter.quoteSigner, "onchain splitter signer");
  if (onchain.splitter.fee !== "250000") fail("onchain splitter fee mismatch");
  const expectedSplitterDomain = domainSeparator("GavelGateSplitter", "1", artifact.splitter.address);
  same(artifact.splitter.domainSeparator, expectedSplitterDomain, "splitter expected domain");
  same(onchain.splitter.domain, expectedSplitterDomain, "splitter onchain domain");
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length || args[index + 1].startsWith("--")) fail(`${name} is required`);
  return args[index + 1];
}

function within(root, path) {
  const value = relative(root, path);
  return value === "" || (!isAbsolute(value) && !value.startsWith(".."));
}

function outputPath(args) {
  const output = resolve(option(args, "--output"));
  if (!output.endsWith(".json")) fail("output must be a JSON file");
  if (process.env.SYNTHETIC_DEPLOYMENT_TEST !== "yes" && !within(OUTPUT_ROOT, output)) {
    fail("output must be a JSON file under deployments/base-sepolia");
  }
  return output;
}

function writeArtifact(output, artifact) {
  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  if (process.env.SYNTHETIC_DEPLOYMENT_TEST !== "yes") {
    const canonicalRoot = realpathSync(OUTPUT_ROOT);
    const canonicalParent = realpathSync(parent);
    if (!within(canonicalRoot, canonicalParent)) fail("output parent escapes deployments/base-sepolia");
  }
  try {
    writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    fail("deployment artifact output must not already exist");
  }
}

function transaction(runFile, contractName) {
  const runJson = readJson(runFile, `${contractName} broadcast record`);
  const matches = Array.isArray(runJson.transactions)
    ? runJson.transactions.filter((entry) => entry?.contractName === contractName)
    : [];
  if (matches.length !== 1) fail(`${contractName} broadcast record must contain exactly one deployment`);
  const entry = matches[0];
  return { hash: bytes32(entry.hash, `${contractName} transaction hash`), address: address(entry.contractAddress, `${contractName} contract address`) };
}

function capture(args, rpc) {
  const tokenTx = transaction(option(args, "--token-run"), "BaseSepoliaTestUSDC3009");
  const splitterTx = transaction(option(args, "--splitter-run"), "GavelGateSplitter");
  const output = outputPath(args);
  if (decimal(cast(["chain-id"], rpc), "RPC chain") !== CHAIN_ID) fail("RPC is not Base Sepolia");
  const receiptFor = (tx, label) => {
    let value;
    try { value = JSON.parse(cast(["receipt", tx.hash, "--json"], rpc)); } catch { fail(`${label} receipt unavailable`); }
    if (decimal(value.status, `${label} receipt status`) !== "1") fail(`${label} deployment failed`);
    same(value.transactionHash, tx.hash, `${label} receipt transaction`);
    same(value.contractAddress, tx.address, `${label} broadcast address`);
    return { hash: tx.hash, block: decimal(value.blockNumber, `${label} receipt block`) };
  };
  const tokenDeployment = receiptFor(tokenTx, "token");
  const splitterDeployment = receiptFor(splitterTx, "splitter");
  const onchain = readOnchain(rpc, tokenTx.address, splitterTx.address);
  const sourceCommit = run("git", ["rev-parse", "HEAD"]);
  const artifact = {
    schemaVersion: 1,
    environment: "test",
    chainId: CHAIN_ID,
    sourceCommit,
    token: {
      label: "base-sepolia-test-usdc3009-unrestricted-mint",
      productionSafe: false,
      address: tokenTx.address,
      deployment: tokenDeployment,
      code: { runtimeBytecode: onchain.token.code, runtimeCodeHash: onchain.token.codeHash },
      name: onchain.token.name,
      version: onchain.token.version,
      symbol: onchain.token.symbol,
      decimals: onchain.token.decimals,
      domainSeparator: onchain.token.domain,
    },
    splitter: {
      address: splitterTx.address,
      deployment: splitterDeployment,
      code: { runtimeBytecode: onchain.splitter.code, runtimeCodeHash: onchain.splitter.codeHash },
      token: onchain.splitter.token,
      gavelRecipient: onchain.splitter.recipient,
      quoteSigner: onchain.splitter.signer,
      gavelFeeAmount: onchain.splitter.fee,
      domainSeparator: onchain.splitter.domain,
    },
  };
  validate(artifact, rpc);
  writeArtifact(output, artifact);
}

try {
  const [mode, ...args] = process.argv.slice(2);
  const rpc = rpcUrl();
  if (mode === "capture") capture(args, rpc);
  else if (mode === "validate" && args.length === 1) validate(readJson(args[0], "deployment artifact"), rpc);
  else fail("usage: capture ... | validate <artifact.json>");
  process.stdout.write("deployment artifact valid\n");
} catch {
  process.stderr.write("deployment artifact validation failed\n");
  process.exitCode = 1;
}
