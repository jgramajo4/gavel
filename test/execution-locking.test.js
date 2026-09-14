"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FileExecutionRecordStore,
  InMemoryExecutionRecordStore,
} = require("../packages/core/src/execution/records");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

for (const [name, makeStore] of [
  ["memory", () => new InMemoryExecutionRecordStore()],
  ["file", () => new FileExecutionRecordStore(fs.mkdtempSync(path.join(os.tmpdir(), "gavel-locks-")))],
]) {
  test(`${name} store serializes concurrent holders of the same resource key`, async () => {
    const store = makeStore();
    let active = 0;
    let highest = 0;
    const enter = async () => store.withLocks(["same-key"], async () => {
      active += 1;
      highest = Math.max(highest, active);
      await delay(25);
      active -= 1;
    });

    await Promise.all([enter(), enter(), enter()]);

    assert.equal(highest, 1);
  });
}

test("file store serializes the same key across OS processes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-process-lock-"));
  const log = path.join(root, "holders.log");
  const records = path.resolve(__dirname, "../packages/core/src/execution/records.js");
  const child = String.raw`
    const fs = require("node:fs");
    const { FileExecutionRecordStore } = require(process.argv[2]);
    const [root, id, log] = [process.argv[1], process.argv[3], process.argv[4]];
    new FileExecutionRecordStore(root).withLocks(["shared"], async () => {
      fs.appendFileSync(log, "start:" + id + "\n");
      await new Promise((resolve) => setTimeout(resolve, 150));
      fs.appendFileSync(log, "end:" + id + "\n");
    }).catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const run = (id) => new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, ["-e", child, root, records, id, log]);
    let stderr = "";
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.on("error", reject);
    childProcess.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });

  await Promise.all([run("a"), run("b")]);

  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.match(lines.join(" "), /^start:(a|b) end:\1 start:(a|b) end:\2$/);
});

test("file lock release never deletes a successor installed at the lock pathname", { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-lock-aba-"));
  const key = "aba-key";
  const lock = path.join(root, ".locks", crypto.createHash("sha256").update(key).digest("hex"));
  const displaced = `${lock}.displaced`;
  const originalRename = fs.promises.rename;
  let swapped = false;

  try {
    await new FileExecutionRecordStore(root).withLocks([key], async () => {
      fs.promises.rename = async (from, to) => {
        if (!swapped && from === lock && to.includes(".release-")) {
          swapped = true;
          await originalRename(from, displaced);
          await fs.promises.mkdir(lock, { recursive: true });
          await fs.promises.writeFile(path.join(lock, "owner.json"), JSON.stringify({ token: "successor" }));
        }
        return originalRename(from, to);
      };
    });
  } finally {
    fs.promises.rename = originalRename;
  }

  assert.equal(swapped, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, "successor");
  assert.equal(fs.existsSync(displaced), true);
});

test("stale-lock reclamation never deletes a successor installed at the lock pathname", { concurrency: false }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-stale-aba-"));
  const key = "stale-aba-key";
  const lock = path.join(root, ".locks", crypto.createHash("sha256").update(key).digest("hex"));
  const displaced = `${lock}.displaced`;
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    hostname: os.hostname(), pid: 2_147_483_647, processStart: "dead", token: "dead",
  }));
  const originalRename = fs.promises.rename;
  let swapped = false;

  try {
    fs.promises.rename = async (from, to) => {
      if (!swapped && from === lock && to.includes(".stale-")) {
        swapped = true;
        await originalRename(from, displaced);
        await fs.promises.mkdir(lock, { recursive: true });
        await fs.promises.writeFile(path.join(lock, "owner.json"), JSON.stringify({
          hostname: os.hostname(), pid: process.pid, processStart: "live", token: "successor",
        }));
      }
      return originalRename(from, to);
    };
    const store = new FileExecutionRecordStore(root, {
      lockTimeoutMs: 40,
      processStartReader: async (pid) => pid === process.pid ? "live" : null,
    });
    await assert.rejects(store.withLocks([key], async () => {}), /Timed out acquiring execution lock/);
  } finally {
    fs.promises.rename = originalRename;
  }

  assert.equal(swapped, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token, "successor");
  assert.equal(fs.existsSync(displaced), true);
});

test("file store fails fast when Linux process fingerprints are unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-no-proc-"));
  const store = new FileExecutionRecordStore(root, {
    processStartReader: async () => null,
  });
  await assert.rejects(
    store.withLocks(["same-key"], async () => {}),
    /requires Linux \/proc/,
  );
});

test("file store recovers a lock owned by a dead local process fingerprint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-stale-lock-"));
  const key = "dead-owner";
  const lock = path.join(root, ".locks", crypto.createHash("sha256").update(key).digest("hex"));
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    hostname: os.hostname(),
    pid: 2_147_483_647,
    processStart: "1",
    token: "dead-token",
  }));

  const store = new FileExecutionRecordStore(root, { lockTimeoutMs: 250 });
  const result = await store.withLocks([key], async () => "recovered");

  assert.equal(result, "recovered");
  assert.equal(fs.existsSync(lock), false);
});

test("file record walks exclude live lock metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gavel-lock-walk-"));
  const store = new FileExecutionRecordStore(root);

  await store.withLocks(["walk-key"], async () => {
    assert.deepEqual(await store.list(), []);
  });
});
