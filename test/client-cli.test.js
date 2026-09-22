const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  configCommand,
  daosCommand,
  readinessCommand,
  secretsCommand,
  walletCommand,
} = require("../packages/cli/runtime-commands");
const { configPath, defaultGavelConfig, saveGavelConfig } = require("../packages/core");

const SENTINEL_KEY = "0x" + "7f".repeat(32);
const IDENTITY = "0x1111111111111111111111111111111111111111";
const SAFE = "0x5555555555555555555555555555555555555555";
const EXECUTION_WALLET = "0x6666666666666666666666666666666666666666";

/** Capture stdout so a command's machine-readable answer can be asserted. */
function capture() {
  const chunks = [];
  const write = (text) => chunks.push(String(text));
  write.text = () => chunks.join("");
  write.json = () => JSON.parse(chunks.join(""));
  return write;
}

async function dataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "gavel-cli-"));
}

test("`gavel daos list` reads the catalog, not a private array", async () => {
  const write = capture();
  await daosCommand(["list", "--json"], { dataDir: await dataDir(), write });
  const document = write.json();
  assert.equal(document.command, "daos.list");
  assert.deepEqual(document.daos.map((dao) => dao.id), ["nouns", "ens", "railgun-eth"]);
  for (const dao of document.daos) {
    assert.equal(dao.available, true, dao.id);
    assert.equal(dao.followed, false);
  }
});

test("`gavel daos follow` and `unfollow` are the CLI half of the wizard's DAO step", async () => {
  const dir = await dataDir();
  const io = { dataDir: dir };

  let write = capture();
  await daosCommand(["follow", "ens", "nouns", "--json"], { ...io, write });
  // Catalog order, so the persisted document is stable.
  assert.deepEqual(write.json().followedDaos, ["nouns", "ens"]);

  write = capture();
  await daosCommand(["unfollow", "nouns", "--json"], { ...io, write });
  assert.deepEqual(write.json().followedDaos, ["ens"]);

  // Following twice is idempotent rather than duplicating.
  write = capture();
  await daosCommand(["follow", "ens", "--json"], { ...io, write });
  assert.deepEqual(write.json().followedDaos, ["ens"]);

  await assert.rejects(daosCommand(["follow", "not-a-dao"], io), /Unknown DAO: not-a-dao/);

  // The change is on disk, where the TUI reads it.
  const saved = JSON.parse(await fs.readFile(configPath(dir), "utf8"));
  assert.deepEqual(saved.followedDaos, ["ens"]);
});

test("`gavel daos capabilities` answers what each DAO can do", async () => {
  const write = capture();
  await daosCommand(["capabilities", "--dao", "railgun-eth", "--json"], { dataDir: await dataDir(), write });
  const [row] = write.json().daos;
  assert.equal(row.displayName, "Railgun");
  const capability = (name) => row.capabilities.find((entry) => entry.capability === name).supported;
  assert.equal(capability("voting"), true);
  assert.equal(capability("safeSupervised"), false);
  assert.equal(capability("calendar"), false);
});

test("`gavel wallet status` separates roles and never shows a secret", async () => {
  const dir = await dataDir();
  await saveGavelConfig(
    {
      ...defaultGavelConfig(),
      followedDaos: ["nouns"],
      identity: { address: IDENTITY, label: null },
      wallet: {
        type: "local",
        local: { signer: "environment", keystoreLabel: null, variable: "GAVEL_PRIVATE_KEY" },
        walletconnect: null,
      },
      execution: {
        mode: "unsigned",
        safe: { address: SAFE, chainId: 1, proposerIdentity: "local:proposer" },
        autonomous: { executionAddress: EXECUTION_WALLET, policyId: "vote-only", acknowledgedAt: null },
        payoutAddress: null,
      },
    },
    { dataDir: dir },
  );

  const write = capture();
  await walletCommand(["status", "--json"], { dataDir: dir, write, env: { GAVEL_PRIVATE_KEY: SENTINEL_KEY } });
  const document = write.json();
  // Four distinct authorities, named separately. A generic "wallet" field is
  // what made these confusable.
  assert.deepEqual(document.roles, {
    governanceIdentity: IDENTITY,
    safeAddress: SAFE,
    autonomousExecutionAddress: EXECUTION_WALLET,
    payoutAddress: null,
  });
  assert.equal(document.signerSource.variable, "GAVEL_PRIVATE_KEY");
  assert.ok(!JSON.stringify(document).includes(SENTINEL_KEY));
});

test("`gavel readiness` is per DAO and says whether a human must approve", async () => {
  const dir = await dataDir();
  await saveGavelConfig(
    { ...defaultGavelConfig(), followedDaos: ["nouns", "ens"], identity: { address: IDENTITY, label: null } },
    { dataDir: dir },
  );

  const write = capture();
  await readinessCommand(["--json"], {
    dataDir: dir,
    write,
    dataDirWritable: true,
    // One DAO healthy, one down: the client is degraded, not unavailable.
    probe: async ({ dao }) =>
      dao === "nouns"
        ? { indexFresh: true, identityResolved: true, votingPower: "2", delegationReady: true }
        : Promise.reject(new Error("ENS indexer unavailable")),
  });
  const document = write.json();
  assert.equal(document.canLaunch, true);
  assert.equal(document.level, "degraded");
  assert.equal(document.daos.nouns.vote, "ready");
  assert.equal(document.daos.ens.index, "unavailable");
  // A harness asks exactly this before acting on a recommendation.
  assert.equal(document.executionMode, "unsigned");
  assert.equal(document.humanApprovalRequired, true);
  assert.deepEqual(document.counts, { followed: 2, monitorable: 1, votable: 1, unavailable: 1 });
});

test("zero voting power is reported, not treated as a failure", async () => {
  const dir = await dataDir();
  await saveGavelConfig(
    { ...defaultGavelConfig(), followedDaos: ["ens"], identity: { address: IDENTITY, label: null } },
    { dataDir: dir },
  );
  const write = capture();
  await readinessCommand(["--json"], {
    dataDir: dir,
    write,
    dataDirWritable: true,
    probe: async () => ({ indexFresh: true, identityResolved: true, votingPower: "0" }),
  });
  const document = write.json();
  assert.equal(document.canLaunch, true);
  assert.equal(document.daos.ens.monitor, "ready");
  assert.equal(document.daos.ens.vote, "unavailable");
  assert.equal(
    document.daos.ens.reasons.find((reason) => reason.code === "NO_VOTING_POWER").severity,
    "info",
  );
});

test("`gavel secrets status` reports source and status only", async () => {
  const write = capture();
  await secretsCommand(["status", "--json"], {
    dataDir: await dataDir(),
    write,
    env: { GAVEL_PRIVATE_KEY: SENTINEL_KEY },
  });
  const text = write.text();
  assert.ok(!text.includes(SENTINEL_KEY));
  const signer = write.json().secrets.find((row) => row.id === "execution-signer");
  assert.equal(signer.source, "environment");
  assert.equal(signer.status, "configured");
});

test("`gavel config show` is redacted, and reports migration once", async () => {
  const dir = await dataDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    configPath(dir),
    JSON.stringify({ version: 1, dao: "nouns", wallet: { address: IDENTITY, privateKey: SENTINEL_KEY } }),
    "utf8",
  );

  let write = capture();
  await configCommand(["show", "--json"], { dataDir: dir, write });
  let document = write.json();
  assert.equal(document.migrated, true);
  assert.deepEqual(document.config.followedDaos, ["nouns"]);
  assert.ok(!write.text().includes(SENTINEL_KEY));
  assert.ok(document.migrationNotes.some((note) => note.code === "PLAINTEXT_SECRET_REMOVED"));

  write = capture();
  await configCommand(["migrate", "--json"], { dataDir: dir, write });
  assert.equal(write.json().migrated, true);
  assert.ok(!(await fs.readFile(configPath(dir), "utf8")).includes(SENTINEL_KEY));

  // Second read sees a current document.
  write = capture();
  await configCommand(["show", "--json"], { dataDir: dir, write });
  document = write.json();
  assert.equal(document.migrated, false);
  assert.equal(document.exists, true);

  write = capture();
  await configCommand(["path"], { dataDir: dir, write });
  assert.equal(write.text().trim(), configPath(dir));

  await assert.rejects(configCommand(["invent"], { dataDir: dir }), /config accepts the subcommands/);
});

test("the CLI exposes every setting the wizard writes", () => {
  // CLI parity, asserted rather than assumed: a runtime with no terminal must
  // be able to reach the same configuration the TUI collects.
  const cli = require("node:fs").readFileSync(
    path.resolve(__dirname, "..", "packages", "cli", "bin", "gavel.js"),
    "utf8",
  );
  for (const command of ["daos", "wallet", "readiness", "secrets", "config"]) {
    assert.match(cli, new RegExp(`command === "${command}"`), command);
    assert.match(cli, new RegExp(`gavel ${command} `), `${command} is documented in usage`);
  }
});
