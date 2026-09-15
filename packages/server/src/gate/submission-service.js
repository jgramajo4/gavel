"use strict";

const crypto = require("node:crypto");
const { getAddress } = require("ethers");
const {
  GAVEL_FEE_AMOUNT,
  QUOTE_LIFETIME_SECONDS,
  QUOTE_VERSION,
  SUPPORTED_DECODER_VERSIONS,
  SubmissionPolicyError,
  assertStageAccepted,
  buildQuoteMessage,
  createQuoteTypedData,
  decodeAction,
  quoteTotalAmount,
  validateSubmissionRequest,
  verifyQuoteSignature,
} = require("@gavel/gate");
const { redactSignerMaterial } = require("./quote-signer");

const NOUNS_DAO = "nouns";
const DECODER_VERSION = SUPPORTED_DECODER_VERSIONS[0];
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;
const NOT_ACCEPTING_MESSAGE = "Not currently accepting new submissions";
const INELIGIBLE_MESSAGE = "Submission is not currently eligible";

function reject(state, code, statusCode, message) {
  return new SubmissionPolicyError(state, code, statusCode, message);
}

const unauthenticated = () => reject("rejected_by_policy", "UNAUTHORIZED", 401, "Authentication required");
const notAccepting = () => reject("rejected_by_policy", "NOT_ACCEPTING", 403, NOT_ACCEPTING_MESSAGE);
const notFound = () => reject("rejected_by_policy", "NOT_FOUND", 404, "Gate profile not found");
const unavailable = () => reject("rejected_by_policy", "CANONICAL_DATA_UNAVAILABLE", 503, "Canonical data is unavailable");

// Store failures are mapped to the frozen coarse vocabulary. Nothing below ever
// reveals a count, a reset time, an owner, or any other private policy value.
function mapIssuanceFailure(error) {
  const message = String(error?.message ?? "");
  if (/ACTIVE_QUOTE_EXISTS/.test(message)) {
    return reject("rejected_by_policy", "ACTIVE_QUOTE_EXISTS", 409, INELIGIBLE_MESSAGE);
  }
  if (/SENDER_PROPOSAL_LIMIT/.test(message)) {
    return reject("rejected_by_policy", "SENDER_PROPOSAL_LIMIT", 409, INELIGIBLE_MESSAGE);
  }
  if (/capacity|issuance unavailable|issuance context changed|payout code changed/i.test(message)) {
    return notAccepting();
  }
  if (/unavailable|timed out|timeout/i.test(message)) return unavailable();
  // Anything unrecognized is an internal failure, not a receipt state. Let it
  // surface as a generic 500 rather than claiming a policy rejection.
  return error instanceof Error ? error : new Error("submission issuance failed");
}

function decimal(value, name) {
  const raw = String(value ?? "");
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new TypeError(`${name} must be a decimal integer string`);
  return raw;
}

function canonicalAddress(value, name) {
  try {
    return getAddress(String(value));
  } catch {
    throw new TypeError(`${name} must be an Ethereum address`);
  }
}

function normalizeDeployment(deployment) {
  if (!deployment || typeof deployment !== "object") throw new TypeError("deployment configuration is required");
  if (typeof deployment.id !== "string" || deployment.id.length === 0) throw new TypeError("deployment.id is required");
  if (typeof deployment.codeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(deployment.codeHash)) {
    throw new TypeError("deployment.codeHash must be bytes32");
  }
  return Object.freeze({
    id: deployment.id,
    chainId: decimal(deployment.chainId, "deployment.chainId"),
    splitter: canonicalAddress(deployment.splitter, "deployment.splitter"),
    token: canonicalAddress(deployment.token, "deployment.token"),
    codeHash: deployment.codeHash.toLowerCase(),
  });
}

// Private, aggregate-only sender and IP quote-rate limiting. It records nothing
// that a submitter can observe and creates no submission row.
function createSenderPolicy({
  senderQuota = 5, ipQuota = 30, windowMs = 10 * 60 * 1000, maxKeys = 4096,
  blockedSenders = [], clock = () => Date.now(), onRateLimitEvent,
} = {}) {
  for (const [name, value] of [["senderQuota", senderQuota], ["ipQuota", ipQuota], ["windowMs", windowMs], ["maxKeys", maxKeys]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  const blocked = new Set([...blockedSenders].map((wallet) => canonicalAddress(wallet, "blockedSenders").toLowerCase()));
  const windows = new Map();

  function consume(key, quota) {
    const now = Number(clock());
    if (!Number.isFinite(now)) return false;
    let entry = windows.get(key);
    if (!entry || now - entry.startedAt >= windowMs) {
      if (!entry && windows.size >= maxKeys) {
        for (const [candidate, value] of windows) if (now - value.startedAt >= windowMs) windows.delete(candidate);
        if (windows.size >= maxKeys) return false;
      }
      entry = { startedAt: now, count: 0 };
      windows.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= quota;
  }

  return Object.freeze({
    async assertAllowed({ sender, ip } = {}) {
      const wallet = canonicalAddress(sender, "sender").toLowerCase();
      if (blocked.has(wallet)) {
        if (onRateLimitEvent) await onRateLimitEvent({ reason: "sender_blocked" });
        throw reject("rejected_by_policy", "SENDER_BLOCKED", 403, INELIGIBLE_MESSAGE);
      }
      const senderAllowed = consume(`sender:${wallet}`, senderQuota);
      const ipAllowed = ip === undefined ? true : consume(`ip:${String(ip)}`, ipQuota);
      if (!senderAllowed || !ipAllowed) {
        if (onRateLimitEvent) await onRateLimitEvent({ reason: senderAllowed ? "ip_rate" : "sender_rate" });
        throw reject("rejected_by_policy", "RATE_LIMITED", 429, "Too many submission requests");
      }
    },
  });
}

function createSubmissionService({
  store, indexClient, quoteSigner, deployment, basePayerCodeReader, publicReader,
  senderPolicy = createSenderPolicy(), clock = () => new Date(),
  randomBytes = crypto.randomBytes, newId = () => crypto.randomUUID(),
  rpcTimeoutMs = 2_000,
} = {}) {
  for (const method of ["issue", "getProfileByWallet", "getPolicy"]) {
    if (!store || typeof store[method] !== "function") throw new TypeError(`store.${method} is required`);
  }
  // Public receipts are never built by stripping fields off a private row: they
  // come from the coarse public projection reader. The in-memory store serves
  // both roles; Postgres serves this one from its gate_public reader.
  const receipts = publicReader ?? store;
  if (typeof receipts.getSubmission !== "function") {
    throw new TypeError("publicReader.getSubmission is required for public receipt projection");
  }
  if (!indexClient || typeof indexClient.getProposalSnapshot !== "function") {
    throw new TypeError("indexClient.getProposalSnapshot is required");
  }
  if (!quoteSigner || typeof quoteSigner.signQuote !== "function" || typeof quoteSigner.address !== "string") {
    throw new TypeError("quoteSigner.signQuote and quoteSigner.address are required");
  }
  if (typeof basePayerCodeReader !== "function") {
    throw new TypeError("basePayerCodeReader is required: an MVP payer must be proven to be an EOA");
  }
  if (!senderPolicy || typeof senderPolicy.assertAllowed !== "function") {
    throw new TypeError("senderPolicy.assertAllowed is required");
  }
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs < 1 || rpcTimeoutMs > 10_000) {
    throw new TypeError("rpcTimeoutMs must be an integer from 1 to 10000");
  }
  const configured = normalizeDeployment(deployment);
  const signerAddress = canonicalAddress(quoteSigner.address, "quoteSigner.address");

  function now() {
    const value = new Date(clock());
    if (Number.isNaN(value.getTime())) throw new TypeError("clock must return a valid time");
    return value;
  }

  async function bounded(read, name) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(read),
        new Promise((_, rejectPromise) => {
          timer = setTimeout(() => rejectPromise(new Error(`${name} timed out`)), rpcTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // MVP payers must be EOAs: the Base native-USDC EIP-3009 v,r,s path has no
  // contract-wallet equivalent. Missing or unreadable code fails closed.
  async function assertPayerIsEoa(payer) {
    let code;
    try {
      code = await bounded(() => basePayerCodeReader({ wallet: payer, chainId: configured.chainId }), "Base payer code read");
    } catch {
      throw unavailable();
    }
    if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) throw unavailable();
    if (code !== "0x") throw notAccepting();
  }

  function issuanceFacts(snapshot) {
    const actions = Array.isArray(snapshot.canonicalActions) ? snapshot.canonicalActions : [];
    const decoded = [];
    for (const [actionIndex, action] of actions.entries()) {
      try {
        decoded.push(decodeAction({
          target: action.target, valueWei: String(action.valueWei), calldata: action.calldata,
          signature: action.signature ?? "", actionIndex,
        }, { decoderVersion: DECODER_VERSION }));
      } catch {
        // An action the versioned decoder cannot canonicalize stays raw in
        // canonicalActions and is never promoted to a decoded fact.
      }
    }
    return {
      canonicalFacts: {
        dao: snapshot.dao, proposalId: snapshot.proposalId, nativeState: snapshot.nativeState,
        eligibility: snapshot.eligibility, mappingVersion: snapshot.mappingVersion,
        sourceBlock: snapshot.sourceBlock, sourceBlockHash: snapshot.sourceBlockHash,
        contentHash: snapshot.contentHash, refreshedAt: snapshot.refreshedAt,
      },
      decodedFacts: { decoderVersion: DECODER_VERSION, actions: decoded },
    };
  }

  async function createSubmission({ session, voterWallet, request, ip } = {}) {
    if (!session || session.role !== "base_sender" || typeof session.wallet !== "string") throw unauthenticated();
    let payer;
    try {
      payer = canonicalAddress(session.wallet, "session wallet");
    } catch {
      throw unauthenticated();
    }
    let voter;
    try {
      voter = canonicalAddress(voterWallet, "voter wallet");
    } catch {
      throw notFound();
    }

    // 1. Parse, size, CommonMark, and evidence URL validation, then the frozen
    //    canonical hash. Evidence URLs are recorded, never dereferenced.
    const { submission, submissionHash } = validateSubmissionRequest(request, { payer, voter });

    // 2. Private sender block and quote-rate checks.
    await senderPolicy.assertAllowed({ sender: payer.toLowerCase(), ip });

    // 3. Gate availability and per-DAO policy/stage.
    const profile = await store.getProfileByWallet(voter);
    if (!profile) throw notFound();
    if (profile.availability !== "accepting_now") throw notAccepting();
    const policy = await store.getPolicy(profile.id, NOUNS_DAO);
    if (!policy || policy.enabled !== true || String(policy.chainId) !== "1") throw notAccepting();
    assertStageAccepted(submission.stage, policy);

    // 4. MVP payer identity.
    await assertPayerIsEoa(payer);

    // 5. Fresh canonical snapshot, lifecycle eligibility, and proposal identity.
    let snapshot;
    try {
      snapshot = await indexClient.getProposalSnapshot(submission.proposalId);
    } catch {
      throw unavailable();
    }
    if (!snapshot || snapshot.dao !== submission.dao || String(snapshot.proposalId) !== submission.proposalId) {
      throw unavailable();
    }
    if (snapshot.eligibility !== submission.stage) throw notAccepting();

    // 6-7. Deduplication, sender/proposal limits, capacity, persistence, and
    //      the reservation all commit under the store's profile-scoped lock.
    const issuedAt = new Date(Math.floor(now().getTime() / 1000) * 1000);
    const expiresAt = new Date(issuedAt.getTime() + QUOTE_LIFETIME_SECONDS * 1000);
    const quoteId = `0x${randomBytes(32).toString("hex")}`;
    const message = buildQuoteMessage({
      quoteId,
      payer,
      voter,
      attentionAmount: decimal(policy.attentionAmount, "policy.attentionAmount"),
      gavelFeeAmount: GAVEL_FEE_AMOUNT.toString(10),
      submissionHash,
      token: configured.token,
      expiry: String(Math.floor(expiresAt.getTime() / 1000)),
      quoteVersion: String(QUOTE_VERSION),
    });
    const signature = await quoteSigner.signQuote(message);
    const { canonicalFacts, decodedFacts } = issuanceFacts(snapshot);
    const snapshotId = newId();

    let issued;
    try {
      issued = await store.issue({
        context: {
          authPassed: true, parsePassed: true, expectedProfileVersion: String(profile.profileVersion),
          walletKind: profile.walletKind, authenticatedSender: payer, payerIsEoa: true, payerWalletKind: "eoa",
          basePayoutCodeHash: profile.basePayoutCodeHash ?? null, stage: submission.stage,
          deploymentCodeHash: configured.codeHash,
        },
        snapshot: {
          id: snapshotId, dao: snapshot.dao, proposalId: snapshot.proposalId, contentHash: snapshot.contentHash,
          nativeState: snapshot.nativeState, eligibility: snapshot.eligibility, mappingVersion: snapshot.mappingVersion,
          sourceBlock: snapshot.sourceBlock, sourceBlockHash: snapshot.sourceBlockHash,
          refreshedAt: new Date(snapshot.refreshedAt), canonicalFacts, decodedFacts,
          canonicalActions: snapshot.canonicalActions,
        },
        submission: {
          id: newId(), submissionHash, profileId: profile.id, issuanceSnapshotId: snapshotId,
          payer, signedSender: payer, material: { ...submission },
        },
        quote: {
          id: newId(), quoteId, payer, voter, attentionAmount: message.attentionAmount,
          feeAmount: message.gavelFeeAmount, totalAmount: quoteTotalAmount(message), token: configured.token,
          baseChainId: configured.chainId, splitter: configured.splitter, deploymentId: configured.id,
          quoteVersion: QUOTE_VERSION, expiresAt, signature,
        },
        reservation: { id: newId(), profileId: profile.id, amount: message.attentionAmount, expiresAt },
      });
    } catch (error) {
      throw mapIssuanceFailure(error);
    }

    if (issued?.resumed === true) {
      return {
        state: "duplicate",
        existing: {
          publicId: issued.publicId,
          state: issued.state,
          resumeUrl: `/v1/submissions/${issued.publicId}/resume`,
        },
      };
    }

    // The store owns the authoritative expiry and signature: the Postgres store
    // re-derives both from its own transaction clock. Rebuild and re-verify the
    // returned quote so a drifted or unsigned row can never reach a payer.
    const persisted = issued?.quote;
    if (!persisted || typeof persisted.signature !== "string") {
      throw new Error("issued quote was not persisted with a signature");
    }
    const authoritative = buildQuoteMessage({
      ...message,
      attentionAmount: decimal(persisted.attentionAmount, "persisted attentionAmount"),
      gavelFeeAmount: decimal(persisted.feeAmount, "persisted feeAmount"),
      expiry: String(Math.floor(new Date(persisted.expiresAt).getTime() / 1000)),
    });
    const typed = createQuoteTypedData(authoritative, {
      chainId: Number(persisted.baseChainId ?? configured.chainId),
      verifyingContract: persisted.splitter ?? configured.splitter,
    });
    if (!verifyQuoteSignature(typed, persisted.signature, signerAddress)) {
      throw new Error("issued quote signature does not verify against the configured signer");
    }

    const receipt = await receipts.getSubmission(issued.publicId);
    return {
      publicId: issued.publicId,
      state: receipt?.state ?? "payment_required",
      updatedAt: receipt?.updatedAt ?? issuedAt,
      quote: {
        domain: typed.domain,
        message: typed.message,
        totalAmount: quoteTotalAmount(typed.message),
        signature: persisted.signature,
      },
    };
  }

  async function getPublicStatus(publicId) {
    if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) return null;
    return (await receipts.getSubmission(publicId)) ?? null;
  }

  return Object.freeze({ createSubmission, getPublicStatus, redactSignerMaterial });
}

module.exports = { NOT_ACCEPTING_MESSAGE, SubmissionPolicyError, createSenderPolicy, createSubmissionService };
