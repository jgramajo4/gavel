/**
 * Regressions for the adversarial review of the multi-DAO client.
 *
 * Each test names the behaviour that was wrong and pins the corrected one.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Wallet } = require("ethers");

const {
  LocalSignerWalletProvider,
  ReadinessLevel,
  WalletErrorCode,
  applyFollowedDaoSelection,
  configPath,
  createSetupWizard,
  defaultGavelConfig,
  interactiveExecutionAvailability,
  listExecutionOptions,
  parseGavelConfig,
  redactSecrets,
  resolveDaoReadiness,
  resolveRuntimeReadiness,
  saveGavelConfig,
  serializeGavelConfig,
  summarizeGavelReadiness,
  validateGavelConfig,
} = require("../packages/core");
const { readinessCommand, configCommand } = require("../packages/cli/runtime-commands");

const IDENTITY = "0x1111111111111111111111111111111111111111";
const SENTINEL = "GAVEL_REVIEW_SECRET_DO_NOT_LEAK";

function capture() {
  const chunks = [];
  const write = (text) => chunks.push(String(text));
  write.text = () => chunks.join("");
  write.json = () => JSON.parse(chunks.join(""));
  return write;
}
const dataDir = () => fs.mkdtemp(path.join(os.tmpdir(), "gavel-adv-"));

// ── Finding: unknown followed DAO crashed global readiness ──────────────

test("an unknown followed DAO degrades one row and never crashes readiness", () => {
  const row = resolveDaoReadiness({ dao: "ghost-dao", identityAddress: IDENTITY, probe: {} });
  assert.equal(row.known, false);
  assert.equal(row.monitor, ReadinessLevel.UNAVAILABLE);
  assert.equal(row.vote, ReadinessLevel.UNAVAILABLE);
  assert.equal(row.usable, false);
  assert.equal(row.reasons[0].code, "UNKNOWN_DAO");
  // Visible, not silently dropped, and not reinterpreted as another DAO.
  assert.equal(row.dao, "ghost-dao");
});

test("a healthy DAO beside an unknown one is still answered", () => {
  const daos = [
    resolveDaoReadiness({
      dao: "nouns",
      identityAddress: IDENTITY,
      probe: { indexFresh: true, identityResolved: true, votingPower: "4", delegationReady: true },
    }),
    resolveDaoReadiness({ dao: "ghost-dao", identityAddress: IDENTITY, probe: {} }),
  ];
  assert.equal(daos[0].vote, ReadinessLevel.READY);
  const summary = summarizeGavelReadiness({
    runtime: resolveRuntimeReadiness({ config: defaultGavelConfig(), dataDirWritable: true }),
    daos,
    config: defaultGavelConfig(),
  });
  // Degraded, launchable, and the healthy DAO still counted.
  assert.equal(summary.level, ReadinessLevel.DEGRADED);
  assert.equal(summary.canLaunch, true);
  assert.deepEqual(summary.counts, { followed: 2, monitorable: 1, votable: 1, unavailable: 1 });
});

test("`gavel readiness --json` survives an unknown DAO and keeps its shape", async () => {
  const dir = await dataDir();
  await fs.mkdir(dir, { recursive: true });
  // Written past the schema, the way a hand-edited config or an older build would.
  const config = parseGavelConfig({ ...defaultGavelConfig(), followedDaos: ["nouns"] });
  await fs.writeFile(
    configPath(dir),
    JSON.stringify({ ...config, followedDaos: ["nouns", "ghost-dao"] }),
    "utf8",
  );

  const write = capture();
  await readinessCommand(["--json"], {
    dataDir: dir,
    write,
    dataDirWritable: true,
    probe: async ({ dao }) =>
      dao === "nouns" ? { indexFresh: true, identityResolved: true, votingPower: "2" } : {},
  });
  const document = write.json();
  assert.equal(document.canLaunch, true);
  assert.equal(document.daos.nouns.monitor, "ready");
  assert.equal(document.daos["ghost-dao"].monitor, "unavailable");
  assert.equal(
    document.daos["ghost-dao"].reasons.find((entry) => entry.code === "UNKNOWN_DAO").severity,
    "error",
  );
  assert.equal(document.counts.unavailable, 1);
});

test("an unknown DAO cannot be executed against", () => {
  // Capability lookups fail closed, so no execution mode is ever offered for it.
  for (const option of listExecutionOptions({ walletType: "local", followedDaos: ["ghost-dao"] })) {
    if (option.mode === "unsigned") continue;
    assert.equal(option.available, false, option.mode);
  }
  assert.deepEqual(
    listExecutionOptions({ walletType: "local", followedDaos: ["ghost-dao"] })
      .find((option) => option.mode === "safe-supervised").supportedDaos,
    [],
  );
});

// ── Finding: interactive mode claimed available with no backend ─────────

test("interactive approval is reported unavailable in a build with no transport", () => {
  const availability = interactiveExecutionAvailability();
  assert.equal(availability.available, false);
  assert.match(availability.reason, /not available in this build/);

  // Onboarding, Settings and readiness all agree with the CLI.
  const offered = listExecutionOptions({ walletType: "walletconnect", followedDaos: ["nouns"] })
    .find((option) => option.mode === "eoa-supervised");
  assert.equal(offered.available, false);

  const runtime = resolveRuntimeReadiness({
    config: { ...defaultGavelConfig(), wallet: { type: "walletconnect" }, execution: { mode: "eoa-supervised" } },
    dataDirWritable: true,
    walletConnected: true,
  });
  assert.equal(runtime.interactiveAvailable, false);
  assert.equal(runtime.signals.execution, ReadinessLevel.UNAVAILABLE);
  assert.equal(runtime.reasons.some((entry) => entry.code === "EXECUTION_INTERACTIVE_UNAVAILABLE"), true);
  // Still fail-safe on approval.
  assert.equal(runtime.humanApprovalRequired, true);
});

// ── Finding: Settings bypassed the wizard's execution-capability rules ──

test("Settings and the wizard reconcile execution identically after a DAO change", () => {
  const start = parseGavelConfig({
    ...defaultGavelConfig(),
    followedDaos: ["nouns", "ens"],
    wallet: { type: "local", local: { signer: "keystore", keystoreLabel: "voter", variable: null } },
    execution: {
      ...defaultGavelConfig().execution,
      mode: "safe-supervised",
      safe: { address: "0x5555555555555555555555555555555555555555", chainId: 1, proposerIdentity: null },
    },
  });

  // Settings path: the shared transition.
  const settings = applyFollowedDaoSelection(start, ["railgun-eth"]);

  // Wizard path: the DAO step.
  const flow = createSetupWizard({
    env: {},
    config: start,
    walletMethods: [{ type: "local", label: "Local wallet", summary: "", recommended: false, available: true, blockers: [] }],
  });
  flow.goto("daos");
  flow.apply("daos", { daos: ["railgun-eth"] });

  // Railgun supports neither Safe nor autonomous execution, so both surfaces
  // must land on unsigned rather than leaving an impossible mode configured.
  assert.equal(settings.config.execution.mode, "unsigned");
  assert.equal(flow.draft.execution.mode, "unsigned");
  assert.deepEqual(settings.config.followedDaos, flow.draft.followedDaos);
  assert.equal(settings.downgraded, true);
  assert.equal(validateGavelConfig(settings.config).valid, true);
});

test("re-adding a capable DAO never promotes execution back up", () => {
  const unsigned = parseGavelConfig({
    ...defaultGavelConfig(),
    followedDaos: ["railgun-eth"],
    wallet: { type: "local", local: { signer: "keystore", keystoreLabel: "voter", variable: null } },
  });
  const widened = applyFollowedDaoSelection(unsigned, ["nouns", "railgun-eth"]);
  // Authority only ever decreases here. Re-selecting a mode stays explicit.
  assert.equal(widened.config.execution.mode, "unsigned");
  assert.equal(widened.downgraded, false);
});

// ── Finding: a disconnected local signer still broadcast ────────────────

test("a disconnected local signer has no executable authority", async () => {
  const wallet = Wallet.createRandom();
  const broadcasts = [];
  const signer = { address: async () => wallet.address, signTypedData: async () => "0xsig" };
  const provider = new LocalSignerWalletProvider({
    signer,
    broadcaster: { broadcast: async (request) => (broadcasts.push(request), { transactionHash: "0xok" }) },
    chainId: 1,
    source: { kind: "environment", variable: "GAVEL_PRIVATE_KEY" },
  });
  const request = () => ({
    chainId: 1,
    from: wallet.address,
    to: "0x2222222222222222222222222222222222222222",
    value: "0",
    data: "0x1234",
    intentHash: "a".repeat(64),
  });

  await provider.connect();
  assert.equal((await provider.requestTransaction(request())).transactionHash, "0xok");

  await provider.disconnect();
  // Displayed state and actual authority must agree.
  assert.equal((await provider.getStatus()).canSign, false);
  assert.deepEqual(provider.getCapabilities(), ["read"]);
  await assert.rejects(provider.requestTransaction(request()), (error) => {
    assert.equal(error.code, WalletErrorCode.NOT_CONNECTED);
    return true;
  });
  await assert.rejects(provider.requestSignature({ domain: { chainId: 1 }, types: {}, message: {} }), (error) => {
    assert.equal(error.code, WalletErrorCode.NOT_CONNECTED);
    return true;
  });
  assert.equal(broadcasts.length, 1, "nothing was broadcast while disconnected");

  // Holding the original signer object does not get you back in: the provider
  // is the gate, and it is still closed.
  assert.equal(typeof signer.signTypedData, "function");
  await assert.rejects(provider.requestTransaction(request()));

  // Capability returns only on an explicit reconnect.
  await provider.reconnect();
  assert.equal((await provider.requestTransaction(request())).transactionHash, "0xok");
  assert.equal(broadcasts.length, 2);
});

// ── Invariant: a prepared intent stays bound to the DAO it was built for ─

test("an intent's DAO binding cannot be retargeted by later state", () => {
  const { createVoteIntent, createExecutionIntent } = require("../packages/core");
  const voteIntent = createVoteIntent({
    dao: "nouns",
    chainId: 1,
    voterAddress: IDENTITY,
    proposalId: "123",
    support: "FOR",
    reason: "Consistent with prior votes.",
    createdAt: "2026-09-02T00:00:00.000Z",
  });
  const intent = createExecutionIntent({
    voteIntent,
    actor: IDENTITY,
    target: "0x0000000000000000000000000000000000000010",
    value: 0n,
    data: "0xdeadbeef",
  });
  assert.equal(voteIntent.dao, "nouns");
  assert.equal(intent.source.dao, "nouns");

  // Changing which DAOs are followed, or which one the UI is filtered to,
  // does not reach an intent that already exists.
  applyFollowedDaoSelection(
    parseGavelConfig({ ...defaultGavelConfig(), followedDaos: ["nouns", "ens"] }),
    ["ens"],
  );
  assert.equal(voteIntent.dao, "nouns");
  assert.equal(intent.source.dao, "nouns");

  // Frozen at construction, `source` included, so a direct retarget cannot
  // take effect -- silently in sloppy mode, with a TypeError under strict.
  assert.equal(Object.isFrozen(voteIntent), true);
  assert.equal(Object.isFrozen(intent), true);
  assert.equal(Object.isFrozen(intent.source), true);
  intent.source.dao = "ens";
  voteIntent.dao = "ens";
  assert.equal(intent.source.dao, "nouns");
  assert.equal(voteIntent.dao, "nouns");
  assert.throws(() => {
    "use strict";
    intent.source.dao = "ens";
  }, TypeError);
});

test("the CLI refuses a --dao that disagrees with a prepared document", () => {
  // `--dao` on `execution prepare` is a cross-check, never a selector: the
  // binding lives in the prediction and proposal documents.
  const cli = require("node:fs").readFileSync(
    path.resolve(__dirname, "..", "packages", "cli", "bin", "gavel.js"),
    "utf8",
  );
  assert.match(cli, /does not match the prediction's DAO/);
  assert.match(cli, /A prepared intent stays bound to the DAO it was built for/);
  // And the adapter is still constructed from the document, not the flag.
  assert.match(cli, /createDaoAdapter\(prediction\.dao, provider\)/);
});

// ── Finding: credential-bearing index URLs persisted and printed ────────

test("a URL carrying an arbitrary query secret cannot be persisted", async () => {
  const dir = await dataDir();
  const config = {
    ...defaultGavelConfig(),
    runtime: { dataDir: null, indexApiUrl: `https://index.example/v1?banana=${SENTINEL}`, indexApiUrlVariable: null },
  };
  // Validation says so, and the write refuses outright.
  assert.ok(validateGavelConfig(config).issues.some((issue) => issue.code === "INDEX_URL_CARRIES_CREDENTIALS"));
  await assert.rejects(saveGavelConfig(config, { dataDir: dir }), /credential-bearing URL/);
  await assert.rejects(fs.readFile(configPath(dir), "utf8"), /ENOENT/);

  // Userinfo is refused the same way.
  await assert.rejects(
    saveGavelConfig(
      { ...defaultGavelConfig(), runtime: { dataDir: null, indexApiUrl: `https://u:${SENTINEL}@index.example`, indexApiUrlVariable: null } },
      { dataDir: dir },
    ),
    /credential-bearing URL/,
  );
});

test("an arbitrary query secret never survives display, status or diagnostics", () => {
  const url = `https://index.example/v1?banana=${SENTINEL}&plum=${SENTINEL}`;
  const surfaces = {
    serialized: JSON.stringify(serializeGavelConfig({
      ...defaultGavelConfig(),
      // Serialization must redact even when a value reaches it some other way.
      runtime: { dataDir: null, indexApiUrl: url, indexApiUrlVariable: "GAVEL_INDEX_API_URL" },
    })),
    diagnostics: JSON.stringify(redactSecrets({ endpoint: url, nested: { retries: [url] } })),
    logLine: JSON.stringify(redactSecrets(`index read failed for ${url}`)),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert.ok(!text.includes(SENTINEL), `${name} leaked the sentinel`);
    // The parameter names survive, which is what keeps the output useful.
    assert.match(text, /banana/, name);
  }
  // The reference model is what remains visible.
  assert.match(surfaces.serialized, /GAVEL_INDEX_API_URL/);
});

test("`gavel config show --json` cannot print a query secret", async () => {
  const dir = await dataDir();
  await fs.mkdir(dir, { recursive: true });
  const config = parseGavelConfig({ ...defaultGavelConfig(), followedDaos: ["nouns"] });
  await fs.writeFile(
    configPath(dir),
    JSON.stringify({ ...config, runtime: { ...config.runtime, indexApiUrl: `https://index.example/?banana=${SENTINEL}` } }),
    "utf8",
  );
  const write = capture();
  await configCommand(["show", "--json"], { dataDir: dir, write });
  const text = write.text();
  assert.ok(!text.includes(SENTINEL), "config show leaked the sentinel");
  assert.match(text, /INDEX_URL_CARRIES_CREDENTIALS/, "and it says the URL is unacceptable");
});
