/**
 * Execution records: attempts, kept separately from governance intents.
 *
 * One governance decision may be attempted several times through different
 * providers -- a Safe proposal expires, the user switches to autonomous
 * execution -- and none of that history belongs in the canonical intent. The
 * intent stays the stable identity; records accumulate around it.
 *
 * This is also where every provider-specific value lives: safeTxHash, Safe
 * nonce, transaction hash, provider request id. None of them are hashed into
 * the intent, which is exactly what makes retry safe and the same intent
 * portable across modes.
 */

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const { z } = require("zod");
const { getAddress } = require("ethers");

const { ExecutionState, assertTransition, isActiveExecutionState, isSuccessfulExecutionState } = require("./lifecycle");
const { getExecutionMode } = require("./modes");
const {
  addressSchema,
  daoIdSchema,
  decimalStringSchema,
  hexSchema,
  intentHashSchema,
} = require("../schema/intent");

const providerDataSchema = z
  .object({
    safeTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    safeNonce: decimalStringSchema.optional(),
    safeAddress: addressSchema.optional(),
    transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    providerRequestId: z.string().min(1).optional(),
    providerStatus: z.string().min(1).optional(),
  })
  .partial()
  .strict();

const executionRecordSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  /** The idempotency key: intentHash + mode + actor. */
  key: z.string().min(1),
  intentHash: intentHashSchema,
  voteIntentHash: intentHashSchema,
  mode: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  actor: addressSchema,
  dao: daoIdSchema,
  proposalId: z.string().min(1),
  support: z.enum(["FOR", "AGAINST", "ABSTAIN"]),
  chainId: z.number().int().positive(),
  target: addressSchema,
  selector: z.string().regex(/^0x[0-9a-f]{8}$/),
  state: z.enum(Object.values(ExecutionState)),
  attempt: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  providerData: providerDataSchema.default({}),
  /** Every state the attempt passed through, for the audit chain. */
  history: z
    .array(
      z.object({
        state: z.enum(Object.values(ExecutionState)),
        at: z.string().datetime(),
        detail: z.string().nullable().optional(),
      }),
    )
    .min(1),
  /** Why Gavel believed this action was correct, carried from validation. */
  audit: z.object({
    adapterVersion: z.string().min(1),
    validatedAt: z.string().datetime(),
    proposalState: z.string().min(1),
    governanceTarget: addressSchema,
    autonomyAllowed: z.boolean(),
    deadline: z.object({
      kind: z.enum(["block", "timestamp", "none"]),
      value: decimalStringSchema.nullable(),
    }),
    reason: z.string().nullable(),
    calldata: hexSchema,
    // Every execution-critical field of the intent, so an adapter can re-verify
    // a provider's account of the transaction after a process restart -- when
    // the ValidatedExecutionIntent itself is long gone.
    value: decimalStringSchema,
    operation: z.literal("CALL"),
  }),
});

/**
 * The idempotency key.
 *
 * intentHash + mode + actor, exactly as the architecture requires. The intent
 * hash already covers the DAO, proposal, support and calldata, so this is
 * "this governance action, through this provider, from this address". The same
 * action through a different mode is a genuinely different attempt and gets its
 * own key.
 */
function executionKey({ intentHash, mode, actor }) {
  return `${getExecutionMode(mode).mode}:${getAddress(actor).toLowerCase()}:${intentHash}`;
}

function createExecutionRecord(validated, options) {
  const mode = getExecutionMode(options.mode).mode;
  const intent = validated.intent;
  const at = new Date(options.now || Date.now()).toISOString();
  const key = executionKey({ intentHash: validated.intentHash, mode, actor: intent.actor });
  const attempt = Number(options.attempt || 1);
  return executionRecordSchema.parse({
    version: 1,
    id: `${key}#${attempt}`,
    key,
    intentHash: validated.intentHash,
    voteIntentHash: intent.source.voteIntentHash,
    mode,
    actor: intent.actor,
    dao: intent.source.dao,
    proposalId: intent.source.proposalId,
    support: intent.source.support,
    chainId: intent.chainId,
    target: intent.target,
    selector: validated.validation.selector,
    state: ExecutionState.VALIDATED,
    attempt,
    createdAt: at,
    updatedAt: at,
    providerData: {},
    history: [{ state: ExecutionState.VALIDATED, at, detail: validated.validation.proposalState }],
    audit: {
      adapterVersion: validated.validation.adapterVersion,
      validatedAt: validated.validation.validatedAt,
      proposalState: validated.validation.proposalState,
      governanceTarget: validated.validation.governanceTarget,
      autonomyAllowed: validated.validation.autonomyAllowed,
      deadline: validated.validation.deadline,
      reason: intent.source.reason,
      calldata: intent.data,
      value: intent.value,
      operation: intent.operation,
    },
  });
}

/**
 * Advance a record. The transition is checked, so a provider cannot walk a
 * record backwards and the history stays a true account of what happened.
 */
function advanceExecutionRecord(record, next, options = {}) {
  const state = assertTransition(record.state, next.state ?? next);
  const at = new Date(options.now || Date.now()).toISOString();
  const detail = next.detail ?? null;
  const providerData = { ...record.providerData, ...(next.providerData || {}) };
  const history =
    record.state === state && (record.history.at(-1)?.detail ?? null) === detail
      ? record.history
      : [...record.history, { state, at, detail }];
  return executionRecordSchema.parse({ ...record, state, updatedAt: at, providerData, history });
}

function isActiveRecord(record) {
  return isActiveExecutionState(record.state);
}

function isSuccessfulRecord(record) {
  return isSuccessfulExecutionState(record.state);
}

async function withMemoryLocks(lockMap, keys, callback) {
  const releases = [];
  try {
    for (const key of [...new Set(keys.map(String))].sort()) {
      const previous = lockMap.get(key) || Promise.resolve();
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      lockMap.set(key, current);
      await previous;
      releases.push(() => {
        if (lockMap.get(key) === current) lockMap.delete(key);
        release();
      });
    }
    return await callback();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/**
 * An in-memory record store.
 *
 * The interface is the contract that matters: `get` by idempotency key,
 * `listByIntentHash` for retry and mode-switch decisions, and
 * `listByProposal` for the replay rule, which has to see attempts under *other*
 * intent hashes (a different reason or support on the same proposal is a
 * different intent but the same governance act).
 */
class InMemoryExecutionRecordStore {
  #byId = new Map();
  #locks = new Map();

  async withLocks(keys, callback) {
    return withMemoryLocks(this.#locks, keys, callback);
  }

  async get(key) {
    const records = [...this.#byId.values()].filter((record) => record.key === key);
    if (records.length === 0) return null;
    return records.sort((left, right) => right.attempt - left.attempt)[0];
  }

  async getById(id) {
    return this.#byId.get(id) || null;
  }

  async put(record) {
    const parsed = executionRecordSchema.parse(record);
    this.#byId.set(parsed.id, parsed);
    return parsed;
  }

  async listByKey(key) {
    return [...this.#byId.values()].filter((record) => record.key === key);
  }

  async listByIntentHash(intentHash) {
    return [...this.#byId.values()].filter((record) => record.intentHash === intentHash);
  }

  async listByProposal({ dao, proposalId, actor }) {
    const normalizedActor = actor ? getAddress(actor) : null;
    return [...this.#byId.values()].filter(
      (record) =>
        record.dao === dao &&
        record.proposalId === String(proposalId) &&
        (!normalizedActor || getAddress(record.actor) === normalizedActor),
    );
  }

  async list() {
    return [...this.#byId.values()];
  }
}

/**
 * A durable, file-backed record store.
 *
 * One JSON file per record under `<root>/<mode>/<intentHash>/<attempt>.json`,
 * written at mode 0600. Deduplication has to survive a process restart: an
 * in-memory store loses it, and the failure mode of losing it is a duplicate
 * governance action rather than an error.
 *
 * Writes are atomic per record (write to a temporary file, then rename), so a
 * crash mid-write leaves the previous record rather than a truncated one. Lock
 * directories coordinate cooperating Linux processes sharing this store on one
 * reliable local filesystem; Linux `/proc` fingerprints prevent PID-reuse
 * reclamation mistakes. NFS and multi-host coordination are not supported.
 */
class FileExecutionRecordStore {
  #locks = new Map();
  #processStartReader;

  constructor(root, options = {}) {
    if (!root) throw new TypeError("A record store root directory is required");
    this.root = path.resolve(root);
    this.#processStartReader = options.processStartReader || null;
    this.lockTimeoutMs = Number(options.lockTimeoutMs ?? 10_000);
    if (!Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs <= 0) {
      throw new TypeError("lockTimeoutMs must be a positive number");
    }
  }

  async #processStart(pid) {
    if (this.#processStartReader) return this.#processStartReader(pid);
    try {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] || null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async #ownerIsDead(owner) {
    if (!owner || owner.hostname !== os.hostname() || !Number.isSafeInteger(owner.pid) || !owner.processStart) {
      return false;
    }
    const currentStart = await this.#processStart(owner.pid);
    return currentStart === null || currentStart !== owner.processStart;
  }

  async #restoreIsolatedLock(quarantine, destination) {
    try {
      await fs.rename(quarantine, destination);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error.code)) {
        throw new Error("Execution lock ownership changed while isolated; refusing to delete either lock");
      }
      if (error.code !== "ENOENT") throw error;
    }
  }

  async #acquireFileLock(key) {
    const lockRoot = path.join(this.root, ".locks");
    await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const digest = crypto.createHash("sha256").update(key).digest("hex");
    const destination = path.join(lockRoot, digest);
    const token = crypto.randomBytes(16).toString("hex");
    const processStart = await this.#processStart(process.pid);
    if (!processStart) {
      throw new Error(
        "FileExecutionRecordStore process locking requires Linux /proc on a shared local filesystem",
      );
    }
    const owner = {
      hostname: os.hostname(),
      pid: process.pid,
      processStart,
      token,
    };
    const started = Date.now();
    let backoff = 5;

    while (true) {
      const candidate = path.join(lockRoot, `.candidate-${digest}-${token}`);
      try {
        await fs.mkdir(candidate, { mode: 0o700 });
        await fs.writeFile(path.join(candidate, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
        await fs.rename(candidate, destination);
        return async () => {
          const quarantine = `${destination}.release-${token}`;
          try {
            // Isolate first, then inspect the exact directory moved. Checking
            // destination before rename has an ABA window that can delete a
            // successor lock installed at the same pathname.
            await fs.rename(destination, quarantine);
          } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
          }
          let current;
          try {
            current = JSON.parse(await fs.readFile(path.join(quarantine, "owner.json"), "utf8"));
          } catch (error) {
            await this.#restoreIsolatedLock(quarantine, destination);
            if (error.code === "ENOENT") return;
            throw error;
          }
          if (current.token !== token) {
            await this.#restoreIsolatedLock(quarantine, destination);
            return;
          }
          await fs.rm(quarantine, { recursive: true, force: true });
        };
      } catch (error) {
        await fs.rm(candidate, { recursive: true, force: true });
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }

      const quarantine = `${destination}.stale-${token}`;
      try {
        // As with release, isolate the exact directory before trusting its
        // metadata. A pre-rename check could act on an ABA successor.
        await fs.rename(destination, quarantine);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      try {
        const current = JSON.parse(await fs.readFile(path.join(quarantine, "owner.json"), "utf8"));
        if (await this.#ownerIsDead(current)) {
          await fs.rm(quarantine, { recursive: true, force: true });
          continue;
        }
        await this.#restoreIsolatedLock(quarantine, destination);
      } catch (error) {
        // Malformed ownership is not evidence of death. Restore it rather than
        // stealing by age or deleting an identity we could not verify.
        try {
          await this.#restoreIsolatedLock(quarantine, destination);
        } catch (restoreError) {
          throw restoreError;
        }
        if (error.code !== "ENOENT" && !error.message?.includes("JSON")) throw error;
      }

      if (Date.now() - started >= this.lockTimeoutMs) {
        throw new Error(`Timed out acquiring execution lock for ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(backoff * 2, 100);
    }
  }

  async withLocks(keys, callback) {
    return withMemoryLocks(this.#locks, keys, async () => {
      const releases = [];
      try {
        for (const key of [...new Set(keys.map(String))].sort()) {
          releases.push(await this.#acquireFileLock(key));
        }
        return await callback();
      } finally {
        for (const release of releases.reverse()) await release();
      }
    });
  }

  #pathFor(record) {
    return path.join(this.root, record.mode, record.intentHash.slice(2), `${record.attempt}.json`);
  }

  async #all() {
    const records = [];
    const walk = async (directory) => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (directory === this.root && entry.name === ".locks") continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.name.endsWith(".json")) {
          records.push(executionRecordSchema.parse(JSON.parse(await fs.readFile(target, "utf8"))));
        }
      }
    };
    await walk(this.root);
    return records;
  }

  async put(record) {
    const parsed = executionRecordSchema.parse(record);
    const destination = this.#pathFor(parsed);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, destination);
    return parsed;
  }

  async getById(id) {
    return (await this.#all()).find((record) => record.id === id) || null;
  }

  async get(key) {
    const records = (await this.#all()).filter((record) => record.key === key);
    return records.sort((left, right) => right.attempt - left.attempt)[0] || null;
  }

  async listByKey(key) {
    return (await this.#all()).filter((record) => record.key === key);
  }

  async listByIntentHash(intentHash) {
    return (await this.#all()).filter((record) => record.intentHash === intentHash);
  }

  async listByProposal({ dao, proposalId, actor }) {
    const normalizedActor = actor ? getAddress(actor) : null;
    return (await this.#all()).filter(
      (record) =>
        record.dao === dao &&
        record.proposalId === String(proposalId) &&
        (!normalizedActor || getAddress(record.actor) === normalizedActor),
    );
  }

  async list() {
    return this.#all();
  }
}

module.exports = {
  FileExecutionRecordStore,
  InMemoryExecutionRecordStore,
  advanceExecutionRecord,
  createExecutionRecord,
  executionKey,
  executionRecordSchema,
  isActiveRecord,
  isSuccessfulRecord,
  providerDataSchema,
};
