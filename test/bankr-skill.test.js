"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const skillPath = path.join(root, "nouns-dao", "SKILL.md");
const skill = fs.readFileSync(skillPath, "utf8");

const requiredReferences = [
  "gavel-workflows.md",
  "policy-and-corrections.md",
  "daily-and-review.md",
  "legacy-nouns-tools.md",
];

test("declares Gavel as a discoverable personalized governance copilot", () => {
  assert.match(skill, /^name: gavel$/m);
  const description = skill.match(/^description: (.+)$/m)?.[1] ?? "";

  for (const term of ["private history", "proposals", "preferences", "hard rules", "backtests", "delegation"]) {
    assert.match(description, new RegExp(term, "i"));
  }
});

test("routes every Phase 7 voter intent without making scripts the interface", () => {
  for (const phrase of [
    "Onboard me",
    "sync my history",
    "show my profile",
    "I changed my mind",
    "Always…",
    "Analyze proposal 123",
    "show precedents",
    "Backtest this",
    "daily",
    "Prepare my vote",
    "delegate",
  ]) {
    assert.ok(skill.includes(phrase), `missing workflow trigger: ${phrase}`);
  }

  assert.match(skill, /Be a governance copilot[\s\S]{0,100}menu of scripts\./);
});

test("keeps privacy, proposal security, execution, and rewards boundaries explicit", () => {
  assert.match(skill, /profile is private by default/i);
  assert.match(skill, /untrusted data/i);
  assert.match(skill, /Never sign or broadcast from an ambiguous request/i);
  assert.match(skill, /at most one briefing per day/i);
  assert.match(skill, /reward settings,\s+balances, withdrawals, or builder economics as voter features/i);
  assert.doesNotMatch(skill, /withdraw_rewards|withdrawClientBalance/);
});

test("ships concise on-demand references in the Bankr skill directory", () => {
  for (const filename of requiredReferences) {
    const referencePath = path.join(root, "nouns-dao", "references", filename);
    const stat = fs.statSync(referencePath);
    assert.ok(stat.isFile(), `${filename} must be a file`);
    assert.ok(stat.size < 100_000, `${filename} must stay below Bankr's reference limit`);
    assert.ok(skill.includes(`references/${filename}`), `${filename} must be routed from SKILL.md`);
  }
});

test("defines a persistent self-installing Bankr runtime boundary", () => {
  const runtime = fs.readFileSync(path.join(root, "nouns-dao", "references", "bankr-runtime.md"), "utf8");
  assert.match(skill, /references\/bankr-runtime\.md/);
  assert.match(skill, /\/cli\/gavel\/data\/private/);
  assert.match(runtime, /git clone --branch phase9-launch-hardening --single-branch https:\/\/github\.com\/jgramajo4\/gavel\.git \/cli\/gavel/);
  assert.match(runtime, /immutable release\s+tag/);
  assert.match(runtime, /npm ci/);
  assert.match(runtime, /npm test/);
  assert.match(runtime, /end the Bankr conversation and start a new one/i);
  assert.match(runtime, /No private key is required/);
});

test("orders proposal analysis defensively and keeps preparation separate from broadcast", () => {
  const workflows = fs.readFileSync(
    path.join(root, "nouns-dao", "references", "gavel-workflows.md"),
    "utf8",
  );
  const review = fs.readFileSync(
    path.join(root, "nouns-dao", "references", "daily-and-review.md"),
    "utf8",
  );

  const fetch = workflows.indexOf("node bin/gavel.js proposal 123");
  const inspect = workflows.indexOf("node bin/gavel.js inspect");
  const predict = workflows.indexOf("node bin/gavel.js predict");
  assert.ok(fetch >= 0 && fetch < inspect && inspect < predict);
  assert.match(review, /unsigned calldata, not a broadcast/);
  assert.match(review, /prepare-vote/);
  assert.match(review, /never signs or broadcasts/);
  assert.match(review, /Require explicit confirmation/);
});
