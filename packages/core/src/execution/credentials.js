"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

function validLabel(label) {
  if (typeof label !== "string" || !/^[A-Za-z0-9._-]+$/.test(label) || label === "." || label === "..") {
    throw new Error("Invalid local credential label");
  }
  return label;
}

function credentialPath(dataDir, label) {
  return path.join(dataDir, "credentials", `${validLabel(label)}.secret`);
}

async function assertPrivateDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Local credential directory is not owner-only");
  }
}

async function createLocalCredential({ dataDir, label, secret }) {
  const target = credentialPath(dataDir, label);
  if (typeof secret !== "string" || !secret) throw new Error("Invalid local credential");
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(dataDir);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(path.dirname(target));
    const temporary = path.join(path.dirname(target), `.${randomBytes(16).toString("hex")}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        await handle.writeFile(secret, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.link(temporary, target); // exclusive publication, never exposes a partial credential
      return target;
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  } catch {
    throw new Error("Could not create protected local credential");
  }
}

async function resolveCredential({ dataDir, credentialRef, label, passphraseEnv, env = process.env }) {
  if (passphraseEnv !== undefined && (typeof passphraseEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passphraseEnv))) {
    throw new Error("Invalid credential environment reference");
  }
  const expected = `local:${validLabel(label)}`;
  if (credentialRef !== undefined && credentialRef !== expected) throw new Error("Invalid local credential reference");
  const override = passphraseEnv ? env[passphraseEnv] : undefined;
  if (override !== undefined) {
    if (typeof override !== "string" || !override) throw new Error("Credential environment override is empty");
    return override;
  }
  if (!credentialRef) throw new Error("Credential is unavailable");
  const target = credentialPath(dataDir, label);
  try {
    await assertPrivateDirectory(dataDir);
    await assertPrivateDirectory(path.dirname(target));
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new Error("Insecure credential");
    }
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0 || opened.ino !== stat.ino || opened.dev !== stat.dev) {
        throw new Error("Insecure credential");
      }
      const secret = await handle.readFile("utf8");
      if (!secret.trim()) throw new Error("Empty credential");
      return secret.trim();
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("Protected local credential is missing or insecure");
  }
}

module.exports = { createLocalCredential, resolveCredential };
