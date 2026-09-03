#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPOSITORY_URL = "https://github.com/jgramajo4/gavel.git";
const RUNTIME_REF = "7cc492119e3a3af20efaa2da823acb6a7f044106";
const MINIMUM_NODE_MAJOR = 20;

function commandName(name) {
  return process.platform === "win32" && name === "npm" ? "npm.cmd" : name;
}

function run(command, args, options = {}) {
  const result = spawnSync(commandName(command), args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env || process.env,
    stdio: options.inherit ? "inherit" : "pipe",
    timeout: options.timeout || 10 * 60 * 1000,
    shell: process.platform === "win32" && command === "npm",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return (result.stdout || "").trim();
}

function resolveConfig(env = process.env) {
  const hermesHome = path.resolve(
    env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes"),
  );
  const runtimeRoot = path.resolve(
    env.GAVEL_RUNTIME_DIR?.trim() || path.join(hermesHome, "runtimes", "gavel"),
  );
  const runtimeDir = path.join(runtimeRoot, RUNTIME_REF.slice(0, 12));
  const dataDir = path.resolve(
    env.GAVEL_DATA_DIR?.trim() || path.join(hermesHome, "data", "gavel"),
  );

  const runtimeToData = path.relative(runtimeRoot, dataDir);
  const dataToRuntime = path.relative(dataDir, runtimeRoot);
  if (
    runtimeRoot === dataDir ||
    (runtimeToData && !runtimeToData.startsWith("..") && !path.isAbsolute(runtimeToData)) ||
    (dataToRuntime && !dataToRuntime.startsWith("..") && !path.isAbsolute(dataToRuntime))
  ) {
    throw new Error("GAVEL_DATA_DIR and GAVEL_RUNTIME_DIR must not overlap");
  }

  return { hermesHome, runtimeRoot, runtimeDir, dataDir };
}

function runtimeSource() {
  return { source: REPOSITORY_URL, ref: RUNTIME_REF };
}

function assertPrerequisites() {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    throw new Error(`Gavel requires Node.js ${MINIMUM_NODE_MAJOR} or newer`);
  }
  run("git", ["--version"], { timeout: 15_000 });
  run("npm", ["--version"], { timeout: 15_000 });
}

function normalizedOrigin(value) {
  if (/^https:\/\/github\.com\/jgramajo4\/gavel(?:\.git)?\/?$/i.test(value)) {
    return REPOSITORY_URL;
  }
  return path.resolve(value);
}

function validateRuntime(runtimeDir, expectedSource, expectedRef) {
  if (!fs.statSync(path.join(runtimeDir, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Refusing unmanaged runtime directory: ${runtimeDir}`);
  }
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: runtimeDir });
  if (normalizedOrigin(origin) !== normalizedOrigin(expectedSource)) {
    throw new Error("Refusing Gavel runtime with an unexpected Git origin");
  }
  const head = run("git", ["rev-parse", "HEAD"], { cwd: runtimeDir }).toLowerCase();
  if (head !== expectedRef.toLowerCase()) {
    throw new Error("Refusing Gavel runtime at an unexpected revision");
  }
  const modified = run("git", ["diff", "--name-only", "--ignore-submodules"], {
    cwd: runtimeDir,
  });
  const staged = run("git", ["diff", "--cached", "--name-only", "--ignore-submodules"], {
    cwd: runtimeDir,
  });
  if (modified || staged) {
    throw new Error(`Refusing a modified Gavel runtime: ${modified || staged}`);
  }
  const cli = path.join(runtimeDir, "packages", "cli", "bin", "gavel.js");
  if (!fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Installed Gavel runtime is missing its canonical CLI");
  }
  return cli;
}

function dependenciesReady(runtimeDir) {
  const probe = spawnSync(
    process.execPath,
    ["-e", "require.resolve('ethers'); require.resolve('zod')"],
    { cwd: runtimeDir, encoding: "utf8", timeout: 15_000 },
  );
  return probe.status === 0;
}

function npmEnvironment(runtimeRoot) {
  return {
    ...process.env,
    npm_config_audit: "false",
    npm_config_cache: path.join(runtimeRoot, ".npm-cache"),
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function installRuntime(config, sourceConfig, options = {}) {
  fs.mkdirSync(config.runtimeRoot, { recursive: true, mode: 0o700 });
  const temporaryDir = fs.mkdtempSync(path.join(config.runtimeRoot, ".install-"));
  try {
    process.stderr.write(`[gavel] Installing pinned runtime ${sourceConfig.ref.slice(0, 12)}...\n`);
    run("git", ["init", "--quiet"], { cwd: temporaryDir, timeout: 60_000 });
    run("git", ["remote", "add", "origin", sourceConfig.source], { cwd: temporaryDir });
    run("git", ["fetch", "--depth", "1", "origin", sourceConfig.ref], {
      cwd: temporaryDir,
      timeout: 5 * 60 * 1000,
    });
    run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], { cwd: temporaryDir });

    if (options.skipNpm) {
      fs.mkdirSync(path.join(temporaryDir, "node_modules"), { recursive: true });
    } else {
      run("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
        cwd: temporaryDir,
        env: npmEnvironment(config.runtimeRoot),
        timeout: 10 * 60 * 1000,
      });
    }

    validateRuntime(temporaryDir, sourceConfig.source, sourceConfig.ref);
    fs.renameSync(temporaryDir, config.runtimeDir);
    return true;
  } catch (error) {
    throw new Error(`${error.message}; incomplete installation retained at ${temporaryDir}`);
  }
}

function ensureRuntime(env = process.env, options = {}) {
  assertPrerequisites();
  const config = resolveConfig(env);
  const sourceConfig = options.sourceConfig || runtimeSource();
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(config.dataDir, 0o700);
  } catch {
    // Windows and some mounted filesystems do not implement POSIX permissions.
  }

  let installed = false;
  if (!fs.existsSync(config.runtimeDir)) {
    installed = installRuntime(config, sourceConfig, options);
  }
  const cli = validateRuntime(config.runtimeDir, sourceConfig.source, sourceConfig.ref);
  if (!options.skipNpm && !dependenciesReady(config.runtimeDir)) {
    process.stderr.write("[gavel] Repairing locked runtime dependencies...\n");
    run("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
      cwd: config.runtimeDir,
      env: npmEnvironment(config.runtimeRoot),
      timeout: 10 * 60 * 1000,
    });
    if (!dependenciesReady(config.runtimeDir)) {
      throw new Error("Gavel runtime dependencies failed validation");
    }
  }
  return { ...config, cli, installed, runtimeRef: sourceConfig.ref };
}

function main() {
  try {
    const runtime = ensureRuntime();
    if (process.argv.length === 3 && process.argv[2] === "--bootstrap-only") {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        runtime: "hermes",
        installed: runtime.installed,
        runtimeRef: runtime.runtimeRef,
        dataDirConfigured: true,
      })}\n`);
      return;
    }

    const result = spawnSync(process.execPath, [runtime.cli, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, GAVEL_DATA_DIR: runtime.dataDir },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
  } catch (error) {
    process.stderr.write(`[gavel] Bootstrap failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MINIMUM_NODE_MAJOR,
  REPOSITORY_URL,
  RUNTIME_REF,
  dependenciesReady,
  ensureRuntime,
  normalizedOrigin,
  resolveConfig,
  validateRuntime,
};
