"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { packageContentId } = require("./content-id");

const skillDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(skillDir, "..", "..");
const args = process.argv.slice(2);

function valueFor(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  if (!args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

const outputArg = valueFor("--output");
if (!outputArg) throw new Error("usage: build-artifact.js --output <directory> [--build-sha <40-hex-sha>]");
const output = path.resolve(process.cwd(), outputArg);
const buildSha = valueFor("--build-sha");
if (buildSha && !/^[0-9a-f]{40}$/.test(buildSha)) {
  throw new Error("--build-sha must be a lowercase 40-character Git SHA");
}

const sourceManifestPath = path.join(skillDir, "references", "skill-manifest.json");
const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
const expectedContentId = packageContentId({ repoRoot, skillDir });
if (sourceManifest.buildId !== expectedContentId) {
  throw new Error(`skill-manifest buildId is stale: expected ${expectedContentId}`);
}

fs.mkdirSync(output, { recursive: true });
if (fs.readdirSync(output).length !== 0) throw new Error(`output directory must be empty: ${output}`);

for (const name of ["README.md", "SKILL.md", "package.json", "references", "src", "scripts"]) {
  fs.cpSync(path.join(skillDir, name), path.join(output, name), { recursive: true });
}

const vendorGate = path.join(output, "vendor", "gate");
const repositoryGate = path.join(repoRoot, "packages", "gate");
const gateSource = fs.existsSync(repositoryGate) ? repositoryGate : path.join(skillDir, "vendor", "gate");
if (!fs.existsSync(gateSource)) throw new Error("cannot locate the @gavel/gate source to vendor");
fs.mkdirSync(vendorGate, { recursive: true });
for (const name of ["package.json", "src"]) {
  fs.cpSync(path.join(gateSource, name), path.join(vendorGate, name), { recursive: true });
}

const pkgPath = path.join(output, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const gatePackage = JSON.parse(fs.readFileSync(path.join(vendorGate, "package.json"), "utf8"));
for (const [name, range] of Object.entries(gatePackage.dependencies || {})) {
  if (pkg.dependencies[name] && pkg.dependencies[name] !== range) {
    throw new Error(`dependency range mismatch for ${name}: ${pkg.dependencies[name]} != ${range}`);
  }
  pkg.dependencies[name] = range;
}
pkg.dependencies["@gavel/gate"] = "file:vendor/gate";
const vendorIdentity = path.join(output, "vendor", "proposal-identity");
const repositoryIdentity = path.join(repoRoot, "packages", "proposal-identity");
const identitySource = fs.existsSync(repositoryIdentity)
  ? repositoryIdentity
  : path.join(skillDir, "vendor", "proposal-identity");
if (!fs.existsSync(identitySource)) throw new Error("cannot locate the @gavel/proposal-identity source to vendor");
fs.cpSync(identitySource, vendorIdentity, { recursive: true });
pkg.dependencies["@gavel/proposal-identity"] = "file:vendor/proposal-identity";
pkg.files = ["README.md", "SKILL.md", "references", "scripts", "src", "vendor/gate", "vendor/proposal-identity"];
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

if (buildSha) {
  const manifestPath = path.join(output, "references", "skill-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.build = { kind: "git", gitSha: buildSha };
  manifest.runtime.ref = buildSha;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
