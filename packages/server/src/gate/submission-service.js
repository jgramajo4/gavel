"use strict";

const crypto = require("node:crypto");
const { getAddress } = require("ethers");
const {
  GAVEL_FEE_AMOUNT,
  QUOTE_VERSION,
  SUPPORTED_DECODER_VERSIONS,
  SubmissionPolicyError,
  assertStageAccepted,
  createQuoteTypedData,
  decodeAction,
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
function duplicateReceipt(existing) {
  return {
    state: "duplicate",
    existing: {
      publicId: existing.publicId,
      state: existing.state,
      resumeUrl: `/v1/submissions/${existing.publicId}/resume`,
    },
  };
}

function mapIssuanceFailure(error) {
  const message = String(error?.message ?? "");
  // A hash that exists under another owner is a collision or forged
  // authentication: fail closed without confirming owner or state.
  if (/submission is unavailable/i.test(message)) return notAccepting();
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
  for (const method of ["issue", "getProfileByWallet", "getPolicy", "getOwnedSubmissionByHash", "getOwnedResume"]) {
    if (!store || typeof store[method] !== "function") throw new TypeError(`store.${method} is required`);
  }
  // Public receipts are never built by stripping fields off a private row: they
  // come from the coarse public projection reader. The in-memory store serves
  // both roles; Postgres serves this one from its gate_public reader.
  const receipts = publicReader ?? store;
  if (typeof receipts.getSubmission !== "function") {
    throw new TypeError("publicReader.getSubmission is required for public receipt projection");
  }
  if (typeof store.getOwnedResume !== "function") {
    throw new TypeError("store.getOwnedResume is required for owner-bound resume");
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
    for (const action of actions) {
      try {
        decoded.push(decodeAction({
          target: action.target, valueWei: String(action.valueWei), calldata: action.calldata,
          signature: action.signature ?? "", actionIndex: action.actionIndex,
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

  // Both the issued and the resumed payload pass through here, so an unsigned,
  // drifted, or foreign-signed row can never reach a payer on either path.
  function assertIssuedQuote(quote) {
    if (!quote || typeof quote.signature !== "string" || !quote.message || !quote.domain) {
      throw new Error("quote was not persisted with its signed message and signature");
    }
    if (!verifyQuoteSignature(createQuoteTypedData(quote.message, quote.domain), quote.signature, signerAddress)) {
      throw new Error("persisted quote signature does not verify against the configured signer");
    }
    return Object.freeze({
      domain: quote.domain,
      message: quote.message,
      totalAmount: quote.totalAmount,
      signature: quote.signature,
    });
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

    // 2. Owner-bound global exact-hash lookup. It runs before every mutable
    //    block, rate, profile, policy, index, lifecycle, and capacity check, so
    //    a lost response is always recoverable: a paused Gate, an unhealthy
    //    index, a newly contract-shaped payer, or a spent rate limit can never
    //    strand an advocate who already holds a paid-for quote. It refreshes
    //    nothing and reserves nothing.
    let existing;
    try {
      existing = await store.getOwnedSubmissionByHash({ submissionHash, payer });
    } catch (error) {
      throw mapIssuanceFailure(error);
    }
    if (existing) return duplicateReceipt(existing);

    // 3. Private sender block and quote-rate checks.
    await senderPolicy.assertAllowed({ sender: payer.toLowerCase(), ip });

    // 4. Gate availability and per-DAO policy/stage.
    const profile = await store.getProfileByWallet(voter);
    if (!profile) throw notFound();
    if (profile.availability !== "accepting_now") throw notAccepting();
    const policy = await store.getPolicy(profile.id, NOUNS_DAO);
    if (!policy || policy.enabled !== true || String(policy.chainId) !== "1") throw notAccepting();
    assertStageAccepted(submission.stage, policy);

    // 5. MVP payer identity.
    await assertPayerIsEoa(payer);

    // 6. Fresh canonical snapshot, lifecycle eligibility, and proposal identity.
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

    // 7. Race-closing hash recheck, sender/proposal limits, capacity,
    //    persistence, the reservation, the authoritative expiry, and signing all
    //    happen under the store's profile-scoped lock in one transaction. The
    //    service supplies unsigned inputs only.
    const quoteId = `0x${randomBytes(32).toString("hex")}`;
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
          id: newId(), quoteId, payer, voter,
          attentionAmount: decimal(policy.attentionAmount, "policy.attentionAmount"),
          feeAmount: GAVEL_FEE_AMOUNT.toString(10), token: configured.token,
          baseChainId: configured.chainId, splitter: configured.splitter, deploymentId: configured.id,
          quoteVersion: QUOTE_VERSION,
        },
        reservation: {
          id: newId(), profileId: profile.id,
          amount: decimal(policy.attentionAmount, "policy.attentionAmount"),
        },
        signer: quoteSigner,
      });
    } catch (error) {
      throw mapIssuanceFailure(error);
    }

    // The store also rechecks the hash under its lock to close the race.
    if (issued?.resumed === true) return duplicateReceipt(issued);

    // The store signed and persisted this exact payload. The service returns it
    // verbatim and only re-verifies it; it never reconstructs it.
    const quote = assertIssuedQuote(issued?.quote);
    const receipt = await receipts.getSubmission(issued.publicId);
    return {
      publicId: issued.publicId,
      state: receipt?.state ?? "payment_required",
      updatedAt: receipt?.updatedAt ?? now(),
      quote,
    };
  }

  // Private, owner-bound recovery of an already-issued quote. It signs nothing,
  // refreshes nothing, and reserves nothing.
  async function resumeSubmission({ session, publicId } = {}) {
    if (!session || session.role !== "base_sender" || typeof session.wallet !== "string") throw unauthenticated();
    let payer;
    try {
      payer = canonicalAddress(session.wallet, "session wallet");
    } catch {
      throw unauthenticated();
    }
    if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) return null;
    const resumed = await store.getOwnedResume({ publicId, payer });
    if (!resumed) return null;
    if (!resumed.quote) return resumed;
    return { ...resumed, quote: assertIssuedQuote(resumed.quote) };
  }

  async function getPublicStatus(publicId) {
    if (typeof publicId !== "string" || !PUBLIC_ID.test(publicId)) return null;
    return (await receipts.getSubmission(publicId)) ?? null;
  }

  const runtimeIdentity = Object.freeze({
    deploymentId: configured.id,
    chainId: configured.chainId,
    splitter: configured.splitter,
    token: configured.token,
    codeHash: configured.codeHash,
    quoteSigner: signerAddress,
  });
  return Object.freeze({ createSubmission, getPublicStatus, resumeSubmission, redactSignerMaterial, runtimeIdentity });
}

module.exports = { NOT_ACCEPTING_MESSAGE, SubmissionPolicyError, createSenderPolicy, createSubmissionService };
