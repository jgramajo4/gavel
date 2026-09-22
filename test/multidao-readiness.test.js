const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ReadinessLevel,
  defaultGavelConfig,
  formatDaoReadinessLine,
  resolveDaoReadiness,
  resolveRuntimeReadiness,
  summarizeGavelReadiness,
} = require("../packages/core");

const IDENTITY = "0x1111111111111111111111111111111111111111";

const ready = (dao, probe = {}) =>
  resolveDaoReadiness({
    dao,
    identityAddress: IDENTITY,
    probe: { indexFresh: true, identityResolved: true, votingPower: "5", delegationReady: true, ...probe },
  });

test("readiness separates monitoring, analysis and voting", () => {
  const nouns = ready("nouns");
  assert.equal(nouns.monitor, ReadinessLevel.READY);
  assert.equal(nouns.analyze, ReadinessLevel.READY);
  assert.equal(nouns.vote, ReadinessLevel.READY);
  assert.equal(nouns.votingPowerLabel, "Votes");
  assert.equal(nouns.usable, true);
  assert.match(formatDaoReadinessLine(nouns), /^Nouns\s+monitor ready\s+analyze ready\s+vote ready$/);
});

test("zero voting power is a fact about the user, not an application error", () => {
  const dao = ready("ens", { votingPower: "0" });
  assert.equal(dao.vote, ReadinessLevel.UNAVAILABLE);
  // Following a DAO you hold no stake in is a normal way to use a client.
  assert.equal(dao.monitor, ReadinessLevel.READY);
  assert.equal(dao.analyze, ReadinessLevel.READY);
  assert.equal(dao.usable, true);
  const reason = dao.reasons.find((entry) => entry.code === "NO_VOTING_POWER");
  assert.equal(reason.severity, "info");
  // The DAO's own word, not Nouns'.
  assert.match(reason.message, /no voting power in ENS/);
  assert.match(ready("railgun-eth", { votingPower: "0" }).reasons.find((r) => r.code === "NO_VOTING_POWER").message,
    /no staked voting power in Railgun/);
});

test("delegation is per-DAO and Gavel never changes it on its own", () => {
  const dao = ready("nouns", { delegationReady: false });
  assert.equal(dao.vote, ReadinessLevel.DEGRADED);
  const reason = dao.reasons.find((entry) => entry.code === "DELEGATION_REQUIRED");
  assert.match(reason.message, /Nouns delegated votes does not point at the voting address/);
  assert.match(reason.message, /will not change it on its own/);
});

test("an unavailable DAO degrades one row, not the client", () => {
  const daos = [ready("nouns"), resolveDaoReadiness({ dao: "ens", identityAddress: IDENTITY, probe: { error: "index unreachable" } })];
  assert.equal(daos[1].usable, false);
  assert.equal(daos[1].monitor, ReadinessLevel.UNAVAILABLE);
  assert.match(daos[1].reasons[0].message, /ENS indexer unavailable: index unreachable/);

  const summary = summarizeGavelReadiness({
    runtime: resolveRuntimeReadiness({ config: defaultGavelConfig(), dataDirWritable: true, walletConnected: true }),
    daos,
    config: defaultGavelConfig(),
  });
  // Degraded, never unavailable, and the app still opens.
  assert.equal(summary.level, ReadinessLevel.DEGRADED);
  assert.equal(summary.canLaunch, true);
  assert.deepEqual(summary.counts, { followed: 2, monitorable: 1, votable: 1, unavailable: 1 });
});

test("every followed DAO being down still launches Gavel", () => {
  const daos = ["nouns", "ens"].map((dao) =>
    resolveDaoReadiness({ dao, identityAddress: IDENTITY, probe: { error: "offline" } }),
  );
  const summary = summarizeGavelReadiness({
    runtime: resolveRuntimeReadiness({ config: defaultGavelConfig(), dataDirWritable: true }),
    daos,
    config: defaultGavelConfig(),
  });
  assert.equal(summary.canLaunch, true);
  assert.equal(summary.counts.monitorable, 0);
});

test("a stale index degrades monitoring but still supports analysis", () => {
  const dao = ready("nouns", { indexFresh: false });
  assert.equal(dao.monitor, ReadinessLevel.DEGRADED);
  assert.equal(dao.analyze, ReadinessLevel.READY);
  assert.match(dao.reasons.find((entry) => entry.code === "INDEX_STALE").message, /Nouns proposal data is stale/);
});

test("no identity means no voting, and says so as information", () => {
  const dao = resolveDaoReadiness({ dao: "ens", identityAddress: null, probe: { indexFresh: true } });
  assert.equal(dao.signals.identity, ReadinessLevel.UNAVAILABLE);
  assert.equal(dao.vote, ReadinessLevel.UNAVAILABLE);
  assert.equal(dao.monitor, ReadinessLevel.READY);
  assert.equal(dao.reasons.find((entry) => entry.code === "IDENTITY_UNSET").severity, "info");
});

test("an unrecognized execution mode reports, and fails safe on approval", () => {
  // A config naming a mode this build does not know -- hand-edited, or written
  // by a newer build -- must produce the EXECUTION_MODE_UNKNOWN reason rather
  // than throwing out of readiness.
  const runtime = resolveRuntimeReadiness({
    config: { execution: { mode: "invented-mode" }, wallet: { type: "local" } },
    dataDirWritable: true,
    walletConnected: true,
  });
  assert.equal(runtime.signals.execution, ReadinessLevel.UNAVAILABLE);
  assert.ok(runtime.reasons.some((entry) => entry.code === "EXECUTION_MODE_UNKNOWN"));
  assert.equal(runtime.executionMode, "invented-mode");
  // Fail-safe: unknown is never treated as autonomous.
  assert.equal(runtime.humanApprovalRequired, true);
});

test("humanApprovalRequired is a readiness signal, not a second lookup", () => {
  const approval = (mode, extra = {}) =>
    resolveRuntimeReadiness({
      config: {
        wallet: { type: "local" },
        execution: { mode, autonomous: { acknowledgedAt: "2026-01-01T00:00:00.000Z" }, ...extra },
      },
      dataDirWritable: true,
      walletConnected: true,
    }).humanApprovalRequired;

  assert.equal(approval("unsigned"), true);
  assert.equal(approval("eoa-supervised"), true);
  assert.equal(approval("safe-supervised"), true);
  // The only mode where Gavel completes the action alone.
  assert.equal(approval("waap-autonomous"), false);
});

test("runtime readiness names the failing layer", () => {
  const readOnly = resolveRuntimeReadiness({
    config: defaultGavelConfig(),
    dataDirWritable: true,
    walletConnected: true,
  });
  assert.equal(readOnly.level, ReadinessLevel.READY);
  // Read-only is information, not a warning.
  assert.equal(readOnly.reasons.find((entry) => entry.code === "WALLET_READ_ONLY").severity, "info");

  const unwritable = resolveRuntimeReadiness({
    config: defaultGavelConfig(),
    dataDir: "/nope",
    dataDirWritable: false,
  });
  assert.equal(unwritable.signals.dataDir, ReadinessLevel.UNAVAILABLE);
  assert.equal(
    summarizeGavelReadiness({ runtime: unwritable, daos: [], config: defaultGavelConfig() }).canLaunch,
    false,
  );

  const interactiveWithoutWallet = resolveRuntimeReadiness({
    config: { ...defaultGavelConfig(), execution: { ...defaultGavelConfig().execution, mode: "eoa-supervised" } },
    dataDirWritable: true,
  });
  assert.equal(interactiveWithoutWallet.signals.execution, ReadinessLevel.UNAVAILABLE);
  assert.match(
    interactiveWithoutWallet.reasons.find((entry) => entry.code === "EXECUTION_NEEDS_WALLET").message,
    /needs a connected wallet/,
  );

  const autonomousWithoutConsent = resolveRuntimeReadiness({
    config: {
      ...defaultGavelConfig(),
      wallet: { ...defaultGavelConfig().wallet, type: "local" },
      execution: { ...defaultGavelConfig().execution, mode: "waap-autonomous" },
    },
    dataDirWritable: true,
    walletConnected: true,
  });
  assert.match(
    autonomousWithoutConsent.reasons.find((entry) => entry.code === "AUTONOMOUS_NOT_ACKNOWLEDGED").message,
    /Credentials alone never enable it/,
  );

  const remoteInference = resolveRuntimeReadiness({
    config: { ...defaultGavelConfig(), inference: { mode: "remote", endpointVariable: "PREDICTION_URL" } },
    dataDirWritable: true,
    inferenceReachable: false,
  });
  assert.equal(remoteInference.signals.inference, ReadinessLevel.DEGRADED);
  assert.match(
    remoteInference.reasons.find((entry) => entry.code === "INFERENCE_UNREACHABLE").message,
    /fall back to local precedents/,
  );
});
