"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SKILL_ENTRIES = Object.freeze(["README.md", "SKILL.md", "package.json", "references", "scripts", "src"]);
const GATE_ENTRIES = Object.freeze(["package.json", "src"]);

function filesUnder(root, entries) {
  const files = [];
  function visit(absolute, logical) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`content-id input must not be a symlink: ${logical}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), `${logical}/${name}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`content-id input must be a file: ${logical}`);
    files.push({ absolute, logical });
  }
  for (const entry of entries) visit(path.join(root, entry), entry);
  return files;
}

function normalizedBytes(file) {
  if (file.logical !== "references/skill-manifest.json") return fs.readFileSync(file.absolute);
  const manifest = JSON.parse(fs.readFileSync(file.absolute, "utf8"));
  manifest.buildId = "sha256:<content-derived>";
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function packageContentId({ repoRoot, skillDir }) {
  const gateDir = path.join(repoRoot, "packages", "gate");
  const files = [
    ...filesUnder(skillDir, SKILL_ENTRIES).map((file) => ({ ...file, logical: `skill/${file.logical}` })),
    ...filesUnder(gateDir, GATE_ENTRIES).map((file) => ({ ...file, logical: `vendor/gate/${file.logical}` })),
  ].sort((left, right) => left.logical.localeCompare(right.logical));
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    const bytes = normalizedBytes({ ...file, logical: file.logical.replace(/^skill\//, "") });
    digest.update(`${file.logical}\0${bytes.length}\0`);
    digest.update(bytes);
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

module.exports = { packageContentId };
