const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SETUP_STEPS,
  SetupStep,
  createSetupWizard,
  defaultGavelConfig,
  listExecutionOptions,
  listInferenceOptions,
  listNetworkOptions,
  resolveDaoReadiness,
  validateGavelConfig,
} = require("../packages/core");

const SENTINEL_KEY = "0x" + "9a".repeat(32);
const IDENTITY = "0x1111111111111111111111111111111111111111";
const SAFE = "0x5555555555555555555555555555555555555555";
const EXECUTION_WALLET = "0x6666666666666666666666666666666666666666";

/** Every wallet method available, so step logic is under test rather than the environment. */
const WALLET_METHODS = [
  { type: "walletconnect", label: "WalletConnect", summary: "", recommended: true, available: true, blockers: [] },
  { type: "local", label: "Local wallet", summary: "", recommended: false, available: true, blockers: [] },
  { type: "read-only", label: "Read-only", summary: "", recommended: false, available: true, blockers: [] },
];

/**
 * `interactive` says whether the build can submit through a wallet. Injected
 * rather than mocked into existence: shipping code registers no transport, so
 * the default below is "unavailable" and only tests that are specifically
 * about a transport-bearing build opt in.
 */
const wizard = (options = {}) =>
  createSetupWizard({
    env: {},
    walletMethods: WALLET_METHODS,
    interactive: { available: false, reason: "no transport in this build" },
    now: () => new Date("2026-02-01T00:00:00.000Z"),
    ...options,
  });

const INTERACTIVE_READY = { available: true, reason: null };

test("the wizard is eleven ordered steps and starts at the beginning", () => {
  const flow = wizard();
  assert.deepEqual(
    SETUP_STEPS.map((step) => step.id),
    [
      "welcome",
      "data-dir",
      "daos",
      "wallet",
      "verify",
      "execution",
      "inference",
      "privacy",
      "notifications",
      "review",
      "finish",
    ],
  );
  assert.equal(flow.stepId, SetupStep.WELCOME);
  assert.equal(flow.isFirst, true);
});

test("walking the whole flow produces a valid config", () => {
  const flow = wizard({ interactive: INTERACTIVE_READY });
  assert.equal(flow.next().ok, true); // welcome
  assert.equal(flow.stepId, SetupStep.DATA_DIR);

  flow.apply(SetupStep.DATA_DIR, { dataDir: "/tmp/gavel-data" });
  assert.equal(flow.next().ok, true);
  assert.equal(flow.stepId, SetupStep.DAOS);

  // Following two DAOs at once is the ordinary case, not a special one.
  assert.equal(flow.apply(SetupStep.DAOS, { daos: ["ens", "nouns"] }).ok, true);
  assert.deepEqual(flow.draft.followedDaos, ["nouns", "ens"]);
  assert.equal(flow.next().ok, true);

  assert.equal(flow.apply(SetupStep.WALLET, { type: "walletconnect", address: IDENTITY }).ok, true);
  assert.equal(flow.draft.identity.address, IDENTITY);
  assert.equal(flow.draft.wallet.walletconnect.projectIdVariable, "WALLETCONNECT_PROJECT_ID");
  assert.equal(flow.next().ok, true);

  assert.equal(flow.stepId, SetupStep.VERIFY);
  assert.equal(flow.next().ok, true); // advisory: never blocks

  assert.equal(flow.apply(SetupStep.EXECUTION, { mode: "eoa-supervised" }).ok, true);
  assert.equal(flow.next().ok, true);

  assert.equal(flow.apply(SetupStep.INFERENCE, { mode: "local" }).ok, true);
  assert.equal(flow.next().ok, true);

  assert.equal(flow.apply(SetupStep.PRIVACY, { network: "direct" }).ok, true);
  assert.equal(flow.next().ok, true);

  assert.equal(flow.apply(SetupStep.NOTIFICATIONS, { dailyBriefing: true }).ok, true);
  assert.equal(flow.next().ok, true);
  assert.equal(flow.stepId, SetupStep.REVIEW);
  assert.equal(flow.next().ok, true);
  assert.equal(flow.stepId, SetupStep.FINISH);

  const finished = flow.finish();
  assert.equal(finished.ok, true);
  assert.equal(finished.config.onboarding.completed, true);
  assert.equal(finished.config.onboarding.completedAt, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(finished.config.followedDaos, ["nouns", "ens"]);
  assert.equal(finished.config.execution.mode, "eoa-supervised");
  assert.equal(finished.config.notifications.dailyBriefing, true);
  assert.equal(validateGavelConfig(finished.config).valid, true);
});

test("pressing Enter through the whole wizard yields a safe monitoring client", () => {
  const flow = wizard();
  flow.goto(SetupStep.DAOS);
  flow.apply(SetupStep.DAOS, { daos: ["nouns"] });
  for (const step of ["wallet", "verify", "execution", "inference", "privacy", "notifications", "review", "finish"]) {
    flow.next();
    assert.equal(flow.stepId, step);
  }
  const finished = flow.finish();
  assert.equal(finished.ok, true);
  assert.equal(finished.config.wallet.type, "read-only");
  assert.equal(finished.config.execution.mode, "unsigned");
  assert.equal(finished.config.inference.mode, "local");
  assert.equal(finished.config.privacy.network, "direct");
});

test("Next is blocked only where the current step owns the problem", () => {
  const flow = wizard();
  flow.goto(SetupStep.DAOS);
  // At least one DAO: a client following nothing has nothing to show.
  assert.deepEqual(flow.blockers().map((issue) => issue.code), ["NO_DAOS_SELECTED"]);
  assert.equal(flow.next().ok, false);
  flow.apply(SetupStep.DAOS, { daos: ["nouns"] });
  assert.equal(flow.canAdvance(), true);

  // The verify step is advisory: a DAO that is down must not trap the user.
  flow.goto(SetupStep.VERIFY);
  flow.verification = [resolveDaoReadiness({ dao: "nouns", identityAddress: null, probe: { error: "offline" } })];
  assert.deepEqual(flow.blockers(), []);
  assert.equal(flow.next().ok, true);
});

test("Back and resume", () => {
  const flow = wizard();
  flow.goto(SetupStep.EXECUTION);
  flow.back();
  assert.equal(flow.stepId, SetupStep.VERIFY);
  flow.back();
  assert.equal(flow.stepId, SetupStep.WALLET);
  // Back at the first step is a no-op rather than an error.
  flow.goto(SetupStep.WELCOME);
  flow.back();
  assert.equal(flow.stepId, SetupStep.WELCOME);

  // A half-finished wizard resumes where it stopped.
  flow.goto(SetupStep.INFERENCE);
  const resumed = wizard({ config: flow.draft });
  assert.equal(resumed.stepId, SetupStep.INFERENCE);
  // A recorded step that no longer exists falls back to the start.
  const stale = wizard({ config: { ...defaultGavelConfig(), onboarding: { completed: false, completedAt: null, lastStep: "removed-step" } } });
  assert.equal(stale.stepId, SetupStep.WELCOME);
  assert.throws(() => flow.goto("nope"), /Unknown setup step/);
});

test("execution modes are offered only where they can work", () => {
  // This build registers no wallet transport, so interactive approval is
  // unavailable whatever wallet is chosen -- and the reason says so, rather
  // than sending the user to connect a wallet that would not help.
  const noTransport = listExecutionOptions({ walletType: "local", followedDaos: ["nouns"] });
  const unavailable = noTransport.find((option) => option.mode === "eoa-supervised");
  assert.equal(unavailable.available, false);
  assert.match(unavailable.blockers[0], /not available in this build/);

  // With a transport, the wallet becomes the deciding factor again.
  const readOnly = listExecutionOptions({
    walletType: "read-only",
    followedDaos: ["nouns"],
    interactive: { available: true, reason: null },
  });
  const interactive = readOnly.find((option) => option.mode === "eoa-supervised");
  assert.equal(interactive.available, false);
  assert.match(interactive.blockers[0], /Connect a wallet/);
  assert.equal(readOnly.find((option) => option.mode === "unsigned").available, true);

  // Railgun supports neither Safe nor autonomous execution.
  const railgunOnly = listExecutionOptions({ walletType: "local", followedDaos: ["railgun-eth"] });
  assert.equal(railgunOnly.find((option) => option.mode === "safe-supervised").available, false);
  assert.match(
    railgunOnly.find((option) => option.mode === "safe-supervised").blockers[0],
    /None of your followed DAOs support/,
  );
  // Adding a DAO that does support it re-enables the option.
  const withNouns = listExecutionOptions({ walletType: "local", followedDaos: ["railgun-eth", "nouns"] });
  assert.equal(withNouns.find((option) => option.mode === "safe-supervised").available, true);
  assert.deepEqual(withNouns.find((option) => option.mode === "safe-supervised").supportedDaos, ["nouns"]);

  // Autonomous is never a one-keystroke choice.
  assert.equal(
    listExecutionOptions({ walletType: "local", followedDaos: ["nouns"] }).find(
      (option) => option.mode === "waap-autonomous",
    ).available,
    false,
  );
  // Unimplemented modes are not offered at all.
  assert.equal(readOnly.some((option) => option.mode === "erc4337"), false);

  assert.equal(listInferenceOptions().length, 3);
  assert.deepEqual(
    listNetworkOptions().filter((option) => option.available).map((option) => option.network),
    ["direct"],
  );
});

test("interactive approval is not selectable when this build cannot submit", () => {
  // The mismatch this guards: a mode the config accepts but the CLI then
  // refuses at submit time. Onboarding must not offer it in the first place.
  const flow = wizard();
  flow.goto(SetupStep.DAOS);
  flow.apply(SetupStep.DAOS, { daos: ["nouns"] });
  flow.goto(SetupStep.WALLET);
  flow.apply(SetupStep.WALLET, { type: "walletconnect", address: IDENTITY });
  flow.goto(SetupStep.EXECUTION);

  const offered = flow.options().modes.find((mode) => mode.mode === "eoa-supervised");
  assert.equal(offered.available, false);
  assert.match(offered.blockers[0], /no transport in this build/);

  const rejected = flow.apply(SetupStep.EXECUTION, { mode: "eoa-supervised" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.issues[0].code, "EXECUTION_MODE_UNAVAILABLE");
  assert.equal(flow.draft.execution.mode, "unsigned");
});

test("an impossible execution mode cannot be selected", () => {
  const flow = wizard();
  flow.goto(SetupStep.DAOS);
  flow.apply(SetupStep.DAOS, { daos: ["railgun-eth"] });
  flow.goto(SetupStep.EXECUTION);
  const rejected = flow.apply(SetupStep.EXECUTION, { mode: "safe-supervised", safeAddress: SAFE });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.issues[0].code, "EXECUTION_MODE_UNAVAILABLE");
  // A rejected answer leaves the draft exactly as it was.
  assert.equal(flow.draft.execution.mode, "unsigned");

  const unimplementedNetwork = flow.apply(SetupStep.PRIVACY, { network: "tor" });
  assert.equal(unimplementedNetwork.ok, false);
  assert.equal(unimplementedNetwork.issues[0].code, "NETWORK_MODE_UNIMPLEMENTED");
});

test("changing wallet or DAOs downgrades an execution mode that no longer works", () => {
  const flow = wizard({ interactive: INTERACTIVE_READY });
  flow.goto(SetupStep.DAOS);
  flow.apply(SetupStep.DAOS, { daos: ["nouns"] });
  flow.goto(SetupStep.WALLET);
  flow.apply(SetupStep.WALLET, { type: "walletconnect", address: IDENTITY });
  flow.goto(SetupStep.EXECUTION);
  flow.apply(SetupStep.EXECUTION, { mode: "eoa-supervised" });
  assert.equal(flow.draft.execution.mode, "eoa-supervised");

  // Switching to read-only takes signing away, so the mode falls back rather
  // than leaving a config that claims an impossible capability.
  flow.goto(SetupStep.WALLET);
  flow.apply(SetupStep.WALLET, { type: "read-only" });
  assert.equal(flow.draft.execution.mode, "unsigned");
  assert.equal(validateGavelConfig(flow.draft).valid, true);
});

test("autonomous execution requires acknowledgement and a separate wallet", () => {
  const flow = wizard();
  flow.goto(SetupStep.DAOS);
  flow.apply(SetupStep.DAOS, { daos: ["nouns"] });
  flow.goto(SetupStep.WALLET);
  flow.apply(SetupStep.WALLET, { type: "local", signer: "keystore", keystoreLabel: "voter", address: IDENTITY });
  flow.goto(SetupStep.EXECUTION);

  // Without acknowledgement the mode is not selectable at all.
  assert.equal(
    flow.apply(SetupStep.EXECUTION, { mode: "waap-autonomous", executionAddress: EXECUTION_WALLET }).ok,
    false,
  );
  // Reusing the governance identity as the execution wallet is refused.
  const sameKey = flow.apply(SetupStep.EXECUTION, {
    mode: "waap-autonomous",
    executionAddress: IDENTITY,
    acknowledgeAutonomous: true,
  });
  assert.equal(sameKey.ok, false);
  assert.equal(sameKey.issues[0].code, "AUTONOMOUS_ADDRESS_NOT_SEPARATE");

  const accepted = flow.apply(SetupStep.EXECUTION, {
    mode: "waap-autonomous",
    executionAddress: EXECUTION_WALLET,
    policyId: "vote-only",
    acknowledgeAutonomous: true,
  });
  assert.equal(accepted.ok, true);
  assert.equal(flow.draft.execution.autonomous.acknowledgedAt, "2026-02-01T00:00:00.000Z");
  // Switching modes never touches delegation.
  assert.equal(flow.draft.execution.payoutAddress, null);
  assert.equal(validateGavelConfig(flow.draft).valid, true);
});

test("a mistyped address is an issue, not an exception", () => {
  // `apply()` promises `{ ok, issues }`. A caller that trusts the return value
  // instead of wrapping the call must not be handed a thrown ethers error when
  // a user fat-fingers a Safe or execution address.
  const flow = wizard();
  flow.goto(SetupStep.DAOS);
  flow.apply(SetupStep.DAOS, { daos: ["nouns"] });
  flow.goto(SetupStep.WALLET);

  const badIdentity = flow.apply(SetupStep.WALLET, { type: "local", signer: "keystore", keystoreLabel: "voter", address: "0xnope" });
  assert.equal(badIdentity.ok, false);
  assert.equal(badIdentity.issues[0].code, "INVALID_ADDRESS");
  assert.equal(badIdentity.issues[0].path, "identity.address");
  assert.equal(flow.draft.identity.address, null);

  flow.apply(SetupStep.WALLET, { type: "local", signer: "keystore", keystoreLabel: "voter", address: IDENTITY });
  flow.goto(SetupStep.EXECUTION);

  const badSafe = flow.apply(SetupStep.EXECUTION, { mode: "safe-supervised", safeAddress: "0x123" });
  assert.equal(badSafe.ok, false);
  assert.equal(badSafe.issues[0].code, "INVALID_ADDRESS");
  assert.equal(badSafe.issues[0].path, "execution.safe.address");
  // A rejected answer leaves the draft untouched: no half-applied mode.
  assert.equal(flow.draft.execution.mode, "unsigned");
  assert.equal(flow.draft.execution.safe, null);

  const badAutonomous = flow.apply(SetupStep.EXECUTION, {
    mode: "waap-autonomous",
    executionAddress: "not-an-address",
    acknowledgeAutonomous: true,
  });
  assert.equal(badAutonomous.ok, false);
  assert.equal(badAutonomous.issues[0].code, "INVALID_ADDRESS");
  assert.equal(badAutonomous.issues[0].path, "execution.autonomous.executionAddress");
  assert.equal(flow.draft.execution.autonomous, null);

  // The valid forms still work, including a lowercase address.
  const accepted = flow.apply(SetupStep.EXECUTION, { mode: "safe-supervised", safeAddress: SAFE.toLowerCase() });
  assert.equal(accepted.ok, true);
  assert.equal(flow.draft.execution.safe.address, SAFE);
});

test("the review page shows status and never a secret", () => {
  const flow = wizard({
    env: { GAVEL_PRIVATE_KEY: SENTINEL_KEY, WALLETCONNECT_PROJECT_ID: "project-id" },
  });
  flow.goto(SetupStep.DAOS);
  flow.apply(SetupStep.DAOS, { daos: ["nouns", "ens"] });
  flow.goto(SetupStep.WALLET);
  flow.apply(SetupStep.WALLET, {
    type: "local",
    signer: "environment",
    variable: "GAVEL_PRIVATE_KEY",
    address: IDENTITY,
  });
  flow.verification = [
    resolveDaoReadiness({ dao: "nouns", identityAddress: IDENTITY, probe: { indexFresh: true, votingPower: "3" } }),
    resolveDaoReadiness({ dao: "ens", identityAddress: IDENTITY, probe: { error: "offline" } }),
  ];
  flow.goto(SetupStep.REVIEW);
  const review = flow.review();

  assert.deepEqual(review.daos.map((dao) => dao.id), ["nouns", "ens", "railgun-eth"]);
  assert.equal(review.daos.find((dao) => dao.id === "railgun-eth").status, "Not selected");
  assert.equal(review.wallet.label, "Local wallet");
  // The reference, not the value.
  assert.equal(review.wallet.signerSource.variable, "GAVEL_PRIVATE_KEY");
  assert.equal(review.secrets.find((secret) => secret.id === "execution-signer").status, "configured");
  const serialized = JSON.stringify(review);
  assert.ok(!serialized.includes(SENTINEL_KEY), "the review page must never carry a secret");
  assert.ok(!serialized.includes("project-id"));
  assert.match(serialized, /GAVEL_PRIVATE_KEY/);
  assert.equal(review.overall, "Ready");
});

test("the data-directory step says what is and is not stored there", () => {
  const flow = wizard();
  flow.goto(SetupStep.DATA_DIR);
  const options = flow.options();
  assert.ok(options.contents.stored.some((line) => /followed DAOs/.test(line)));
  for (const forbidden of [/seed phrases/, /private keys/, /API keys/, /WalletConnect session secrets/]) {
    assert.ok(options.contents.notStored.some((line) => forbidden.test(line)), String(forbidden));
  }
});
