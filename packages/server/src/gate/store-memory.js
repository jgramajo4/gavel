const crypto = require("node:crypto");
const { NOUNS_LIFECYCLE_MAPPING_VERSION } = require("@gavel/gate");
const {
  DEFAULT_NOTIFICATION_RETRY_LIMIT,
  INBOX_LIFECYCLES,
  NOUNS_DAO_CHAIN_ID,
  NOUNS_ISSUANCE_STAGE,
  QUOTE_SETTLED_EVENT_FIELDS,
  SETTLED_CAPACITY_WINDOW_MS,
  assertExactKeys,
  notificationTransition,
  normalizeCapacityPolicy,
  publicState,
  publicSubmissionProjection,
  requireNounsIssuanceLifecycle,
} = require("./semantic-contract");
const {
  assertSignerDeploymentBinding,
  assertStoreOwnedQuoteMaterial,
  buildIssuedQuoteMessage,
  issuedQuotePayload,
  quoteExpiryFrom,
  signIssuedQuote,
} = require("./quote-issuance");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DAO_SLUG = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,62}$/;
const UINT78 = /^\d{1,78}$/;
const AVAILABILITIES = new Set(["accepting_now", "paused", "closed"]);
const QUOTE_STATES = new Set(["quoted", "expired", "settled"]);
const RESERVATION_STATES = new Set(["active", "expiry_pending_reconciliation", "released", "consumed"]);
const INBOX_LIFECYCLE_SET = new Set(INBOX_LIFECYCLES);
const PUBLIC_ID_ATTEMPTS = 5;
const PROFILE_PAGE_LIMIT = 50;
const PROFILE_MAX_OFFSET = 10_000;
const PRODUCTION_BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function clone(value) { return value == null ? value : structuredClone(value); }
function publicDisplay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("display must be an object");
  const fields = Object.keys(value);
  if (fields.some((field) => !["ens", "message"].includes(field))) throw new TypeError("display contains a non-public field");
  for (const field of fields) {
    if (typeof value[field] !== "string" && value[field] !== null) throw new TypeError(`display.${field} must be a string or null`);
  }
  return value;
}
function address(value, name) {
  const raw = String(value ?? "");
  if (!ADDRESS.test(raw)) throw new TypeError(`${name} must be an exact 20-byte Ethereum address`);
  return raw.toLowerCase();
}
function bytes32(value, name) {
  const raw = String(value ?? "");
  if (!BYTES32.test(raw)) throw new TypeError(`${name} must be bytes32`);
  return raw.toLowerCase();
}
function daoSlug(value) {
  const raw = String(value ?? "");
  if (raw !== raw.toLowerCase() || !DAO_SLUG.test(raw)) throw new TypeError("dao must be a stable lowercase DAO slug");
  return raw;
}
function uint78(value, name) {
  const raw = String(value ?? "");
  if (!UINT78.test(raw)) throw new TypeError(`${name} must be numeric(78,0)`);
  return raw;
}
function block(value, name) {
  const raw = uint78(value, name);
  return { raw, number: BigInt(raw) };
}
function instant(value, name) {
  const result = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return result;
}
function compareShape(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  });
}
function validDeploymentEnvironment(deployment) {
  const environment = deployment.config?.environment;
  const label = deployment.config?.testTokenLabel;
  if (environment === "production") {
    return deployment.chainId === "8453" && deployment.token === PRODUCTION_BASE_USDC
      && !Object.hasOwn(deployment.config, "testTokenLabel");
  }
  return environment === "test" && deployment.chainId === "84532"
    && typeof label === "string" && label.trim() !== "";
}
class MemoryGateStore {
  #randomBytes;
  #clock;
  #beforeSettlementCommit;
  #publicIds;
  #profiles;
  #policies;
  #profileLocks;
  #operationLock;
  #deployments;
  #settlementCursors;
  #scannerRanges;
  #snapshots;
  #submissions;
  #submissionHashes;
  #quotes;
  #quoteIds;
  #reservations;
  #inboxItems;
  #notifications;
  #deliverySettings;
  #monitors;
  #authNonces;
  #authSessions;
  #notificationRetryLimit;

  constructor(options = {}) {
    this.#randomBytes = options.randomBytes || crypto.randomBytes;
    this.#clock = options.clock || (() => new Date());
    this.#beforeSettlementCommit = options.beforeSettlementCommit || (() => {});
    this.#notificationRetryLimit = options.notificationRetryLimit ?? DEFAULT_NOTIFICATION_RETRY_LIMIT;
    if (!Number.isInteger(this.#notificationRetryLimit) || this.#notificationRetryLimit < 0) {
      throw new TypeError("notificationRetryLimit must be a nonnegative integer");
    }
    this.#publicIds = new Set();
    this.#profiles = new Map();
    this.#policies = new Map();
    this.#profileLocks = new Map();
    this.#operationLock = Promise.resolve();
    this.#deployments = new Map();
    this.#settlementCursors = new Map();
    this.#scannerRanges = new Map();
    this.#snapshots = new Map();
    this.#submissions = new Map();
    this.#submissionHashes = new Set();
    this.#quotes = new Map();
    this.#quoteIds = new Set();
    this.#reservations = new Map();
    this.#inboxItems = new Map();
    this.#notifications = new Map();
    this.#deliverySettings = new Map();
    this.#monitors = new Map();
    this.#authNonces = new Map();
    this.#authSessions = new Map();
  }

  #allocatePublicIdUnsafe() {
    for (let attempt = 0; attempt < PUBLIC_ID_ATTEMPTS; attempt += 1) {
      const value = this.#randomBytes(16);
      if (!Buffer.isBuffer(value) || value.length !== 16) throw new TypeError("randomBytes must return exactly 16 bytes");
      const publicId = value.toString("base64url");
      if (this.#publicIds.has(publicId)) continue;
      this.#publicIds.add(publicId);
      return publicId;
    }
    throw new Error("public id allocation unavailable");
  }

  async allocatePublicId() { return this.#serialized(() => this.#allocatePublicIdUnsafe()); }

  async #withProfileLock(id, callback) {
    const prior = this.#profileLocks.get(id) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.#profileLocks.set(id, current);
    await prior;
    try { return await callback(); }
    finally {
      release();
      if (this.#profileLocks.get(id) === current) this.#profileLocks.delete(id);
    }
  }

  async #serialized(callback) {
    const prior = this.#operationLock;
    let release;
    this.#operationLock = new Promise((resolve) => { release = resolve; });
    await prior;
    try { return await callback(); } finally { release(); }
  }

  async #mutateProfileUnsafe({ profile, policy }) {
    if (!profile?.id || !profile.wallet) throw new TypeError("profile id and wallet are required");
    const wallet = address(profile.wallet, "wallet");
    const suppliedWalletKind = profile.walletKind;
    if (suppliedWalletKind !== undefined && !["eoa", "contract"].includes(suppliedWalletKind)) {
      throw new TypeError("invalid wallet kind");
    }
    const basePayoutCodeHash = profile.basePayoutCodeHash == null
      ? profile.basePayoutCodeHash
      : bytes32(profile.basePayoutCodeHash, "basePayoutCodeHash");
    const basePayoutVerifiedAt = profile.basePayoutVerifiedAt == null
      ? profile.basePayoutVerifiedAt
      : instant(profile.basePayoutVerifiedAt, "basePayoutVerifiedAt");
    if (profile.display !== undefined) publicDisplay(profile.display);
    if (profile.availability !== undefined && !AVAILABILITIES.has(profile.availability)) throw new TypeError("invalid availability");
    let normalizedPolicy;
    if (policy) {
      const dao = daoSlug(policy.dao);
      const attentionAmount = uint78(policy.attentionAmount, "attentionAmount");
      const { pendingReservationCapacity, settledCapacity } = normalizeCapacityPolicy(policy);
      const chainId = block(policy.chainId, "chainId");
      if (chainId.number < 1n) throw new TypeError("chainId must be positive");
      if (BigInt(attentionAmount) < 1_000_000n) throw new TypeError("attentionAmount must be at least 1000000");
      if (typeof policy.enabled !== "boolean") throw new TypeError("policy enabled must be boolean");
      if (typeof policy.acceptPreVote !== "boolean" || typeof policy.acceptVoting !== "boolean") throw new TypeError("policy lifecycle flags must be boolean");
      if (dao !== "nouns" || chainId.raw !== NOUNS_DAO_CHAIN_ID || policy.acceptPreVote !== false
          || policy.acceptVoting !== true) {
        throw new TypeError("MVP policy must be Nouns chain 1 with PRE_VOTE disabled and VOTING enabled");
      }
      if (!Array.isArray(policy.tags ?? [])) throw new TypeError("policy tags must be an array");
      normalizedPolicy = {
        ...clone(policy), profileId: profile.id, dao, chainId: chainId.raw, attentionAmount,
        pendingReservationCapacity, settledCapacity, tags: clone(policy.tags ?? []),
      };
    }
    {
      const existing = this.#profiles.get(profile.id);
      if (existing && existing.wallet !== wallet) throw new Error("profile wallet is immutable");
      const walletKind = suppliedWalletKind ?? existing?.walletKind ?? "eoa";
      const collision = [...this.#profiles.values()].find((row) => row.wallet === wallet && row.id !== profile.id);
      if (collision) throw new Error("wallet already enrolled");
      const availability = profile.availability ?? existing?.availability ?? "paused";
      if (walletKind === "contract" && availability === "accepting_now" && existing?.availability !== "accepting_now"
          && (basePayoutCodeHash == null || basePayoutVerifiedAt == null)) {
        throw new Error("contract voter requires fresh Base payout evidence before accepting");
      }
      const now = instant(this.#clock(), "clock");
      const row = {
        ...clone(existing), id: profile.id, wallet, walletKind, availability,
        display: clone(profile.display ?? existing?.display ?? {}),
        profileVersion: existing?.profileVersion ?? 1,
        enrolledAt: clone(existing?.enrolledAt ?? now), updatedAt: now,
        basePayoutVerifiedAt: basePayoutVerifiedAt ?? existing?.basePayoutVerifiedAt ?? null,
        basePayoutCodeHash: basePayoutCodeHash ?? existing?.basePayoutCodeHash ?? null,
      };
      const priorPolicy = normalizedPolicy && this.#policies.get(`${profile.id}:${normalizedPolicy.dao}`);
      const profileChanged = !existing || compareShape({ wallet: existing.wallet, walletKind: existing.walletKind,
        availability: existing.availability, display: existing.display, basePayoutVerifiedAt: existing.basePayoutVerifiedAt,
        basePayoutCodeHash: existing.basePayoutCodeHash }) !== compareShape({ wallet: row.wallet, walletKind: row.walletKind,
        availability: row.availability, display: row.display, basePayoutVerifiedAt: row.basePayoutVerifiedAt,
        basePayoutCodeHash: row.basePayoutCodeHash });
      const policyChanged = normalizedPolicy && compareShape(priorPolicy) !== compareShape(normalizedPolicy);
      if (existing && (profileChanged || policyChanged)) row.profileVersion += 1;
      if (existing && !profileChanged && !policyChanged) row.updatedAt = clone(existing.updatedAt);
      if (normalizedPolicy) this.#policies.set(`${profile.id}:${normalizedPolicy.dao}`, clone(normalizedPolicy));
      this.#profiles.set(profile.id, row);
      return clone(row);
    }
  }

  async mutateProfile(input) {
    const profileId = input?.profile?.id;
    if (!profileId) return this.#mutateProfileUnsafe(input);
    return this.#serialized(() => this.#withProfileLock(profileId, () => this.#mutateProfileUnsafe(input)));
  }

  async insertNonce(row) {
    return this.#serialized(() => {
      if (!row?.nonceHash) throw new TypeError("nonceHash is required");
      if (this.#authNonces.has(row.nonceHash)) throw new Error("nonce collision");
      this.#authNonces.set(row.nonceHash, clone(row));
    });
  }

  async getNonceByHash(nonceHash) { return clone(this.#authNonces.get(nonceHash) ?? null); }
  async getSessionByTokenHash(tokenHash) { return clone(this.#authSessions.get(tokenHash) ?? null); }

  #authTransactionView() {
    return {
      getNonceByHash: async (nonceHash) => clone(this.#authNonces.get(nonceHash) ?? null),
      consumeNonce: async (nonceHash, consumedAt) => {
        const row = this.#authNonces.get(nonceHash);
        if (!row || row.consumedAt !== null) throw new Error("authentication proof unavailable");
        row.consumedAt = String(consumedAt);
      },
      insertSession: async (row) => {
        if (!row?.tokenHash) throw new TypeError("tokenHash is required");
        if (this.#authSessions.has(row.tokenHash)) throw new Error("session collision");
        this.#authSessions.set(row.tokenHash, clone(row));
      },
    };
  }

  async transaction(callback) {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return this.#serialized(async () => {
      const nonces = structuredClone(this.#authNonces);
      const sessions = structuredClone(this.#authSessions);
      try { return await callback(Object.freeze(this.#authTransactionView())); }
      catch (error) {
        this.#authNonces = nonces;
        this.#authSessions = sessions;
        throw error;
      }
    });
  }

  async withProfileTransaction(wallet, callback) {
    const canonicalWallet = address(wallet, "wallet");
    if (typeof callback !== "function") throw new TypeError("profile transaction callback is required");
    return this.#serialized(() => {
      const lockId = [...this.#profiles.values()].find((row) => row.wallet === canonicalWallet)?.id ?? canonicalWallet;
      return this.#withProfileLock(lockId, async () => {
        const profiles = structuredClone(this.#profiles);
        const policies = structuredClone(this.#policies);
        const nonces = structuredClone(this.#authNonces);
        const deliverySettings = structuredClone(this.#deliverySettings);
        try {
          const auth = this.#authTransactionView();
          const transaction = Object.freeze({
            getNonceByHash: auth.getNonceByHash,
            consumeNonce: auth.consumeNonce,
            getProfileByWallet: async (value) => this.#getProfileByWallet(value),
            mutateProfile: async (input) => {
              if (address(input?.profile?.wallet, "profile wallet") !== canonicalWallet) {
                throw new Error("profile transaction wallet mismatch");
              }
              return this.#mutateProfileUnsafe(input);
            },
            setDeliverySetting: async (profileId, ciphertext) => {
              const profile = this.#profiles.get(profileId);
              if (!profile || profile.wallet !== canonicalWallet) throw new Error("delivery setting profile mismatch");
              if (typeof ciphertext !== "string" || ciphertext.length > 1024
                  || !/^gg1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ciphertext)) {
                throw new TypeError("delivery setting must be a canonical encrypted envelope");
              }
              this.#deliverySettings.set(profileId, ciphertext);
            },
          });
          return await callback(transaction);
        } catch (error) {
          this.#profiles = profiles;
          this.#policies = policies;
          this.#authNonces = nonces;
          this.#deliverySettings = deliverySettings;
          throw error;
        }
      });
    });
  }

  #getProfileByWallet(wallet) {
    const canonicalWallet = address(wallet, "wallet");
    return clone([...this.#profiles.values()].find((row) => row.wallet === canonicalWallet) ?? null);
  }

  async getProfileByWallet(wallet) { return this.#getProfileByWallet(wallet); }

  async listProfiles({ dao, availability, limit = PROFILE_PAGE_LIMIT, offset = 0 } = {}) {
    const normalizedDao = dao === undefined ? undefined : daoSlug(dao);
    if (availability !== undefined && !AVAILABILITIES.has(availability)) throw new TypeError("invalid availability");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROFILE_PAGE_LIMIT) throw new TypeError("profile limit must be an integer from 1 to 50");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > PROFILE_MAX_OFFSET) throw new TypeError("profile offset must be an integer from 0 to 10000");
    return [...this.#profiles.values()]
      .filter((profile) => availability === undefined || profile.availability === availability)
      .filter((profile) => normalizedDao === undefined || this.#policies.has(`${profile.id}:${normalizedDao}`))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || left.id.localeCompare(right.id))
      .slice(offset, offset + limit)
      .map(clone);
  }

  async getProfile(id) { return clone(this.#profiles.get(id) ?? null); }
  async getPolicy(profileId, dao) { return clone(this.#policies.get(`${profileId}:${daoSlug(dao)}`) ?? null); }

  async isProfileAccepting(profileId, dao) {
    const policy = this.#policies.get(`${profileId}:${daoSlug(dao)}`);
    if (!policy) return false;
    const settledWindowStart = instant(this.#clock(), "clock").getTime() - SETTLED_CAPACITY_WINDOW_MS;
    let pending = 0;
    let settled = 0;
    for (const reservation of this.#reservations.values()) {
      if (reservation.profileId !== profileId) continue;
      if (["active", "expiry_pending_reconciliation"].includes(reservation.state)) pending += 1;
      if (reservation.state === "consumed" && reservation.consumedAt?.getTime() > settledWindowStart) settled += 1;
    }
    return pending < policy.pendingReservationCapacity && settled < policy.settledCapacity;
  }

  // Owner-bound global exact-hash lookup. It runs before every mutable check,
  // so it consults nothing but the immutable submission row.
  async getOwnedSubmissionByHash({ submissionHash, payer } = {}) {
    const hash = bytes32(submissionHash, "submissionHash");
    const owner = address(payer, "payer");
    const submission = [...this.#submissions.values()].find((row) => row.submissionHash === hash);
    if (!submission) return null;
    if (submission.payer !== owner) throw new Error("submission is unavailable");
    return { publicId: submission.publicId, state: publicState(submission.status) };
  }

  // Private owner-bound resume. It is read-only: it never refreshes a quote,
  // extends an expiry, or touches a reservation.
  async getOwnedResume({ publicId, payer } = {}) {
    const owner = address(payer, "payer");
    const submission = [...this.#submissions.values()].find((row) => row.publicId === publicId);
    if (!submission || submission.payer !== owner) return null;
    const inbox = [...this.#inboxItems.values()].find((row) => row.submissionId === submission.id);
    const projection = clone(publicSubmissionProjection(submission, inbox));
    const quote = [...this.#quotes.values()].find((row) => row.submissionId === submission.id);
    if (!quote || submission.status !== "QUOTED") return projection;
    // Wall-clock expiry disables payment even before the expiry sweep runs.
    if (quote.state !== "quoted" || quote.expiresAt <= instant(this.#clock(), "clock")) {
      return { publicId: submission.publicId, state: "expired", updatedAt: clone(submission.publicStateChangedAt) };
    }
    return {
      ...projection,
      quote: issuedQuotePayload({
        domain: { chainId: quote.baseChainId, verifyingContract: quote.splitter },
        message: buildIssuedQuoteMessage({
          quoteId: quote.quoteId, payer: quote.payer, voter: quote.voter, attentionAmount: quote.attentionAmount,
          feeAmount: quote.feeAmount, submissionHash: submission.submissionHash, token: quote.token,
          expiresAt: quote.expiresAt,
        }),
        signature: quote.signature,
      }),
    };
  }

  async getSubmission(publicId) {
    const submission = [...this.#submissions.values()].find((row) => row.publicId === publicId);
    if (!submission) return null;
    const inbox = [...this.#inboxItems.values()].find((row) => row.submissionId === submission.id);
    return clone(publicSubmissionProjection(submission, inbox));
  }

  async configureDeployment(deployment) {
    if (!deployment?.id) throw new TypeError("deployment id is required");
    const chainId = block(deployment.chainId, "chainId");
    const deploymentBlock = block(deployment.deploymentBlock, "deploymentBlock");
    const nextBlock = block(deployment.nextBlock, "nextBlock");
    if (chainId.number < 1n || nextBlock.number < deploymentBlock.number) throw new TypeError("invalid deployment cursor");
    const normalized = {
      ...clone(deployment), chainId: chainId.raw, splitter: address(deployment.splitter, "splitter"),
      signer: address(deployment.signer, "signer"), token: address(deployment.token, "token"),
      gavelRecipient: address(deployment.gavelRecipient, "gavelRecipient"),
      contractCodeHash: bytes32(deployment.contractCodeHash, "contractCodeHash"),
      deploymentBlock: deploymentBlock.raw, nextBlock: deploymentBlock.raw, issuanceActive: deployment.issuanceActive === true,
      config: { ...clone(deployment.config ?? {}), overlap: Number(deployment.config?.overlap ?? 64) },
      rpcAccess: clone(deployment.rpcAccess ?? {}),
    };
    if (!Number.isSafeInteger(normalized.config.overlap) || normalized.config.overlap < 1) {
      throw new TypeError("deployment.config.overlap must be a positive integer");
    }
    if (!validDeploymentEnvironment(normalized)) {
      throw new TypeError("deployment environment is not valid for its chain and token");
    }
    return this.#serialized(() => {
      const existing = this.#deployments.get(normalized.id);
      if (existing) {
        for (const field of ["chainId", "splitter", "signer", "token", "gavelRecipient", "deploymentBlock", "contractCodeHash"]) {
          if (existing[field] !== normalized[field]) throw new Error("immutable deployment identity mismatch");
        }
        if (existing.config.environment !== normalized.config.environment
            || existing.config.testTokenLabel !== normalized.config.testTokenLabel) {
          throw new Error("immutable deployment identity mismatch");
        }
      }
      const duplicateMaterial = [...this.#deployments.values()].find((row) =>
        row.id !== normalized.id && row.chainId === normalized.chainId && row.splitter === normalized.splitter);
      if (duplicateMaterial) throw new Error("deployment chain and splitter already configured");
      if (normalized.issuanceActive) {
        const active = [...this.#deployments.values()].find((row) =>
          row.id !== normalized.id && row.chainId === normalized.chainId && row.issuanceActive);
        if (active) throw new Error("at most one active deployment is allowed per chain");
      }
      this.#deployments.set(normalized.id, clone(normalized));
      const cursorKey = `${normalized.chainId}:${normalized.splitter}`;
      const priorCursor = this.#settlementCursors.get(cursorKey);
      if (!priorCursor) {
        this.#settlementCursors.set(cursorKey, {
          deploymentId: normalized.id, chainId: normalized.chainId, splitter: normalized.splitter,
          deploymentBlock: normalized.deploymentBlock, nextRangeFrom: normalized.deploymentBlock,
          checkpointBlock: null, canonicalBlockHash: null, reconciliationMetadata: {}, updatedAt: instant(this.#clock(), "clock"),
        });
      }
      return clone(normalized);
    });
  }

  async getDeployment({ chainId, splitter } = {}) {
    const expectedChain = block(chainId, "chainId").raw;
    const expectedSplitter = address(splitter, "splitter");
    return clone([...this.#deployments.values()].find((row) =>
      row.chainId === expectedChain && row.splitter === expectedSplitter) ?? null);
  }

  async getScannerState({ chainId, splitter } = {}) {
    const key = `${block(chainId, "chainId").raw}:${address(splitter, "splitter")}`;
    const cursor = this.#settlementCursors.get(key);
    if (!cursor) return null;
    const deployment = this.#deployments.get(cursor.deploymentId);
    return clone({ deploymentId: cursor.deploymentId, deploymentBlock: cursor.deploymentBlock,
      nextRangeFrom: cursor.nextRangeFrom, generation: cursor.scanGeneration ?? "0", overlap: deployment.config.overlap });
  }

  async claimSettlementLifecycle({ quoteId, staleAfterMs = 15_000 } = {}) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1 || staleAfterMs > 60_000) {
      throw new TypeError("staleAfterMs must be from 1 to 60000");
    }
    return this.#serialized(() => {
      const entry = this.#quoteEntry(publicQuoteId);
      if (!entry || entry[1].state === "settled") return null;
      const quote = entry[1];
      const now = instant(this.#clock(), "clock");
      if (!quote.lifecycleRecheckAttemptedAt) {
        quote.lifecycleRecheckAttemptedAt = now;
        return { attempt: true, pending: false, lifecycle: null };
      }
      return { attempt: false,
        pending: !quote.lifecycleRecheck && quote.lifecycleRecheckAttemptedAt.valueOf() > now.valueOf() - staleAfterMs,
        lifecycle: clone(quote.lifecycleRecheck ?? null) };
    });
  }

  async recordSettlementLifecycle({ quoteId, lifecycle } = {}) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    if (!lifecycle || typeof lifecycle !== "object" || Array.isArray(lifecycle)) throw new TypeError("lifecycle is required");
    return this.#serialized(() => {
      const entry = this.#quoteEntry(publicQuoteId);
      if (!entry || entry[1].state === "settled" || !entry[1].lifecycleRecheckAttemptedAt || entry[1].lifecycleRecheck) return false;
      entry[1].lifecycleRecheck = clone(lifecycle);
      return true;
    });
  }

  async listUnsettledSettlementObservations({ chainId, splitter, limit = 50 } = {}) {
    const settlementChain = block(chainId, "chainId").raw;
    const settlementSplitter = address(splitter, "splitter");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    const deployment = [...this.#deployments.values()].find((row) =>
      row.chainId === settlementChain && row.splitter === settlementSplitter);
    if (!deployment) return [];
    const ranges = [...this.#scannerRanges.values()].filter((range) => range.deploymentId === deployment.id);
    const latestByBlock = new Map();
    for (const range of ranges) for (const item of range.canonicalBlocks) {
      const prior = latestByBlock.get(item.blockNumber);
      if (!prior || BigInt(range.generation) > BigInt(prior)) latestByBlock.set(item.blockNumber, range.generation);
    }
    const result = [];
    for (const range of ranges) for (const observation of range.observations) {
      if (!observation.exactMatch || latestByBlock.get(observation.blockNumber) !== range.generation
          || !observation.details?.settlement) continue;
      const quote = this.#quoteEntry(observation.quoteId)?.[1];
      if (quote && quote.state !== "settled") result.push({ quoteId: observation.quoteId,
        settlement: observation.details.settlement });
    }
    return clone(result.slice(0, limit));
  }

  async recordScannerRange(range) {
    if (!range?.deploymentId) throw new TypeError("deploymentId is required");
    const deployment = this.#deployments.get(range.deploymentId);
    if (!deployment) throw new Error("deployment not found");
    const fromBlock = block(range.fromBlock, "fromBlock");
    const throughBlock = block(range.throughBlock, "throughBlock");
    const generation = block(range.generation, "generation");
    if (generation.number < 1n || throughBlock.number < fromBlock.number) throw new Error("invalid scanner range");
    if (!Array.isArray(range.canonicalBlocks)
        || BigInt(range.canonicalBlocks.length) !== throughBlock.number - fromBlock.number + 1n) {
      throw new Error("canonicalBlocks must cover every block in the scanner range");
    }
    const canonicalBlocks = range.canonicalBlocks.map((item, offset) => {
      const blockNumber = block(item?.blockNumber, "canonicalBlocks.blockNumber");
      if (blockNumber.number !== fromBlock.number + BigInt(offset)) throw new Error("canonicalBlocks must cover every block in order");
      return { blockNumber: blockNumber.raw, blockHash: bytes32(item.blockHash, "canonicalBlocks.blockHash"),
        parentHash: bytes32(item.parentHash, "canonicalBlocks.parentHash"),
        blockTimestamp: instant(item.blockTimestamp, "canonicalBlocks.blockTimestamp") };
    });
    for (let index = 1; index < canonicalBlocks.length; index += 1) {
      if (canonicalBlocks[index].parentHash !== canonicalBlocks[index - 1].blockHash) {
        throw new Error("canonical block parent ancestry is inconsistent");
      }
    }
    const canonicalBlockHash = bytes32(range.canonicalBlockHash, "canonicalBlockHash");
    const canonicalBlockTimestamp = instant(range.canonicalBlockTimestamp, "canonicalBlockTimestamp");
    const checkpoint = canonicalBlocks.at(-1);
    if (checkpoint.blockHash !== canonicalBlockHash || checkpoint.blockTimestamp.valueOf() !== canonicalBlockTimestamp.valueOf()) {
      throw new Error("canonical checkpoint must match the final canonical block");
    }
    if (!Array.isArray(range.observations)) throw new TypeError("observations must be a complete array");
    const observations = clone(range.observations);
    for (const observation of observations) {
      const canonical = canonicalBlocks[Number(BigInt(observation.blockNumber) - fromBlock.number)];
      if (!canonical || bytes32(observation.blockHash, "observation.blockHash") !== canonical.blockHash
          || instant(observation.blockTimestamp, "observation.blockTimestamp").valueOf() !== canonical.blockTimestamp.valueOf()) {
        throw new Error("scanner observation must match its canonical block evidence");
      }
      if (observation.kind === "exact_log" && observation.details?.settlement) {
        observation.details.settlement.settledAt = clone(observation.details.settlement.receiptBlockTimestamp);
      }
    }
    const normalized = clone({ ...range, fromBlock: fromBlock.raw, throughBlock: throughBlock.raw,
      generation: generation.raw, canonicalBlockHash, canonicalBlockTimestamp, canonicalBlocks, observations });
    const key = `${deployment.chainId}:${deployment.splitter}`;
    return this.#serialized(() => {
      const cursor = this.#settlementCursors.get(key);
      if (!cursor) throw new Error("settlement cursor not configured");
      const replayKey = `${deployment.id}:${generation.raw}`;
      const replay = this.#scannerRanges.get(replayKey);
      if (replay) {
        if (compareShape(replay) !== compareShape(normalized)) throw new Error("conflicting scanner generation replay");
        return { released: 0, reorged: 0 };
      }
      if (generation.number !== BigInt(cursor.scanGeneration ?? 0) + 1n) throw new Error("scanner generation is discontinuous");
      if (fromBlock.number > BigInt(cursor.nextRangeFrom)) throw new Error("scanner range is discontinuous");
      if (fromBlock.number > BigInt(cursor.deploymentBlock)) {
        const priorNumber = (fromBlock.number - 1n).toString();
        const prior = [...this.#scannerRanges.values()]
          .filter((stored) => stored.deploymentId === deployment.id)
          .sort((left, right) => BigInt(left.generation) === BigInt(right.generation) ? 0
            : BigInt(left.generation) > BigInt(right.generation) ? -1 : 1)
          .flatMap((stored) => stored.canonicalBlocks)
          .find((stored) => stored.blockNumber === priorNumber);
        if (!prior || canonicalBlocks[0].parentHash !== prior.blockHash) {
          throw new Error("canonical scanner range does not join persisted ancestry");
        }
      }
      this.#scannerRanges.set(replayKey, normalized);
      this.#settlementCursors.set(key, { ...clone(cursor), nextRangeFrom: (throughBlock.number + 1n).toString(),
        checkpointBlock: throughBlock.raw, canonicalBlockHash: normalized.canonicalBlockHash,
        scanGeneration: generation.raw, updatedAt: instant(this.#clock(), "clock") });
      const latestGenerationByBlock = new Map();
      for (const stored of this.#scannerRanges.values()) {
        if (stored.deploymentId !== deployment.id) continue;
        for (const item of stored.canonicalBlocks) {
          const current = latestGenerationByBlock.get(item.blockNumber);
          if (current == null || BigInt(stored.generation) > BigInt(current)) {
            latestGenerationByBlock.set(item.blockNumber, stored.generation);
          }
        }
      }
      let released = 0;
      const releasedAt = instant(this.#clock(), "clock");
      for (const [quoteInternalId, quote] of this.#quotes.entries()) {
        if (quote.deploymentId !== deployment.id || quote.state !== "expired" || quote.expiresAt > canonicalBlockTimestamp) continue;
        const reservation = [...this.#reservations.values()].find((row) => row.quoteId === quote.quoteId);
        if (reservation?.state !== "expiry_pending_reconciliation") continue;
        const hasCurrentPreExpiryMatch = [...this.#scannerRanges.values()].some((stored) => stored.deploymentId === deployment.id
          && stored.observations.some((item) => item.kind === "exact_log" && item.exactMatch === true
            && item.quoteId === quote.quoteId && instant(item.blockTimestamp, "observation.blockTimestamp") < quote.expiresAt
            && latestGenerationByBlock.get(String(item.blockNumber)) === stored.generation));
        if (hasCurrentPreExpiryMatch) continue;
        this.#reservations.set(reservation.id, { ...clone(reservation), state: "released", releasedAt, updatedAt: releasedAt,
          scannerCursor: (throughBlock.number + 1n).toString(), releaseRangeFrom: cursor.deploymentBlock,
          releaseRangeTo: throughBlock.raw, releaseCanonicalBlockHash: canonicalBlockHash });
        this.#quotes.set(quoteInternalId, { ...clone(quote), reservationState: "released" });
        released += 1;
      }
      let reorged = 0;
      for (const [quoteInternalId, quote] of this.#quotes.entries()) {
        if (quote.deploymentId !== deployment.id || quote.state !== "settled"
            || BigInt(quote.receiptBlock) < fromBlock.number || BigInt(quote.receiptBlock) > throughBlock.number) continue;
        const exact = observations.some((item) => item.kind === "exact_log" && item.exactMatch === true
          && item.quoteId === quote.quoteId && item.txHash === quote.txHash && item.logIndex === quote.logIndex
          && String(item.blockNumber) === quote.receiptBlock && item.blockHash === quote.receiptBlockHash
          && instant(item.blockTimestamp, "observation.blockTimestamp").valueOf() === quote.receiptBlockTimestamp.valueOf());
        if (exact) continue;
        const detectedAt = quote.settlementReorgedAt ?? instant(this.#clock(), "clock");
        this.#quotes.set(quoteInternalId, { ...clone(quote), settlementReorgedAt: detectedAt });
        const monitorKey = `${quote.baseChainId}:${quote.splitter}:${quote.quoteId}`;
        const monitor = this.#monitors.get(monitorKey);
        if (monitor) this.#monitors.set(monitorKey, { ...clone(monitor), reconciliationMetadata: {
          ...clone(monitor.reconciliationMetadata || {}), trailingOverlapReorg: { detectedAt, generation: generation.raw,
            receiptBlock: quote.receiptBlock, receiptBlockHash: quote.receiptBlockHash,
            txHash: quote.txHash, logIndex: quote.logIndex },
        } });
        reorged += 1;
      }
      return { released, reorged };
    });
  }

  async issue({ context, snapshot, submission, quote, reservation, signer } = {}) {
    if (!snapshot || !submission || !quote || !reservation) throw new TypeError("complete issuance material is required");
    assertStoreOwnedQuoteMaterial(quote, reservation);
    if (context?.authPassed !== true || context?.parsePassed !== true) {
      throw new TypeError("authenticated and parsed issuance context is required");
    }
    const expectedProfileVersion = block(context.expectedProfileVersion, "expectedProfileVersion");
    if (expectedProfileVersion.number < 1n) throw new TypeError("expectedProfileVersion must be positive");
    if (!["eoa", "contract"].includes(context.walletKind)) throw new TypeError("invalid voter wallet kind");
    if (context.payerIsEoa !== true || (context.payerWalletKind != null && context.payerWalletKind !== "eoa")) {
      throw new Error("MVP requires an EOA payer");
    }
    if (context.stage !== NOUNS_ISSUANCE_STAGE) throw new Error("Nouns quote issuance supports VOTING only");
    const contextCodeHash = context.basePayoutCodeHash == null ? null : bytes32(context.basePayoutCodeHash, "context basePayoutCodeHash");
    const deploymentCodeHash = bytes32(context.deploymentCodeHash, "deploymentCodeHash");
    const normalizedDao = daoSlug(snapshot.dao);
    if (normalizedDao !== "nouns") throw new Error("MVP quote issuance supports Nouns only");
    const proposalId = uint78(snapshot.proposalId, "proposalId");
    const contentHash = bytes32(snapshot.contentHash, "snapshot.contentHash");
    const sourceBlockHash = bytes32(snapshot.sourceBlockHash, "snapshot.sourceBlockHash");
    const submissionHash = bytes32(submission.submissionHash, "submissionHash");
    const publicQuoteId = bytes32(quote.quoteId, "quoteId");
    const payer = address(submission.payer, "payer");
    const signedSender = address(submission.signedSender, "signed_sender");
    const authenticatedSender = address(context.authenticatedSender, "authenticatedSender");
    const quotePayer = address(quote.payer, "quote payer");
    const voter = address(quote.voter, "voter");
    const token = address(quote.token, "token");
    const splitter = address(quote.splitter, "splitter");
    if (payer !== signedSender) throw new Error("payer must equal signed_sender");
    if (payer !== authenticatedSender) throw new Error("payer must equal authenticated signed sender");
    if (quotePayer !== payer) throw new Error("quote payer must equal submission payer");
    const attentionAmount = uint78(quote.attentionAmount, "attentionAmount");
    const feeAmount = uint78(quote.feeAmount, "feeAmount");
    const reservationAmount = uint78(reservation.amount, "reservation amount");
    if (BigInt(attentionAmount) < 1_000_000n) throw new Error("attention amount must be at least 1000000");
    if (feeAmount !== "250000") throw new Error("fee amount must equal 250000");
    if (reservationAmount !== attentionAmount) throw new Error("reservation amount must equal attention amount");
    if (quote.totalAmount !== undefined && BigInt(uint78(quote.totalAmount, "totalAmount")) !== BigInt(attentionAmount) + BigInt(feeAmount)) {
      throw new Error("total amount must equal attention amount plus fee amount");
    }
    if (quote.quoteVersion !== 1) throw new Error("quote version must equal 1");
    requireNounsIssuanceLifecycle(snapshot.nativeState, snapshot.eligibility);
    if (snapshot.mappingVersion !== NOUNS_LIFECYCLE_MAPPING_VERSION) {
      throw new Error(`mapping version must equal ${NOUNS_LIFECYCLE_MAPPING_VERSION}`);
    }
    if (!Array.isArray(snapshot.canonicalActions)) throw new TypeError("canonicalActions must be an array");
    if (submission.status !== undefined && submission.status !== "QUOTED") throw new TypeError("invalid initial submission state");
    if (quote.state !== undefined && (!QUOTE_STATES.has(quote.state) || quote.state !== "quoted")) throw new TypeError("invalid initial quote state");
    if (reservation.state !== undefined && (!RESERVATION_STATES.has(reservation.state) || reservation.state !== "active")) throw new TypeError("invalid initial reservation state");
    if (reservation.profileId !== submission.profileId) throw new Error("reservation profile must equal submission profile");
    if (!signer || typeof signer.signQuote !== "function") {
      throw new TypeError("an injected quote signer is required for issuance");
    }

    return this.#serialized(() => this.#withProfileLock(submission.profileId, async () => {
      const duplicate = [...this.#submissions.values()].find((row) => row.submissionHash === submissionHash);
      if (duplicate) {
        if (duplicate.payer !== payer) throw new Error("submission is unavailable");
        return { resumed: true, publicId: duplicate.publicId, state: publicState(duplicate.status) };
      }
      // The store reads its clock exactly once per issuance and owns the
      // authoritative expiry; no caller-supplied instant participates.
      const issuanceNow = instant(this.#clock(), "clock");
      const authoritativeExpiry = quoteExpiryFrom(issuanceNow);
      const profile = this.#profiles.get(submission.profileId);
      if (!profile) throw new Error("issuance unavailable");
      if (profile.availability !== "accepting_now" || voter !== profile.wallet) throw new Error("issuance unavailable");
      if (String(profile.profileVersion) !== expectedProfileVersion.raw || profile.walletKind !== context.walletKind
          || profile.basePayoutCodeHash !== contextCodeHash) throw new Error("issuance context changed");
      if (profile.walletKind === "contract" && (!profile.basePayoutCodeHash || !profile.basePayoutVerifiedAt)) {
        throw new Error("issuance unavailable");
      }
      const policy = this.#policies.get(`${submission.profileId}:${normalizedDao}`);
      if (!policy?.enabled || policy.chainId !== NOUNS_DAO_CHAIN_ID || !policy.acceptVoting || policy.acceptPreVote) throw new Error("issuance unavailable");
      if (attentionAmount !== policy.attentionAmount) throw new Error("issuance context changed");
      const deployment = this.#deployments.get(quote.deploymentId);
      if (!deployment?.issuanceActive) throw new Error("issuance unavailable");
      if (!validDeploymentEnvironment(deployment)) throw new Error("deployment environment is invalid");
      if (String(quote.baseChainId) !== deployment.chainId || splitter !== deployment.splitter || token !== deployment.token) {
        throw new Error("quote deployment material mismatch");
      }
      if (deployment.contractCodeHash !== deploymentCodeHash) throw new Error("issuance context changed");

      const nowForLimits = issuanceNow;
      const activePair = [...this.#quotes.values()].some((row) => row.state === "quoted" && row.expiresAt > nowForLimits
        && row.payer === payer && row.voter === voter);
      const settledWindowStart = nowForLimits.getTime() - SETTLED_CAPACITY_WINDOW_MS;
      const settledReservations = [...this.#reservations.values()].filter((row) => row.profileId === submission.profileId
        && row.state === "consumed" && row.consumedAt?.getTime() > settledWindowStart);
      const pairProposal = settledReservations.filter((row) => {
        const priorQuote = this.#quoteEntry(row.quoteId)?.[1];
        const priorSubmission = priorQuote && this.#submissions.get(priorQuote.submissionId);
        const priorSnapshot = priorSubmission && this.#snapshots.get(priorSubmission.issuanceSnapshotId);
        return priorQuote?.payer === payer && priorQuote.voter === voter && priorSnapshot?.proposalId === proposalId;
      }).length;
      const pendingCount = [...this.#reservations.values()].filter((row) => row.profileId === submission.profileId
        && ["active", "expiry_pending_reconciliation"].includes(row.state)).length;
      if (activePair) throw new Error("ACTIVE_QUOTE_EXISTS");
      if (pairProposal >= 2) throw new Error("SENDER_PROPOSAL_LIMIT");
      if (pendingCount >= policy.pendingReservationCapacity || settledReservations.length >= policy.settledCapacity) {
        throw new Error("issuance capacity unavailable");
      }
      if (this.#submissions.has(submission.id)) throw new Error("duplicate submission id");
      if (this.#quoteIds.has(publicQuoteId)) throw new Error("duplicate quote_id");
      if (this.#quotes.has(quote.id)) throw new Error("duplicate internal quote id");
      if (this.#snapshots.has(snapshot.id)) throw new Error("duplicate snapshot id");
      if (this.#reservations.has(reservation.id)) throw new Error("duplicate reservation id");
      assertSignerDeploymentBinding(signer, { chainId: deployment.chainId, splitter: deployment.splitter });
      const quoteMessage = buildIssuedQuoteMessage({
        quoteId: publicQuoteId, payer: quotePayer, voter, attentionAmount, feeAmount,
        submissionHash, token, expiresAt: authoritativeExpiry,
      });
      // Signing precedes every write, so a signer failure leaves no submission,
      // snapshot, quote, or reservation behind.
      const signed = await signIssuedQuote(signer, quoteMessage);
      const publicId = this.#allocatePublicIdUnsafe();
      const now = issuanceNow;
      const normalizedSnapshot = { ...clone(snapshot), dao: normalizedDao, proposalId, contentHash, sourceBlockHash };
      const normalizedSubmission = {
        ...clone(submission), submissionHash, publicId, issuanceSnapshotId: snapshot.id, status: "QUOTED",
        payer, signedSender, publicStateChangedAt: now,
      };
      const normalizedQuote = {
        ...clone(quote), quoteId: publicQuoteId, submissionId: submission.id, state: "quoted", reservationState: "reserved",
        payer: quotePayer, voter, attentionAmount, feeAmount, token, splitter,
        baseChainId: deployment.chainId, quoteVersion: 1, expiresAt: authoritativeExpiry,
        signature: signed.signature,
      };
      const normalizedReservation = {
        ...clone(reservation), quoteId: publicQuoteId, amount: reservationAmount, expiresAt: authoritativeExpiry,
        state: "active", createdAt: now, updatedAt: now,
      };
      this.#snapshots.set(snapshot.id, normalizedSnapshot);
      this.#submissions.set(submission.id, normalizedSubmission);
      this.#submissionHashes.add(submissionHash);
      this.#quotes.set(quote.id, normalizedQuote);
      this.#quoteIds.add(publicQuoteId);
      this.#reservations.set(reservation.id, normalizedReservation);
      return {
        resumed: false,
        publicId,
        submission: { id: normalizedSubmission.id, publicId, status: normalizedSubmission.status },
        quote: { ...clone(normalizedQuote), ...issuedQuotePayload(signed) },
      };
    }));
  }

  #quoteEntry(publicQuoteId) {
    return [...this.#quotes.entries()].find(([, quote]) => quote.quoteId === publicQuoteId) ?? null;
  }

  async countLiabilities(profileId) {
    let total = 0n;
    for (const row of this.#reservations.values()) {
      if (row.profileId === profileId && ["active", "expiry_pending_reconciliation"].includes(row.state)) total += BigInt(row.amount);
    }
    return total;
  }

  async recordSettlementHint({ publicId, payer, txHash, chainId, splitter } = {}) {
    const owner = address(payer, "payer");
    const transactionHash = bytes32(txHash, "txHash");
    const settlementChain = block(chainId, "chainId").raw;
    const settlementSplitter = address(splitter, "splitter");
    return this.#serialized(() => {
      const submission = [...this.#submissions.values()].find((row) => row.publicId === publicId);
      if (!submission || submission.payer !== owner) return null;
      const quote = [...this.#quotes.values()].find((row) => row.submissionId === submission.id);
      const deployment = quote && this.#deployments.get(quote.deploymentId);
      const now = instant(this.#clock(), "clock");
      if (quote && (quote.state === "expired" || quote.expiresAt <= now)) {
        if (quote.state !== "expired") {
          quote.state = "expired";
          const reservation = [...this.#reservations.values()].find((row) => row.quoteId === quote.quoteId);
          if (reservation?.state === "active") {
            reservation.state = "expiry_pending_reconciliation";
            reservation.updatedAt = now;
          }
        }
        if (submission.status !== "EXPIRED") {
          submission.status = "EXPIRED";
          submission.publicStateChangedAt = now;
        }
        return clone(publicSubmissionProjection(submission, null));
      }
      if (!quote || !deployment || quote.state !== "quoted"
          || quote.baseChainId !== settlementChain || quote.splitter !== settlementSplitter) {
        throw new Error("settlement hint can be recorded only for a valid payable quote");
      }
      if (submission.pendingSettlementTxHash && submission.pendingSettlementTxHash !== transactionHash) {
        throw new Error("conflicting settlement transaction hash");
      }
      if (submission.status === "SETTLEMENT_PENDING") return clone(publicSubmissionProjection(submission, null));
      if (submission.status !== "QUOTED") throw new Error("settlement hint can be recorded only for a valid payable quote");
      submission.pendingSettlementTxHash = transactionHash;
      submission.status = "SETTLEMENT_PENDING";
      submission.publicStateChangedAt = now;
      return clone(publicSubmissionProjection(submission, null));
    });
  }

  async listPendingSettlementHints({ limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    return [...this.#submissions.values()].filter((row) => row.status === "SETTLEMENT_PENDING" && row.pendingSettlementTxHash)
      .slice(0, limit).map((submission) => {
        const quote = [...this.#quotes.values()].find((row) => row.submissionId === submission.id);
        return clone({ publicId: submission.publicId, quoteId: quote.quoteId,
          txHash: submission.pendingSettlementTxHash, expiresAt: quote.expiresAt });
      });
  }

  async resolveSettlementHint({ publicId, txHash, state } = {}) {
    const transactionHash = bytes32(txHash, "txHash");
    if (!new Set(["payment_required", "expired"]).has(state)) throw new TypeError("invalid settlement hint state");
    return this.#serialized(() => {
      const submission = [...this.#submissions.values()].find((row) => row.publicId === publicId);
      if (!submission || submission.status !== "SETTLEMENT_PENDING" || submission.pendingSettlementTxHash !== transactionHash) return false;
      const quote = [...this.#quotes.values()].find((row) => row.submissionId === submission.id);
      submission.pendingSettlementTxHash = null;
      submission.publicStateChangedAt = instant(this.#clock(), "clock");
      if (state === "expired") {
        submission.status = "EXPIRED";
        if (quote?.state === "quoted") quote.state = "expired";
        const reservation = quote && [...this.#reservations.values()].find((row) => row.quoteId === quote.quoteId);
        if (reservation?.state === "active") reservation.state = "expiry_pending_reconciliation";
      } else submission.status = "QUOTED";
      return true;
    });
  }

  async findSettlementQuote(quoteId) {
    const entry = this.#quoteEntry(bytes32(quoteId, "quoteId"));
    if (!entry) return null;
    const quote = entry[1];
    const submission = this.#submissions.get(quote.submissionId);
    const snapshot = submission && this.#snapshots.get(submission.issuanceSnapshotId);
    const deployment = this.#deployments.get(quote.deploymentId);
    if (!submission || !snapshot || !deployment) return null;
    return clone({ quoteId: quote.quoteId, payer: quote.payer, voter: quote.voter,
      attentionAmount: quote.attentionAmount, feeAmount: quote.feeAmount, gavelRecipient: deployment.gavelRecipient,
      token: quote.token, submissionHash: submission.submissionHash, quoteVersion: quote.quoteVersion,
      baseChainId: quote.baseChainId, splitter: quote.splitter, expiresAt: quote.expiresAt,
      issuanceLifecycle: snapshot.eligibility, dao: snapshot.dao, proposalId: snapshot.proposalId,
      profileId: submission.profileId,
      destinationRef: this.#deliverySettings.get(submission.profileId) ?? null,
      trustedSummary: { subject: "Paid pitch ready", text: "Open your private Gate inbox." } });
  }

  async markSettlementPending(publicId, pending = true) {
    if (typeof pending !== "boolean") throw new TypeError("pending settlement marker must be boolean");
    return this.#serialized(() => {
      const submission = [...this.#submissions.values()].find((row) => row.publicId === publicId);
      if (!submission) throw new Error("submission not found");
      const quote = [...this.#quotes.values()].find((row) => row.submissionId === submission.id);
      const now = instant(this.#clock(), "clock");
      if (!quote || quote.state !== "quoted" || quote.expiresAt <= now) {
        throw new Error("settlement hint can change only while quote is valid");
      }
      const target = pending ? "SETTLEMENT_PENDING" : "QUOTED";
      if (submission.status === target) return false;
      if (!["QUOTED", "SETTLEMENT_PENDING"].includes(submission.status)) {
        throw new Error("settlement hint can change only while quote is valid");
      }
      submission.status = target;
      submission.publicStateChangedAt = now;
      return true;
    });
  }

  async markExpired() {
    const cutoff = instant(this.#clock(), "clock");
    return this.#serialized(async () => {
      let changed = 0;
      for (const quote of this.#quotes.values()) {
        if (quote.state !== "quoted" || quote.expiresAt > cutoff) continue;
        quote.state = "expired";
        const reservation = [...this.#reservations.values()].find((row) => row.quoteId === quote.quoteId);
        if (reservation?.state === "active") {
          reservation.state = "expiry_pending_reconciliation";
          reservation.updatedAt = instant(this.#clock(), "clock");
        }
        const submission = this.#submissions.get(quote.submissionId);
        if (["QUOTED", "SETTLEMENT_PENDING"].includes(submission?.status)) {
          submission.status = "EXPIRED";
          submission.publicStateChangedAt = instant(this.#clock(), "clock");
        }
        changed += 1;
      }
      return changed;
    });
  }

  async releaseReservation(quoteId, _evidence) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    return this.#serialized(() => {
      const entry = this.#quoteEntry(publicQuoteId);
      if (!entry) throw new Error("quote not found");
      const reservation = [...this.#reservations.values()].find((row) => row.quoteId === publicQuoteId);
      if (!reservation) throw new Error("reservation not found");
      if (reservation.state === "released") return false;
      if (reservation.state !== "expiry_pending_reconciliation") throw new Error("reservation is not expiry pending");
      throw new Error("reservation release is owned by recordScannerRange");
    });
  }

  #validateSettlement(quote, submission, settlement, inbox, notification, monitor) {
    if (!settlement?.event || !settlement.evidence) throw new TypeError("exact settlement event and scanner evidence are required");
    const event = settlement.event;
    const evidence = settlement.evidence;
    assertExactKeys(event, QUOTE_SETTLED_EVENT_FIELDS, "settlement event");
    const deployment = this.#deployments.get(quote.deploymentId);
    const bindings = {
      quoteId: bytes32(event.quoteId, "event.quoteId"), payer: address(event.payer, "event.payer"),
      voter: address(event.voter, "event.voter"), attentionAmount: uint78(event.attentionAmount, "event.attentionAmount"),
      gavelRecipient: address(event.gavelRecipient, "event.gavelRecipient"),
      gavelFeeAmount: uint78(event.gavelFeeAmount, "event.gavelFeeAmount"), token: address(event.token, "event.token"),
      submissionHash: bytes32(event.submissionHash, "event.submissionHash"),
    };
    const expected = {
      quoteId: quote.quoteId, payer: quote.payer, voter: quote.voter, attentionAmount: quote.attentionAmount,
      gavelRecipient: deployment?.gavelRecipient, gavelFeeAmount: quote.feeAmount, token: quote.token,
      submissionHash: submission.submissionHash,
    };
    for (const field of Object.keys(expected)) {
      if (bindings[field] !== expected[field]) throw new Error(`settlement ${field} does not match stored quote`);
    }
    const confirmations = Number(evidence.confirmations);
    if (evidence.oneConfirmation !== true || evidence.canonical !== true || evidence.scannerVerified !== true
        || !Number.isSafeInteger(confirmations) || confirmations !== 1) {
      throw new Error("confirmed canonical scanner evidence is required");
    }
    if (String(evidence.chainId) !== quote.baseChainId || address(evidence.splitter, "evidence.splitter") !== quote.splitter) {
      throw new Error("settlement chainId or splitter does not match stored quote");
    }
    const receiptBlockTimestamp = instant(settlement.receiptBlockTimestamp, "receiptBlockTimestamp");
    if (receiptBlockTimestamp >= quote.expiresAt) throw new Error("receiptBlockTimestamp must be strictly before quote expiry");
    const normalized = {
      ...clone(settlement), txHash: bytes32(settlement.txHash, "txHash"),
      receiptBlockHash: bytes32(settlement.receiptBlockHash, "receiptBlockHash"),
      receiptBlock: block(settlement.receiptBlock, "receiptBlock").raw,
      receiptBlockTimestamp, settledAt: instant(settlement.settledAt, "settledAt"), event: bindings,
      evidence: { ...clone(evidence), chainId: quote.baseChainId, splitter: quote.splitter, confirmations },
    };
    if (!Number.isInteger(settlement.logIndex) || settlement.logIndex < 0) throw new TypeError("logIndex must be a nonnegative integer");
    if (!inbox?.id || !INBOX_LIFECYCLE_SET.has(inbox.issuanceLifecycle) || !INBOX_LIFECYCLE_SET.has(inbox.currentLifecycle)
        || typeof inbox.lifecycleChanged !== "boolean" || typeof inbox.currentLifecycleUnavailable !== "boolean") {
      throw new TypeError("invalid inbox lifecycle");
    }
    const issuanceSnapshot = this.#snapshots.get(submission.issuanceSnapshotId);
    if (inbox.issuanceLifecycle !== issuanceSnapshot?.eligibility) {
      throw new Error("inbox issuance lifecycle does not match the frozen issuance snapshot");
    }
    if (inbox.currentLifecycleUnavailable) {
      if (inbox.currentLifecycle !== "UNKNOWN" || inbox.lifecycleChanged) {
        throw new Error("unavailable lifecycle requires UNKNOWN lifecycle without a change claim");
      }
    } else {
      if (inbox.currentLifecycle === "UNKNOWN") throw new Error("UNKNOWN lifecycle must be marked unavailable");
      if (inbox.lifecycleChanged !== (inbox.currentLifecycle !== inbox.issuanceLifecycle)) {
        throw new Error("lifecycle change flag does not match lifecycle values");
      }
    }
    if (!inbox.currentLifecycleUnavailable && inbox.privateUnavailabilityReason != null) {
      throw new TypeError("private unavailability reason requires unavailable lifecycle");
    }

    if (!monitor?.id) throw new TypeError("monitor id is required");
    const nextCheck = block(monitor.nextCheckBlock, "monitor.nextCheckBlock");
    if (nextCheck.number < BigInt(normalized.receiptBlock)) throw new Error("monitor nextCheckBlock must cover receiptBlock");
    return normalized;
  }

  async settle({ quoteId, settlement, inbox, notification, monitor }) {
    const publicQuoteId = bytes32(quoteId, "quoteId");
    return this.#withProfileLock(`quote:${publicQuoteId}`, async () => {
      const quoteEntry = this.#quoteEntry(publicQuoteId);
      if (!quoteEntry) throw new Error("quote not found");
      const [quoteInternalId, quote] = quoteEntry;
      const submission = this.#submissions.get(quote.submissionId);
      const monitorKey = `${quote.baseChainId}:${quote.splitter}:${quote.quoteId}`;
      if (quote.state === "settled") {
        const normalizedReplay = this.#validateSettlement(quote, submission, settlement, inbox, notification, monitor);
        const sameEvent = quote.txHash === normalizedReplay.txHash && quote.logIndex === normalizedReplay.logIndex
          && quote.receiptBlock === normalizedReplay.receiptBlock && quote.receiptBlockHash === normalizedReplay.receiptBlockHash
          && quote.receiptBlockTimestamp.valueOf() === normalizedReplay.receiptBlockTimestamp.valueOf();
        if (!sameEvent) throw new Error("conflicting settlement evidence");
        const existingInbox = [...this.#inboxItems.values()].find((row) => row.submissionId === submission.id);
        const existingMonitor = this.#monitors.get(monitorKey);
        const existingNotification = existingInbox && [...this.#notifications.values()].find((row) => row.inboxId === existingInbox.id);
        if (!existingInbox || !existingMonitor) {
          throw new Error("idempotent settlement side effects are incomplete");
        }
        if (existingInbox.id !== inbox.id
            || (existingNotification && notification && existingNotification.id !== notification.id)
            || existingMonitor.id !== monitor.id) {
          throw new Error("conflicting settlement side effects");
        }
        return false;
      }
      if (quote.state !== "quoted" && quote.state !== "expired") throw new Error("quote cannot be settled");
      const reservation = [...this.#reservations.values()].find((row) => row.quoteId === publicQuoteId);
      if (!reservation || !["active", "expiry_pending_reconciliation", "released"].includes(reservation.state)) {
        throw new Error("reservation cannot be consumed");
      }
      if ([...this.#inboxItems.values()].some((row) => row.submissionId === submission.id)) throw new Error("duplicate inbox submission");
      const normalizedSettlement = this.#validateSettlement(quote, submission, settlement, inbox, notification, monitor);
      const fingerprint = compareShape({ settlement, inbox, notification, monitor });
      const now = instant(this.#clock(), "clock");
      const stagedQuote = {
        ...clone(quote), ...clone(normalizedSettlement), state: "settled", reservationState: "consumed",
        settlementFingerprint: fingerprint,
      };
      const stagedReservation = { ...clone(reservation), state: "consumed", consumedAt: now, updatedAt: now };
      const stagedSubmission = { ...clone(submission), status: "SETTLED", publicStateChangedAt: now };
      const stagedInbox = {
        ...clone(inbox), submissionId: submission.id, profileId: submission.profileId,
        inboxCreatedAt: now, readAt: null, archivedAt: null,
      };
      const notificationIsValid = Boolean(notification?.id && notification.status === "pending"
        && !this.#notifications.has(notification.id));
      const stagedNotification = notificationIsValid ? { ...clone(notification), inboxId: inbox.id, status: "pending", retryCount: 0, claimGeneration: 0,
        nextAttemptAt: now, claimedUntil: null, firstAttemptAt: null, dedupeDeadline: null,
        manualReconciliationAt: null, createdAt: now, updatedAt: now } : null;
      const stagedMonitor = {
        ...clone(monitor), quoteId: quote.quoteId, chainId: quote.baseChainId, splitter: quote.splitter,
        receiptBlock: normalizedSettlement.receiptBlock, receiptBlockHash: normalizedSettlement.receiptBlockHash,
        txHash: normalizedSettlement.txHash, logIndex: normalizedSettlement.logIndex, completedAt: null,
        claimedUntil: null, claimGeneration: 0, reconciliationMetadata: {},
      };
      await this.#beforeSettlementCommit();
      return this.#serialized(async () => {
        const current = this.#quotes.get(quoteInternalId);
        if (current?.state === "settled") {
          const sameEvent = current.txHash === normalizedSettlement.txHash && current.logIndex === normalizedSettlement.logIndex
            && current.receiptBlock === normalizedSettlement.receiptBlock && current.receiptBlockHash === normalizedSettlement.receiptBlockHash
            && current.receiptBlockTimestamp.valueOf() === normalizedSettlement.receiptBlockTimestamp.valueOf();
          if (!sameEvent) throw new Error("conflicting settlement evidence");
          return false;
        }
        if (this.#inboxItems.has(inbox.id)) throw new Error("duplicate inbox id");

        if (this.#monitors.has(monitorKey)) throw new Error("duplicate settlement monitor");
        const settlementCollision = [...this.#quotes.values()].some((row) => row.state === "settled"
          && row.baseChainId === quote.baseChainId && row.splitter === quote.splitter
          && row.txHash === normalizedSettlement.txHash && row.logIndex === normalizedSettlement.logIndex);
        if (settlementCollision) throw new Error("duplicate settlement transaction/log identity");
        this.#quotes.set(quoteInternalId, stagedQuote);
        this.#reservations.set(reservation.id, stagedReservation);
        this.#submissions.set(submission.id, stagedSubmission);
        this.#inboxItems.set(inbox.id, stagedInbox);
        if (stagedNotification) this.#notifications.set(notification.id, stagedNotification);
        this.#monitors.set(monitorKey, stagedMonitor);
        return { settled: true, inboxCreatedAt: clone(now) };
      });
    });
  }

  async claimSettlementMonitors({ chainId, splitter, headBlock, limit = 50, leaseMs = 5 * 60_000 } = {}) {
    const settlementChain = block(chainId, "chainId").raw;
    const settlementSplitter = address(splitter, "splitter");
    const head = block(headBlock, "headBlock").number;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new TypeError("leaseMs must be from 1 to 3600000");
    return this.#serialized(() => {
      const now = instant(this.#clock(), "clock");
      const claimed = [...this.#monitors.values()].filter((row) => row.chainId === settlementChain
        && row.splitter === settlementSplitter && !row.completedAt && BigInt(row.nextCheckBlock) <= head
        && (!row.claimedUntil || row.claimedUntil <= now))
        .sort((left, right) => BigInt(left.nextCheckBlock) < BigInt(right.nextCheckBlock) ? -1 : 1).slice(0, limit);
      for (const row of claimed) { row.claimedUntil = new Date(now.valueOf() + leaseMs); row.claimGeneration += 1; }
      return clone(claimed.map(({ claimedUntil: _claim, claimGeneration, ...row }) => ({ ...row, claimToken: String(claimGeneration) })));
    });
  }

  async advanceSettlementMonitor({ id, claimToken, progressBlock, nextCheckBlock, completed, reorged } = {}) {
    if (!id || typeof claimToken !== "string" || !/^[1-9][0-9]*$/.test(claimToken)
        || typeof completed !== "boolean" || typeof reorged !== "boolean") throw new TypeError("invalid monitor advancement");
    const progress = block(progressBlock, "progressBlock").raw;
    const next = completed ? null : block(nextCheckBlock, "nextCheckBlock").raw;
    if (!completed && BigInt(next) <= BigInt(progress)) throw new Error("nextCheckBlock must advance beyond progressBlock");
    return this.#serialized(() => {
      const row = [...this.#monitors.values()].find((item) => item.id === id);
      if (!row) throw new Error("settlement monitor not found");
      const now = instant(this.#clock(), "clock");
      if (row.claimGeneration !== Number(claimToken) || !row.claimedUntil || row.claimedUntil <= now) return false;
      row.progressBlock = progress; row.claimedUntil = null;
      if (next !== null) row.nextCheckBlock = next;
      if (reorged) row.reconciliationMetadata = { ...clone(row.reconciliationMetadata ?? {}), monitorReorged: true };
      if (completed) row.completedAt = now;
      if (reorged) {
        const quote = this.#quoteEntry(row.quoteId)?.[1];
        if (quote && !quote.settlementReorgedAt) quote.settlementReorgedAt = now;
      }
      return true;
    });
  }

  async claimNotificationAttempts({ limit = 20, leaseMs = 5 * 60_000, now = this.#clock() } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be from 1 to 1000");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new TypeError("leaseMs must be from 1 to 3600000");
    const at = instant(now, "now");
    return this.#serialized(() => {
      const rows = [...this.#notifications.values()].filter((row) => ["pending", "failed"].includes(row.status)
        && (row.nextAttemptAt ?? row.createdAt) <= at && (!row.claimedUntil || row.claimedUntil <= at)
        && !row.manualReconciliationAt && row.retryCount <= this.#notificationRetryLimit).slice(0, limit);
      for (const row of rows) {
        row.status = "pending";
        row.claimGeneration += 1;
        row.claimedUntil = new Date(at.valueOf() + leaseMs);
        row.firstAttemptAt ??= at;
        row.dedupeDeadline ??= new Date(row.firstAttemptAt.valueOf() + 24 * 60 * 60 * 1000);
      }
      return clone(rows.map((row) => ({ id: row.id, claimToken: String(row.claimGeneration), retryCount: row.retryCount,
        firstAttemptAt: row.firstAttemptAt, dedupeDeadline: row.dedupeDeadline,
        profileId: this.#inboxItems.get(row.inboxId)?.profileId,
        destinationRef: row.destinationRef, summary: row.summary })));
    });
  }

  async completeNotification({ id, claimToken, providerOpaqueId = null } = {}) {
    return this.#serialized(() => {
      const row = this.#notifications.get(id);
      if (!row) throw new Error("notification not found");
      if (row.status === "sent") return false;
      const now = instant(this.#clock(), "clock");
      if (row.manualReconciliationAt || String(row.claimGeneration) !== claimToken
          || !row.claimedUntil || row.claimedUntil <= now || row.status !== "pending") return false;
      row.status = "sent"; row.providerOpaqueId = providerOpaqueId; row.claimedUntil = null;
      row.updatedAt = now; return true;
    });
  }

  async failNotification({ id, claimToken, errorCode, nextAttemptAt } = {}) {
    const next = instant(nextAttemptAt, "nextAttemptAt");
    return this.#serialized(() => {
      const row = this.#notifications.get(id);
      if (!row) throw new Error("notification not found");
      if (row.status === "sent") return false;
      const now = instant(this.#clock(), "clock");
      if (row.manualReconciliationAt || String(row.claimGeneration) !== claimToken
          || !row.claimedUntil || row.claimedUntil <= now || row.status !== "pending") return false;
      row.status = "failed"; row.errorCode = String(errorCode); row.retryCount += 1;
      row.nextAttemptAt = next; row.claimedUntil = null; row.updatedAt = now; return true;
    });
  }

  async reconcileNotification({ id, claimToken, errorCode } = {}) {
    if (!id || typeof claimToken !== "string" || !/^[1-9][0-9]*$/.test(claimToken)
        || typeof errorCode !== "string" || !errorCode) throw new TypeError("notification id, claimToken, and errorCode are required");
    return this.#serialized(() => {
      const row = this.#notifications.get(id);
      if (!row) throw new Error("notification not found");
      const now = instant(this.#clock(), "clock");
      if (row.manualReconciliationAt || String(row.claimGeneration) !== claimToken
          || !row.claimedUntil || row.claimedUntil <= now || row.status !== "pending") return false;
      row.status = "failed";
      row.errorCode = errorCode;
      row.manualReconciliationAt = now;
      row.claimedUntil = null;
      row.updatedAt = now;
      return true;
    });
  }

  async updateNotification(id, patch = {}) {
    return this.#withProfileLock(`notification:${id}`, async () => {
      const row = this.#notifications.get(id);
      if (!row) throw new Error("notification not found");
      if (row.manualReconciliationAt && patch.status !== undefined && patch.status !== "failed") {
        throw new Error("manual reconciliation notification state is terminal");
      }
      const transition = notificationTransition(row, patch, this.#notificationRetryLimit);
      const updated = { ...clone(row), ...clone(transition),
        updatedAt: instant(this.#clock(), "clock") };
      this.#notifications.set(id, updated);
      return clone({
        id: updated.id, inboxId: updated.inboxId, channel: updated.channel, status: updated.status,
        providerOpaqueId: updated.providerOpaqueId, errorCode: updated.errorCode,
        retryCount: updated.retryCount, createdAt: updated.createdAt, updatedAt: updated.updatedAt,
      });
    });
  }

  #inboxRecord(row) {
    const submission = this.#submissions.get(row.submissionId);
    const snapshot = submission && this.#snapshots.get(submission.issuanceSnapshotId);
    return clone({
      id: row.id,
      archivedAt: row.archivedAt ?? null,
      createdAt: row.inboxCreatedAt,
      issuanceLifecycle: row.issuanceLifecycle,
      currentLifecycle: row.currentLifecycle,
      lifecycleChanged: row.lifecycleChanged === true,
      material: submission?.material && typeof submission.material === "object" ? submission.material : {},
      canonicalFacts: snapshot?.canonicalFacts ?? {},
      decodedFacts: snapshot?.decodedFacts ?? {},
      canonicalActions: snapshot?.canonicalActions ?? [],
      dao: snapshot?.dao ?? null,
      proposalId: snapshot?.proposalId ?? null,
    });
  }

  async listInboxItems(profileId) {
    if (typeof profileId !== "string" || !profileId) throw new TypeError("profileId is required");
    return this.#serialized(() => [...this.#inboxItems.values()]
      .filter((row) => row.profileId === profileId)
      .sort((left, right) => right.inboxCreatedAt - left.inboxCreatedAt)
      .map((row) => this.#inboxRecord(row)));
  }

  async getInboxItem(profileId, id) {
    if (typeof profileId !== "string" || !profileId || typeof id !== "string" || !id) return null;
    return this.#serialized(() => {
      const row = this.#inboxItems.get(id);
      if (!row || row.profileId !== profileId) return null;
      return this.#inboxRecord(row);
    });
  }

  async archiveInboxItem(profileId, id) {
    if (typeof profileId !== "string" || !profileId || typeof id !== "string" || !id) return null;
    return this.#serialized(() => {
      const row = this.#inboxItems.get(id);
      if (!row || row.profileId !== profileId) return null;
      if (row.archivedAt == null) row.archivedAt = instant(this.#clock(), "clock");
      return this.#inboxRecord(row);
    });
  }

  async counts() {
    return {
      snapshots: this.#snapshots.size, submissions: this.#submissions.size, quotes: this.#quotes.size,
      reservations: this.#reservations.size, inboxItems: this.#inboxItems.size,
      notifications: this.#notifications.size, monitors: this.#monitors.size,
    };
  }
}

module.exports = { MemoryGateStore };
