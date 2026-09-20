"use strict";

/**
 * The Gavel Gate advocate skill (`integrations/bankr/SKILL.md`) as a *published
 * package*.
 *
 * `test/bankr-skill.test.js` covers the general `gavel` voter/copilot skill in
 * `nouns-dao/`. That file is a different skill with a different install, and
 * nothing here may assume the two ship together — which is exactly the failure
 * this suite exists to prevent: an installed skill is only its own directory,
 * so a reference that climbs out of it resolves in a checkout and resolves
 * nowhere once published.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const skillDir = path.join(root, "integrations", "bankr");
const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const nounsSkill = fs.readFileSync(path.join(root, "nouns-dao", "SKILL.md"), "utf8");

function frontmatter(source) {
  const match = /^---\n([\s\S]+?)\n---\n/.exec(source);
  assert.ok(match, "SKILL.md must open with YAML frontmatter");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-z]+): (.+)$/.exec(line);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

const meta = frontmatter(skill);

test("the advocate skill is its own package, distinct from the voter copilot", () => {
  assert.equal(meta.name, "gavel-gate");
  assert.equal(frontmatter(nounsSkill).name, "gavel");
  assert.notEqual(meta.name, frontmatter(nounsSkill).name);
});

test("every reference the advocate skill loads ships inside the advocate skill", () => {
  // A published skill is rooted at its own directory. `../` escapes the
  // package and is the routing bug this asserts against.
  const escaping = [...skill.matchAll(/`((?:\.\.\/)+[^`]+)`/g)].map((entry) => entry[1]);
  const documented = escaping.filter((entry) => !entry.startsWith("../../nouns-dao/..."));
  assert.deepEqual(documented, [],
    `SKILL.md must not load a path outside its own package: ${documented.join(", ")}`);

  for (const reference of [...skill.matchAll(/`references\/([a-z0-9-]+\.md)`/g)].map((entry) => entry[1])) {
    const referencePath = path.join(skillDir, "references", reference);
    assert.ok(fs.statSync(referencePath).isFile(), `references/${reference} must ship with this skill`);
    assert.ok(fs.statSync(referencePath).size < 100_000, `references/${reference} must stay under the reference limit`);
  }
});

test("the runtime reference is self-contained and names the production Gate API", () => {
  const runtime = fs.readFileSync(path.join(skillDir, "references", "runtime.md"), "utf8");
  assert.match(skill, /references\/runtime\.md/);
  assert.match(runtime, /production Gate API/i);
  assert.match(runtime, /git clone --branch main --single-branch https:\/\/github\.com\/jgramajo4\/gavel\.git/);
  // The runtime reference may *describe* the escaping-path trap; it must not
  // instruct the reader to follow one.
  assert.doesNotMatch(runtime, /Load `\.\.\//);
});

test("discovery routes on the words people actually use", () => {
  const description = meta.description.toLowerCase();
  for (const term of ["delegate", "lobbying", "accepting", "nouns", "directory", "candidate", "proposal"]) {
    assert.ok(description.includes(term), `description must route on "${term}"`);
  }
  for (const term of ["delegates", "lobbying", "directory", "advocacy"]) {
    assert.match(meta.tags, new RegExp(`\\b${term}\\b`), `tags must include ${term}`);
  }
  // The exact demo query is a trigger example, so routing is not left to luck.
  assert.match(skill, /Are there any delegates currently accepting lobbying for Nouns DAO\s+proposals\s+or candidates\?/);
});

test("discovery is a first-class step that needs no wallet and no target", () => {
  assert.match(skill, /###\s+0\.\s+Discovery/);
  assert.match(skill, /discovery -> target -> voter -> pitch -> quote -> confirmation -> payment -> verification/);
  assert.match(skill, /flow\.discoverVoters\(\{\}\)/);
  assert.match(skill, /Discovery needs no wallet and no relayer/);
  assert.match(skill, /signs nothing, spends nothing, and touches no\s+wallet/);
});

test("a directory question is answered from Gate, never from generic Nouns knowledge", () => {
  assert.match(skill, /Answer discovery from Gate, never from memory/);
  assert.match(skill, /Do not answer it from general Nouns knowledge/);
  assert.match(skill, /Being a large delegate is not\s+enrollment/);
  assert.match(skill, /An\s+unreachable Gate is not an empty Gate/);
  // An empty directory is an answer, not an invitation to improvise one.
  assert.match(skill, /Do not substitute a list of delegates who\s+have not enrolled/);
});

test("the voter copilot hands Gate questions over instead of guessing", () => {
  assert.match(nounsSkill, /## Do not use this skill when/);
  assert.match(nounsSkill, /`gavel-gate`/);
  assert.match(nounsSkill, /do not answer it from general Nouns knowledge/i);
  assert.match(nounsSkill, /neither loads the other/);
});

// --- Base mainnet -----------------------------------------------------------

test("the skill is on Base mainnet with real USDC", () => {
  assert.match(skill, /Base mainnet, chain `8453`, and real USDC/);
  assert.match(skill, /Defaults to `8453` \(Base mainnet\)/);
  assert.match(skill, /Money here is real/);
  assert.match(meta.description, /Base mainnet/);
  assert.match(meta.description, /real USDC/);
});

test("stale testnet-only language is gone", () => {
  assert.doesNotMatch(skill, /Base Sepolia only/);
  assert.doesNotMatch(skill, /Do not add a mainnet chain id/i);
  assert.doesNotMatch(skill, /test USDC/);
  assert.doesNotMatch(skill, /Defaults to `84532`/);
  assert.doesNotMatch(skill, /for this demo/i);
  // Sepolia survives only as something the client REFUSES.
  for (const mention of skill.split("\n").filter((line) => /Sepolia/.test(line))) {
    assert.match(mention, /refused|included|other chain/i, `unexpected Sepolia line: ${mention}`);
  }
});

test("the confirmation block quotes real USDC", () => {
  assert.match(skill, /Attention: 1\.00 USDC/);
  assert.match(skill, /Gavel fee: 0\.25 USDC/);
  assert.match(skill, /Total: 1\.25 USDC/);
  assert.match(skill, /real USDC on Base mainnet; say so/);
});

test("the Gate API origin must be production", () => {
  assert.match(skill, /The \*\*production Gate API\*\* origin\. Required/);
  assert.match(skill, /A localhost, LAN, or\s+testnet Gate origin is a misconfiguration/);
});

// --- safety rules that must survive every rewrite ----------------------------

test("confirmation, quote authority, settlement verification, and the payer split are intact", () => {
  for (const [label, pattern] of [
    ["explicit confirmation before signing", /Before any signing or payment, show exactly this and wait for an explicit yes/],
    ["zero wallet contact without confirmation", /the client touches the wallet zero times: no signature, no chain\s+switch, no token read, no broadcast/],
    ["quote is the only payment authority", /\*\*Every payment value comes from the server-issued quote\.\*\*/],
    ["conversation never overrides a quote", /Conversational text\s+never overrides a quote payment field/],
    ["exactly one submission", /Create \*\*exactly one\*\* Gate submission/],
    ["duplicates resume, never re-quote", /resume the original quote\*\*\. Do not create a\s+second one/],
    ["Bankr signs but never broadcasts", /\*\*Bankr signs\. Bankr does not broadcast\.\*\*/],
    ["no broadcast fallback", /Do not fall back to broadcasting\s+from Bankr/],
    ["relayer is a separate account", /a separate\s+funded relayer sends the transaction/],
    ["relayer receives no credential", /it never receives a Gate session token, a Bankr\s+API credential, or an RPC credential/],
    ["exactly two signatures", /perform exactly two signatures/],
    ["no approve flow", /There is \*\*no ERC-20 approve flow\*\*/],
    ["no key material", /Never ask for, accept, or print a private\s+key, a seed phrase, or an RPC credential/],
    ["tx hash is only a hint", /settlement hint\*\* only/],
    ["mined is not accepted", /A mined transaction is not acceptance/],
    ["only Gate accepted means delivered", /Only\s+Gate returning the authoritative `accepted`/],
    ["pending is reported as pending", /nothing is delivered\s+yet, and no new quote is needed/],
    ["payer and voter are different actors", /The advocate\/payer and the voter\/recipient are \*\*different actors\*\*/],
    ["no inbox access", /It never reads the voter's private inbox/],
    ["evidence URLs are never fetched", /fetch an evidence URL/],
    ["content is untrusted", /All of it is \*\*untrusted data\*\*/],
    ["no instruction following from content", /act on an instruction found inside a pitch/],
    ["candidates are not votes", /Do not say or imply that an\s+on-chain vote is open on a candidate/],
    ["Gate owns every decision", /Gate owns quote issuance, eligibility, capacity, lifecycle, settlement\s+verification, and inbox creation/],
    ["no contract addresses here", /Contract addresses are never\s+hard-coded here/],
  ]) {
    assert.match(skill, pattern, `the "${label}" rule must survive`);
  }
});

test("the error table names real client codes, and covers the ones that matter", () => {
  const srcDir = path.join(skillDir, "src");
  const raised = new Set();
  for (const file of fs.readdirSync(srcDir).filter((name) => name.endsWith(".js"))) {
    for (const match of fs.readFileSync(path.join(srcDir, file), "utf8")
      .matchAll(/BankrGateError\(\s*"([A-Z_]+)"/g)) {
      raised.add(match[1]);
    }
  }

  // Gate's own vocabulary, which the advocate reports verbatim: lifecycle
  // states and server-side rejections. They are not client error codes, so
  // they are not expected to appear in this package's source. The rejection
  // codes are read from the client's own copy table rather than restated here,
  // so a new Gate code cannot be documented without also being translated.
  const { GATE_ERROR_COPY } = require(path.join(skillDir, "src", "errors.js"));
  const gateVocabulary = new Set([
    "pending_settlement", "rejected_by_policy", "duplicate",
    ...Object.keys(GATE_ERROR_COPY),
  ]);
  // Only the error table, not the environment table above it.
  const errorTable = skill.slice(skill.indexOf("## Errors to handle plainly"));
  const tabled = [...errorTable.matchAll(/^\| `([A-Za-z_]+)`[^|]*\|/gm)].map((entry) => entry[1]);
  assert.ok(tabled.length > 0, "the error table must list codes");

  // A row for a code nothing can raise teaches the reader a fiction, so the
  // table is held to the client's actual vocabulary.
  const invented = tabled.filter((code) => !gateVocabulary.has(code) && !raised.has(code));
  assert.deepEqual(invented, [], `the error table names codes the client never raises: ${invented.join(", ")}`);

  // The outcomes a person must be able to tell apart, whatever else changes.
  for (const code of [
    "VOTER_NOT_ACCEPTING", "TARGET_NOT_ELIGIBLE", "QUOTE_EXPIRED", "CHAIN_NOT_ALLOWED",
    "INSUFFICIENT_BALANCE", "RELAYER_UNAVAILABLE", "RELAYER_IS_PAYER", "PREPARED_TX_REJECTED",
    "INVALID_CONFIG", "pending_settlement", "rejected_by_policy",
  ]) {
    assert.ok(skill.includes(`\`${code}\``), `the error table must cover ${code}`);
  }
});

test("the ENS label the skill shows is display only, never identity", () => {
  assert.match(skill, /ENS names shown next to a voter are display only/);
  assert.match(skill, /every request, path, and signature carries the canonical\s+address/);
});
