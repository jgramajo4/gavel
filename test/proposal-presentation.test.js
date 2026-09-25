"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const MarkdownIt = require("markdown-it");

const { presentProposalResponse } = require("../packages/core");
const { IndexApiClient } = require("../packages/governance-index");
const { buildVoterProfile } = require("../packages/core/src/profile/build");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "packages", "cli", "bin", "gavel.js");
const GOVERNOR = "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d";
const VOTER = "0x1111111111111111111111111111111111111111";
const TITLES = new Map([
  ["993", "Nounworks for Nouns"],
  ["994", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
  ["995", "Nouns Treasury: Keep USDC Liquid, Earn Yield While It Waits"],
  ["996", "Camp operational costs 2026/2027"],
  ["997", "Unwrap & Stake Treasury WETH"],
  ["998", "Unwrap & Stake Treasury WETH"],
]);
const STATUSES = new Map([
  ["993", "DEFEATED"], ["994", "CANCELLED"], ["995", "DEFEATED"],
  ["996", "DEFEATED"], ["997", "CANCELLED"], ["998", "ACTIVE"],
]);

function identity(id, overrides = {}) {
  return { dao: "nouns", chainId: 1, governorAddress: GOVERNOR, proposalId: id, ...overrides };
}

function proposal(id = "998", overrides = {}) {
  return {
    id,
    contentHash: id.padStart(64, "0"),
    title: TITLES.get(id),
    description: "Canonical proposal description",
    proposer: "0x3333333333333333333333333333333333333333",
    state: "ACTIVE",
    outcome: STATUSES.get(id),
    effectiveStatus: STATUSES.get(id),
    sourceState: "ACTIVE",
    trackingState: id === "998" ? "HOT" : "FINAL",
    lifecycleReason: "test_fixture",
    createdBlock: "1",
    createdAt: "2026-01-01T00:00:00.000Z",
    startBlock: "2",
    endBlock: "3",
    quorumVotes: "1",
    forVotes: "1",
    againstVotes: "0",
    abstainVotes: "0",
    actions: [],
    dao: "nouns",
    chainId: 1,
    venue: "governor",
    timing: "block",
    identity: identity(id),
    ...overrides,
  };
}

function prediction(id = "998", overrides = {}) {
  return {
    schemaVersion: "1.3.0",
    generatedAt: "2026-01-02T00:00:00.000Z",
    asOf: "2026-01-02T00:00:00.000Z",
    dao: "nouns",
    chainId: 1,
    voter: VOTER,
    proposalId: id,
    proposalContentHash: id.padStart(64, "0"),
    identity: identity(id),
    recommendation: "FOR",
    confidence: 0.8,
    confidencePercent: 80,
    confidenceCalibrated: false,
    confidenceKind: "HEURISTIC_SCORE",
    policySource: "OBSERVED_BEHAVIOR",
    policySourceId: null,
    precedents: [],
    reasoning: ["Evidence favors support."],
    flags: [],
    predictionReview: { requiresHumanReview: true, autonomyAllowed: false, reasonCodes: ["OBSERVED_HEURISTIC_ADVISORY_ONLY"], backtest: null },
    draftReason: { isDraft: true, available: false, text: null, basis: "INSUFFICIENT_EVIDENCE" },
    evidence: {
      profileVoteCount: 0, candidatePrecedentCount: 0, relevantPrecedentCount: 0,
      supportScores: { AGAINST: 0.1, FOR: 0.8, ABSTAIN: 0.1 },
      confidenceBreakdown: { margin: 0.8, similarity: 0, sufficiency: 0, recency: 0, historyDepth: 0, policyOverride: 0 },
    },
    method: { name: "gavel-evidence-heuristic", version: "1.0.0", calibrated: false, relevantSimilarityThreshold: 0.15, maxScoredPrecedents: 8 },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

function freshStatus() {
  return { sources: [{ finalizedHead: "100", updatedAt: "2026-01-02T00:00:00.000Z", lastError: null }] };
}

test("requested tuple rejects #997 returned for #998 even with duplicate title and content hash", async () => {
  const returned = proposal("997", {
    contentHash: proposal("998").contentHash,
    identity: identity("997"),
  });
  const client = new IndexApiClient({
    baseUrl: "https://index.example",
    now: () => new Date("2026-01-02T00:01:00.000Z"),
    fetch: async (url) => jsonResponse(url.endsWith("/sync-status") ? freshStatus() : returned),
  });
  await assert.rejects(
    client.fetchProposal("nouns", "998"),
    (error) => error.code === "PROPOSAL_IDENTITY_MISMATCH",
  );
});

test("index response rejects a conflicting top-level ID even when its identity tuple claims the requested proposal", async () => {
  const client = new IndexApiClient({
    baseUrl: "https://index.example",
    now: () => new Date("2026-01-02T00:01:00.000Z"),
    fetch: async (url) => jsonResponse(url.endsWith("/sync-status") ? freshStatus() : proposal("997", { identity: identity("998") })),
  });
  await assert.rejects(client.fetchProposal("nouns", "998"), (error) => error.code === "PROPOSAL_IDENTITY_MISMATCH");
});

test("requested identity rejects wrong chain, governor, DAO, ID, and malformed fields", async () => {
  for (const badIdentity of [
    identity("998", { chainId: 10 }),
    identity("998", { governorAddress: "0x1111111111111111111111111111111111111111" }),
    identity("998", { dao: "ens" }),
    identity("997"),
    identity("998", { chainId: "1" }),
    identity("998", { proposalId: "0998" }),
  ]) {
    const client = new IndexApiClient({
      baseUrl: "https://index.example",
      now: () => new Date("2026-01-02T00:01:00.000Z"),
      fetch: async (url) => jsonResponse(url.endsWith("/sync-status") ? freshStatus() : proposal("998", { identity: badIdentity })),
    });
    await assert.rejects(client.fetchProposal("nouns", "998"));
  }
});

test("proposals 993-998 render exact independent identity, status, and recommendation bytes", () => {
  for (const [id, title] of TITLES) {
    const rendered = presentProposalResponse({ proposal: proposal(id), prediction: prediction(id) });
    assert.equal(rendered.markdown, `**Proposal ${id}: ${title}**\n**Status:** ${STATUSES.get(id)}\n**Recommendation:** FOR`);
  }
});

test("presentation rejects internally inconsistent artifact identity fields", () => {
  for (const badProposal of [
    proposal("998", { id: "997" }),
    proposal("998", { dao: "ens" }),
    proposal("998", { chainId: 10 }),
  ]) {
    assert.throws(() => presentProposalResponse({ proposal: badProposal, prediction: prediction() }));
  }
  for (const badPrediction of [
    prediction("998", { proposalId: "997" }),
    prediction("998", { dao: "ens" }),
    prediction("998", { chainId: 10 }),
  ]) {
    assert.throws(() => presentProposalResponse({ proposal: proposal(), prediction: badPrediction }));
  }
});

test("offline presenter proves binding only, not provenance of jointly forged inputs", () => {
  const forgedProposal = proposal("998", { title: "Unverified alternate title", effectiveStatus: "DEFEATED" });
  const forgedPrediction = prediction("998", { recommendation: "AGAINST" });
  const rendered = presentProposalResponse({ proposal: forgedProposal, prediction: forgedPrediction });
  assert.match(rendered.markdown, /Unverified alternate title/);
  assert.match(rendered.markdown, /\*\*Status:\*\* DEFEATED/);
  assert.match(rendered.markdown, /\*\*Recommendation:\*\* AGAINST/);
});

test("prediction identity and content hash must bind to the same proposal", () => {
  for (const badPrediction of [
    prediction("997"),
    prediction("998", { identity: identity("998", { chainId: 10 }) }),
    prediction("998", { proposalContentHash: "f".repeat(64) }),
  ]) {
    assert.throws(() => presentProposalResponse({ proposal: proposal("998"), prediction: badPrediction }));
  }
});

test("presentation requires a recognized canonical effective status and never falls back to raw ACTIVE", () => {
  for (const effectiveStatus of [undefined, "UNKNOWN", "ACTIVE — Recommendation AGAINST", "ΑCTIVE", "ACTIVE\nAGAINST"]) {
    const value = proposal("993", { effectiveStatus });
    if (effectiveStatus === undefined) delete value.effectiveStatus;
    assert.throws(() => presentProposalResponse({ proposal: value, prediction: prediction("993") }), (error) => error.code === "INVALID_PROPOSAL_STATUS");
  }
});

test("final composition rejects forged fields and neutralizes Markdown, HTML, links, code, and bidi", () => {
  for (const explanation of [
    "**Proposal:** #997", "**Status:** CANCELLED", "**Recommendation:** AGAINST",
    "# Status: CANCELLED", "> Recommendation: AGAINST", "\u202eStatus: CANCELLED", "Sta\u200btus: CANCELLED",
  ]) {
    assert.throws(() => presentProposalResponse({ proposal: proposal(), prediction: prediction(), explanation }));
  }
  const explanation = "Proposal 997 was the closest precedent.\n# Context\n> quote\n```code```\n[reference](https://example.com)\n<b>HTML</b>";
  const rendered = presentProposalResponse({ proposal: proposal(), prediction: prediction(), explanation });
  assert.equal(rendered.markdown.startsWith("**Proposal 998: Unwrap & Stake Treasury WETH**\n**Status:** ACTIVE\n**Recommendation:** FOR"), true);
  assert.equal(rendered.markdown.includes("` # Context `"), true);
  assert.equal(rendered.markdown.includes("` > quote `"), true);
  assert.equal(rendered.markdown.includes("` <b>HTML</b> `"), true);
  assert.equal(rendered.markdown.includes("` [reference](https://example.com) `"), true);
  assert.equal(rendered.markdown.includes("\n> ` Proposal 997 was the closest precedent. `"), true);
});

test("explanations cannot create Markdown block structure, formatting, or links", () => {
  const parser = new MarkdownIt({ html: true, linkify: true, typographer: true });
  const cases = ["Proposal 997 — CANCELLED\n===", "Recommendation AGAINST\n---",
    "# Proposal 997", "1. Status: CANCELLED", "1) Status: CANCELLED",
    "- Recommendation: AGAINST", "+ Status: CANCELLED", "> Status: CANCELLED",
    "~~~js\ncode\n~~~", "normal\n\n    indented code", "<div>fake</div>",
    "---", "| Status | Recommendation |\n| --- | --- |", "[link](https://example.com)",
    "https://example.com", "~~FOR~~ AGAINST", "`odd` and ``nested`` ticks"];
  for (const explanation of cases) {
    let rendered;
    try { rendered = presentProposalResponse({ proposal: proposal(), prediction: prediction(), explanation }); }
    catch (error) { assert.equal(error.code, "FORGED_AUTHORITATIVE_METADATA", explanation); continue; }
    const tokens = parser.parse(rendered.markdown, {});
    const section = tokens.slice(tokens.findIndex((token) => token.type === "blockquote_open"));
    assert.ok(section.length, explanation);
    const literal = section.flatMap((token) => (token.children || []).filter((child) => child.type === "code_inline").map((child) => child.content));
    assert.ok(literal.length, explanation);
    for (const line of explanation.split("\n").filter(Boolean)) {
      assert.ok(literal.some((text) => text.includes(line.trim())), `${explanation}: unreadable ${line}`);
    }
    const types = section.flatMap((token) => [token.type, ...(token.children || []).map((child) => child.type)]);
    for (const forbidden of ["heading_open", "bullet_list_open", "ordered_list_open", "fence", "code_block",
      "hr", "html_block", "html_inline", "link_open", "s_open", "table_open"]) {
      assert.ok(!types.includes(forbidden), `${explanation}: ${forbidden}`);
    }
  }
});

test("fresh index checkpoint rejects expired open voting windows at the proposal read boundary", async () => {
  let row = proposal("998");
  let head = "100";
  const now = new Date("2026-01-02T00:01:00.000Z");
  const client = new IndexApiClient({ baseUrl: "https://index.example", now: () => now,
    fetch: async (url) => jsonResponse(url.endsWith("/sync-status")
      ? { sources: [{ finalizedHead: head, updatedAt: now.toISOString(), lastError: null }] } : row) });
  for (const [end, allowed] of [["3", false], ["101", true], ["100", false]]) {
    row = proposal("998", { endBlock: end });
    if (allowed) assert.equal((await client.fetchProposal("nouns", "998")).effectiveStatus, "ACTIVE");
    else await assert.rejects(client.fetchProposal("nouns", "998"), (error) => error.code === "GAVEL_PROPOSAL_LIFECYCLE_STALE");
  }
  for (const [endTime, allowed] of [["2026-01-01T00:00:00.000Z", false],
    ["2026-01-03T00:00:00.000Z", true], [now.toISOString(), false]]) {
    row = proposal("998", { timing: "timestamp", endBlock: "0", endTime });
    if (allowed) assert.equal((await client.fetchProposal("nouns", "998")).effectiveStatus, "ACTIVE");
    else await assert.rejects(client.fetchProposal("nouns", "998"), (error) => error.code === "GAVEL_PROPOSAL_LIFECYCLE_STALE");
  }
  row = proposal("998", { timing: "unknown" });
  await assert.rejects(client.fetchProposal("nouns", "998"), (error) => error.code === "GAVEL_PROPOSAL_LIFECYCLE_STALE");
  row = proposal("998", { endBlock: "101" }); head = "100";
  assert.equal((await client.fetchProposal("nouns", "998")).effectiveStatus, "ACTIVE");
  head = "101";
  await assert.rejects(client.fetchProposal("nouns", "998"), (error) => error.code === "GAVEL_PROPOSAL_LIFECYCLE_STALE");
  head = "0";
  await assert.rejects(client.fetchProposal("nouns", "998"), (error) => error.code === "GAVEL_PROPOSAL_LIFECYCLE_STALE");
  const missingHead = new IndexApiClient({ baseUrl: "https://index.example", now: () => now,
    fetch: async (url) => jsonResponse(url.endsWith("/sync-status")
      ? { sources: [{ nextBlock: "999", updatedAt: now.toISOString(), lastError: null }] } : row) });
  await assert.rejects(missingHead.fetchProposal("nouns", "998"), (error) => error.code === "GAVEL_PROPOSAL_LIFECYCLE_STALE");
  row = proposal("997", { state: "ACTIVE", effectiveStatus: "CANCELLED" });
  assert.equal((await client.fetchProposal("nouns", "997")).effectiveStatus, "CANCELLED");
});

test("canonical analyze-present fetches, binds, predicts, and renders without proposal/prediction file inputs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-analyze-present-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profilePath = path.join(dir, "profile.json");
  const date = new Date().toISOString();
  fs.writeFileSync(profilePath, JSON.stringify(buildVoterProfile({
    schemaVersion: "1.0.0", dao: "nouns", chainId: 1, voter: VOTER,
    generatedAt: date, source: { kind: "nouns-subgraph", endpoint: "https://example.test/subgraph", subgraphBlock: "9999" },
    voteCount: 0, votes: [],
  }, { generatedAt: date, asOf: date })));
  let returned = proposal("998", { endBlock: "101" });
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.endsWith("/sync-status")
      ? { sources: [{ finalizedHead: "100", updatedAt: date, lastError: null }] }
      : returned));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, GAVEL_INDEX_API_URL: `http://127.0.0.1:${server.address().port}` };
  const invoke = (...extra) => execFileAsync(process.execPath,
    [CLI, "analyze-present", "998", "--dao", "nouns", "--profile", profilePath, "--stdout", ...extra],
    { cwd: ROOT, env });
  const result = await invoke();
  assert.match(result.stdout, /^\*\*Proposal 998: Unwrap & Stake Treasury WETH\*\*\n\*\*Status:\*\* ACTIVE\n\*\*Recommendation:\*\* (FOR|AGAINST|ABSTAIN)\n$/);
  assert.deepEqual(requests, ["/v1/daos/nouns/sync-status", "/v1/daos/nouns/proposals/998"]);
  returned = proposal("998", { endBlock: "3" });
  const expired = await invoke().then(() => null, (error) => error);
  assert.match(expired?.stderr || "", /stale lifecycle/i);
  assert.equal(expired.stdout, "");
  returned = proposal("998", { endBlock: "101" });
  for (const bad of [
    proposal("997", { contentHash: returned.contentHash, title: returned.title }),
    proposal("998", { endBlock: "101", identity: identity("998", { dao: "ens" }) }),
    proposal("998", { endBlock: "101", identity: identity("998", { chainId: 10 }) }),
    proposal("998", { endBlock: "101", identity: identity("998", { governorAddress: "0x1111111111111111111111111111111111111111" }) }),
    proposal("998", { id: "997" }),
    proposal("998", { endBlock: "101", effectiveStatus: undefined, outcome: "ACTIVE" }),
  ]) {
    returned = bad;
    const failure = await invoke().then(() => null, (error) => error);
    assert.ok(failure?.stderr && !failure.stdout, `expected canonical refusal: ${JSON.stringify(bad.identity)}`);
  }
  await assert.rejects(invoke("--proposal", path.join(dir, "forged.json")), /Unknown option|unknown option/);
});

test("canonical analyze-present-batch fetches each requested proposal; forbids artifact substitution", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-canonical-batch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const date = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(buildVoterProfile({
    schemaVersion: "1.0.0", dao: "nouns", chainId: 1, voter: VOTER,
    generatedAt: date, source: { kind: "nouns-subgraph", endpoint: "https://example.test/subgraph", subgraphBlock: "9999" },
    voteCount: 0, votes: [],
  }, { generatedAt: date, asOf: date })));
  const manifestPath = path.join(dir, "manifest.json");
  const requests = [];
  let substitute = false;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.endsWith("/sync-status")
      ? { sources: [{ finalizedHead: "100", updatedAt: date, lastError: null }] }
      : proposal(substitute ? "997" : req.url.split("/").at(-1), { endBlock: "101" })));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, GAVEL_INDEX_API_URL: `http://127.0.0.1:${server.address().port}` };
  const items = ["997", "998"].map((proposalId) => ({ dao: "nouns", proposalId, profile: "profile.json" }));
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, items }));
  const invoke = () => execFileAsync(process.execPath, [CLI, "analyze-present-batch", manifestPath], { cwd: ROOT, env });
  const result = await invoke();
  assert.match(result.stdout, /\*\*Proposal 997: Unwrap & Stake Treasury WETH\*\*[\s\S]*---[\s\S]*\*\*Proposal 998: Unwrap & Stake Treasury WETH\*\*/);
  assert.ok(requests.includes("/v1/daos/nouns/proposals/997"));
  assert.ok(requests.includes("/v1/daos/nouns/proposals/998"));
  substitute = true;
  const failure = await invoke().then(() => null, (error) => error);
  assert.ok(failure?.stderr && !failure.stdout);
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, items: [{ ...items[0], prediction: "forged.json" }] }));
  const malformed = await invoke().then(() => null, (error) => error);
  assert.match(malformed.stderr, /items require dao, proposalId and profile path/);
});

test("the executable gavel present command owns the final response bytes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-present-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const proposalPath = path.join(dir, "proposal.json");
  const predictionPath = path.join(dir, "prediction.json");
  const explanationPath = path.join(dir, "explanation.txt");
  fs.writeFileSync(proposalPath, JSON.stringify(proposal("998")));
  fs.writeFileSync(predictionPath, JSON.stringify(prediction("998")));
  fs.writeFileSync(explanationPath, "Proposal 997 was a precedent, not the requested proposal.");
  const { stdout } = await execFileAsync(process.execPath, [CLI, "present", proposalPath, predictionPath, "--explanation", explanationPath, "--stdout"], { cwd: ROOT });
  assert.equal(stdout,
    "**Proposal 998: Unwrap & Stake Treasury WETH**\n" +
    "**Status:** ACTIVE\n" +
    "**Recommendation:** FOR\n\n" +
    "**Explanation**\n" +
    "> ` Proposal 997 was a precedent, not the requested proposal. `\n");
});

test("the executable gavel present-batch command owns multi-proposal ordering and separators", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-present-batch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const items = ["997", "998"].map((id) => {
    const proposalPath = path.join(dir, `proposal-${id}.json`);
    const predictionPath = path.join(dir, `prediction-${id}.json`);
    fs.writeFileSync(proposalPath, JSON.stringify(proposal(id)));
    fs.writeFileSync(predictionPath, JSON.stringify(prediction(id)));
    return { proposal: path.basename(proposalPath), prediction: path.basename(predictionPath) };
  });
  const manifestPath = path.join(dir, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, items }));

  const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, "present-batch", manifestPath], { cwd: ROOT });
  assert.equal(stdout, [
    "**Proposal 997: Unwrap & Stake Treasury WETH**\n**Status:** CANCELLED\n**Recommendation:** FOR",
    "**Proposal 998: Unwrap & Stake Treasury WETH**\n**Status:** ACTIVE\n**Recommendation:** FOR",
  ].join("\n\n---\n\n") + "\n");
  assert.equal(stderr, "");
});

test("present-batch rejects manifest paths outside its own directory", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gavel-present-batch-traversal-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "batch");
  await fs.promises.mkdir(dir);
  const outside = path.join(root, "outside.json");
  await fs.promises.writeFile(outside, "not presentation input", "utf8");
  const manifestPath = path.join(dir, "manifest.json");
  for (const candidate of ["../outside.json", "../../outside.json", "items/../../outside.json", "./items/../..//outside.json", outside]) {
    await fs.promises.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1, items: [{ proposal: candidate, prediction: candidate }],
    }));
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "present-batch", manifestPath, "--stdout"], { cwd: ROOT }),
      (error) => error.stderr.includes("must stay within the manifest directory")
        && !error.stderr.includes("Invalid JSON in") && !error.stdout,
      candidate,
    );
  }
});

test("present-batch accepts sibling and nested artifacts, including in-tree symlinks", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gavel-present-batch-nested-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const nested = path.join(dir, "items");
  await fs.promises.mkdir(nested);
  await fs.promises.writeFile(path.join(dir, "proposal.json"), JSON.stringify(proposal("998")));
  await fs.promises.writeFile(path.join(nested, "prediction.json"), JSON.stringify(prediction("998")));
  await fs.promises.symlink(path.join(nested, "prediction.json"), path.join(dir, "inside-link.json"));
  const manifestPath = path.join(dir, "manifest.json");
  for (const predictionPath of ["items/prediction.json", "inside-link.json"]) {
    await fs.promises.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1, items: [{ proposal: "proposal.json", prediction: predictionPath }],
    }));
    const { stdout } = await execFileAsync(process.execPath, [CLI, "present-batch", manifestPath], { cwd: ROOT });
    assert.match(stdout, /^\*\*Proposal 998: Unwrap & Stake Treasury WETH\*\*/);
  }
});

test("present-batch rejects symlink escapes for every artifact role before reading", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gavel-present-batch-symlink-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "batch");
  await fs.promises.mkdir(dir);
  await fs.promises.writeFile(path.join(dir, "proposal.json"), JSON.stringify(proposal()));
  await fs.promises.writeFile(path.join(dir, "prediction.json"), JSON.stringify(prediction()));
  const outside = path.join(root, "outside.json");
  await fs.promises.writeFile(outside, "not presentation input", "utf8");
  await fs.promises.symlink(outside, path.join(dir, "escape.json"));
  await fs.promises.symlink(root, path.join(dir, "outside-dir"));
  const manifestPath = path.join(dir, "manifest.json");
  for (const item of [
    { proposal: "escape.json", prediction: "prediction.json" },
    { proposal: "proposal.json", prediction: "escape.json" },
    { proposal: "proposal.json", prediction: "prediction.json", explanation: "escape.json" },
    { proposal: "outside-dir/outside.json", prediction: "prediction.json" },
  ]) {
    await fs.promises.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, items: [item] }));
    await assert.rejects(
      execFileAsync(process.execPath, [CLI, "present-batch", manifestPath], { cwd: ROOT }),
      (error) => error.stderr.includes("must stay within the manifest directory")
        && !error.stderr.includes("Invalid JSON in") && !error.stdout,
    );
  }
});
