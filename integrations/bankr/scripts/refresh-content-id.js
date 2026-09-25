"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { packageContentId } = require("./content-id");

const skillDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(skillDir, "..", "..");
const manifestPath = path.join(skillDir, "references", "skill-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.buildId = packageContentId({ repoRoot, skillDir });
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${manifest.buildId}\n`);
