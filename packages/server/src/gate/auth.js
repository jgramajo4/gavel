"use strict";

const crypto = require("node:crypto");
const { TypedDataEncoder, getAddress, keccak256, toUtf8Bytes, verifyTypedData } = require("ethers");
const {
  BASE_PAYOUT_CONTROL_PURPOSE,
  BASE_PAYOUT_CONTROL_TYPES,
  GATE_ENROLLMENT_PURPOSE,
  GATE_ENROLLMENT_TYPES,
  WALLET_SESSION_PURPOSE,
  WALLET_SESSION_ROLES,
  WALLET_SESSION_TYPES,
  hashTypedDataPayload,
  validateGateEnrollment,
} = require("@gavel/gate");

const AUTH_TYPES = Object.freeze({
  GateEnrollment: GATE_ENROLLMENT_TYPES,
  BasePayoutControl: BASE_PAYOUT_CONTROL_TYPES,
  WalletSession: WALLET_SESSION_TYPES,
});

class AuthRequestError extends Error {
  constructor(message, code = "INVALID_AUTH_PROOF") {
    super(message);
    this.name = "AuthRequestError";
    this.code = code;
  }
}

function clone(value) { return value == null ? value : structuredClone(value); }

class MemoryAuthRepository {
  #nonces = new Map();
  #sessions = new Map();
  #lock = Promise.resolve();

  async insertNonce(row) {
    if (this.#nonces.has(row.nonceHash)) throw new Error("nonce collision");
    this.#nonces.set(row.nonceHash, clone(row));
  }

  async getNonceByHash(nonceHash) { return clone(this.#nonces.get(nonceHash) ?? null); }
  async listNonces() { return [...this.#nonces.values()].map(clone); }
  async getSessionByTokenHash(tokenHash) { return clone(this.#sessions.get(tokenHash) ?? null); }
  async listSessions() { return [...this.#sessions.values()].map(clone); }

  async transaction(callback) {
    const prior = this.#lock;
    let release;
    this.#lock = new Promise((resolve) => { release = resolve; });
    await prior;
    const nonces = structuredClone(this.#nonces);
    const sessions = structuredClone(this.#sessions);
    const transaction = Object.freeze({
      getNonceByHash: async (nonceHash) => clone(nonces.get(nonceHash) ?? null),
      consumeNonce: async (nonceHash, consumedAt) => {
        const row = nonces.get(nonceHash);
        if (!row || row.consumedAt !== null) throw new Error("authentication proof unavailable");
        row.consumedAt = consumedAt;
      },
      insertSession: async (row) => {
        if (sessions.has(row.tokenHash)) throw new Error("session collision");
        sessions.set(row.tokenHash, clone(row));
      },
    });
    try {
      const result = await callback(transaction);
      this.#nonces = nonces;
      this.#sessions = sessions;
      return result;
    } finally { release(); }
  }
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function isCanonicalUintString(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
}

function configuredDomain(value, name) {
  if (!value || typeof value !== "object") throw new TypeError(`${name} domain is required`);
  return {
    chainId: positiveSafeInteger(value.chainId, `${name}.chainId`),
    verifier: getAddress(value.verifier).toLowerCase(),
  };
}

function createAuthService(options = {}) {
  const repository = options.repository;
  if (!repository || typeof repository.insertNonce !== "function") throw new TypeError("auth repository is required");
  const audience = options.audience;
  if (typeof audience !== "string" || audience.length === 0) throw new TypeError("audience is required");
  const base = configuredDomain(options.base, "base");
  const dao = { ...configuredDomain(options.dao, "dao"), dao: options.dao?.dao };
  if (dao.dao !== "nouns") throw new TypeError("canonical Nouns DAO literal is required");
  if (dao.chainId !== 1) throw new TypeError("Nouns authentication requires chain 1");
  const clock = options.clock || (() => Math.floor(Date.now() / 1000));
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const challengeLifetimeSeconds = positiveSafeInteger(options.challengeLifetimeSeconds ?? 300, "challengeLifetimeSeconds");
  if (challengeLifetimeSeconds > 600) throw new TypeError("challenge lifetime exceeds maximum of 600 seconds");
  const sessionLifetimeSeconds = positiveSafeInteger(options.sessionLifetimeSeconds ?? 900, "sessionLifetimeSeconds");
  if (sessionLifetimeSeconds > 3600) throw new TypeError("session lifetime exceeds maximum of 3600 seconds");
  const chainVerifiers = options.chainVerifiers || {};
  const contractVerificationTimeoutMs = positiveSafeInteger(options.contractVerificationTimeoutMs ?? 2_000,
    "contractVerificationTimeoutMs");
  if (contractVerificationTimeoutMs > 10_000) throw new TypeError("contract verification timeout exceeds maximum");

  function requireInputKeys(input, allowed) {
    const extras = Object.keys(input).filter((key) => !allowed.includes(key));
    if (extras.length) throw new TypeError(`${extras[0]} is not accepted for ${input.proofType || "challenge"}`);
  }

  async function issueChallenge(input = {}) {
    if (!Object.hasOwn(AUTH_TYPES, input.proofType)) throw new TypeError("unsupported proof type");
    if (input.proofType === "WalletSession") requireInputKeys(input, ["proofType", "wallet", "role"]);
    else if (input.proofType === "GateEnrollment") requireInputKeys(input, ["proofType", "wallet", "availability", "dao",
      "daoChainId", "acceptPreVote", "acceptVoting", "attentionAmount"]);
    else requireInputKeys(input, ["proofType", "wallet", "dao"]);
    const wallet = getAddress(input.wallet);
    let selected;
    let purpose;
    let messageFields;
    if (input.proofType === "WalletSession") {
      if (!WALLET_SESSION_ROLES.includes(input.role)) throw new TypeError("unsupported wallet session role");
      selected = input.role === "base_sender" ? base : dao;
      purpose = WALLET_SESSION_PURPOSE;
      messageFields = { wallet, role: input.role, audience, purpose };
    } else if (input.proofType === "GateEnrollment") {
      if (input.role !== undefined) throw new TypeError("role is not valid for GateEnrollment");
      if (input.dao !== dao.dao || String(input.daoChainId) !== String(dao.chainId)) throw new TypeError("unsupported DAO domain");
      if (!new Set(["accepting_now", "paused", "closed"]).has(input.availability)) throw new TypeError("unsupported availability");
      if (input.acceptPreVote !== false || typeof input.acceptVoting !== "boolean") throw new TypeError("unsupported Nouns stages");
      if (!isCanonicalUintString(input.attentionAmount)
          || BigInt(input.attentionAmount) < 1_000_000n) throw new TypeError("invalid attention amount");
      selected = dao;
      purpose = GATE_ENROLLMENT_PURPOSE;
      messageFields = { wallet, purpose, availability: input.availability, dao: dao.dao,
        daoChainId: String(dao.chainId), acceptPreVote: false, acceptVoting: input.acceptVoting,
        attentionAmount: String(input.attentionAmount) };
    } else {
      if (input.role !== undefined) throw new TypeError("role is not valid for BasePayoutControl");
      if (input.dao !== dao.dao) throw new TypeError("unsupported DAO");
      selected = base;
      purpose = BASE_PAYOUT_CONTROL_PURPOSE;
      messageFields = { wallet, dao: dao.dao, purpose };
    }
    const issuedAt = positiveSafeInteger(clock(), "clock");
    const nonceBytes = randomBytes(32);
    if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 32) throw new TypeError("randomBytes must return exactly 32 bytes");
    const nonce = `0x${nonceBytes.toString("hex")}`;
    const expiry = issuedAt + challengeLifetimeSeconds;
    const domain = { name: "GavelGate", version: "1", chainId: selected.chainId, verifyingContract: selected.verifier };
    const types = { [input.proofType]: AUTH_TYPES[input.proofType] };
    const message = {
      ...messageFields, nonce,
      issuedAt: String(issuedAt), expiry: String(expiry), version: "1",
    };
    if (input.proofType === "GateEnrollment") {
      validateGateEnrollment(message, {
        daoChainId: String(dao.chainId), daoVerifier: dao.verifier,
        maxLifetime: String(challengeLifetimeSeconds),
      }, String(issuedAt));
    }
    const payloadHash = hashTypedDataPayload({ domain, primaryType: input.proofType, types, message });
    const nonceHash = keccak256(nonce);
    await repository.insertNonce({
      proofType: input.proofType, purpose, role: input.proofType === "WalletSession" ? input.role : null,
      wallet: wallet.toLowerCase(), audience: input.proofType === "WalletSession" ? audience : null,
      chainId: String(selected.chainId), verifier: selected.verifier,
      nonceHash, payloadHash, issuedAt: String(issuedAt), expiry: String(expiry), consumedAt: null,
    });
    return { proofType: input.proofType, primaryType: input.proofType, domain, types, message, nonceHash, payloadHash };
  }

  function exactKeys(value, names, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name))) {
      throw new AuthRequestError(`${label} has an invalid shape`);
    }
  }

  function proofAddress(value, label = "proof wallet") {
    try { return getAddress(value).toLowerCase(); }
    catch { throw new AuthRequestError(`${label} is invalid`); }
  }

  function expectedWalletSession(proof) {
    exactKeys(proof, ["proofType", "typedData", "signature"], "WalletSession proof");
    if (typeof proof.signature !== "string") throw new AuthRequestError("signature is required");
    if (proof.proofType !== "WalletSession") throw new AuthRequestError("verify accepts WalletSession only");
    const typedData = proof.typedData;
    exactKeys(typedData, ["primaryType", "domain", "message"], "WalletSession typed data");
    if (typedData.primaryType !== "WalletSession") throw new AuthRequestError("WalletSession typed data is required");
    exactKeys(typedData.domain, ["name", "version", "chainId", "verifyingContract"], "domain");
    exactKeys(typedData.message, AUTH_TYPES.WalletSession.map(({ name }) => name), "WalletSession");
    const message = typedData.message;
    const role = message.role;
    if (!WALLET_SESSION_ROLES.includes(role)) throw new AuthRequestError("invalid wallet session role");
    const selected = role === "base_sender" ? base : dao;
    const wallet = proofAddress(message.wallet);
    const verifier = proofAddress(typedData.domain.verifyingContract, "domain verifier");
    if (typedData.domain.name !== "GavelGate" || typedData.domain.version !== "1"
        || typedData.domain.chainId !== selected.chainId
        || verifier !== selected.verifier
        || message.audience !== audience || message.purpose !== WALLET_SESSION_PURPOSE
        || message.version !== "1") throw new AuthRequestError("wallet session binding mismatch");
    if (!/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) throw new AuthRequestError("nonce must be bytes32");
    const { issuedAt, expiry } = message;
    if (!isCanonicalUintString(issuedAt) || !isCanonicalUintString(expiry)) throw new AuthRequestError("invalid proof lifetime");
    const now = BigInt(positiveSafeInteger(clock(), "clock"));
    if (BigInt(issuedAt) > now || now >= BigInt(expiry)
        || BigInt(expiry) - BigInt(issuedAt) > BigInt(challengeLifetimeSeconds)) {
      throw new AuthRequestError("authentication proof expired");
    }
    const domain = { name: "GavelGate", version: "1", chainId: selected.chainId, verifyingContract: selected.verifier };
    const types = { WalletSession: AUTH_TYPES.WalletSession };
    const nonceHash = keccak256(message.nonce);
    const payloadHash = hashTypedDataPayload({ domain, primaryType: "WalletSession", types, message });
    const digest = TypedDataEncoder.hash(domain, types, message);
    return {
      now: String(now), domain, types, selected, wallet, digest, message,
      nonceHash, payloadHash,
      expectedRow: {
        proofType: "WalletSession", purpose: WALLET_SESSION_PURPOSE, role, wallet, audience,
        chainId: String(selected.chainId), verifier: selected.verifier,
        nonceHash, payloadHash, issuedAt, expiry,
      },
    };
  }

  function rowMatches(row, expected) {
    return row && Object.entries(expected).every(([key, value]) => row[key] === value);
  }

  async function verifyWalletAuthority(value, message, signature) {
    try {
      if (verifyTypedData(value.domain, value.types, message, signature).toLowerCase() === value.wallet) {
        return { walletKind: "eoa", codeHash: null };
      }
    } catch { /* A contract signature need not be ECDSA-shaped. */ }
    const verifier = chainVerifiers[value.selected.chainId] || chainVerifiers[String(value.selected.chainId)];
    if (typeof verifier !== "function") throw new AuthRequestError("wallet signature invalid");
    let timer;
    try {
      const result = await Promise.race([
        verifier({ wallet: value.wallet, digest: value.digest, signature,
          chainId: String(value.selected.chainId), verifier: value.selected.verifier }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("contract verifier unavailable")),
          contractVerificationTimeoutMs); }),
      ]);
      if (!result || typeof result.code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(result.code)
          || typeof result.magicValue !== "string" || result.magicValue.toLowerCase() !== "0x1626ba7e") {
        throw new AuthRequestError("wallet signature invalid");
      }
      return { walletKind: "contract", codeHash: keccak256(result.code).toLowerCase() };
    } catch { throw new AuthRequestError("wallet signature invalid or contract verifier unavailable"); }
    finally { clearTimeout(timer); }
  }

  async function verifyProof(proof = {}) {
    const value = expectedWalletSession(proof);
    return repository.transaction(async (transaction) => {
      const row = await transaction.getNonceByHash(value.nonceHash);
      if (!row || row.consumedAt !== null || !rowMatches(row, value.expectedRow)) {
        throw new AuthRequestError("authentication proof unavailable");
      }
      await verifyWalletAuthority(value, value.message, proof.signature);
      const tokenBytes = randomBytes(32);
      if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) throw new TypeError("randomBytes must return exactly 32 bytes");
      const token = tokenBytes.toString("base64url");
      const session = {
        wallet: value.wallet, role: value.message.role, chainId: String(value.selected.chainId), audience,
        issuedAt: value.now, expiry: String(BigInt(value.now) + BigInt(sessionLifetimeSeconds)),
      };
      await transaction.consumeNonce(value.nonceHash, value.now);
      await transaction.insertSession({ ...session, tokenHash: keccak256(toUtf8Bytes(token)), revokedAt: null });
      return { token, session };
    });
  }

  function expectedOperationProof(proof, proofType) {
    if (!proof || typeof proof !== "object" || typeof proof.signature !== "string") {
      throw new AuthRequestError(`${proofType} proof is required`);
    }
    const typedData = proof.typedData;
    exactKeys(typedData, ["primaryType", "domain", "message"], `${proofType} typed data`);
    if (typedData.primaryType !== proofType) throw new AuthRequestError(`${proofType} typed data is required`);
    const selected = proofType === "GateEnrollment" ? dao : base;
    exactKeys(typedData.domain, ["name", "version", "chainId", "verifyingContract"], "domain");
    exactKeys(typedData.message, AUTH_TYPES[proofType].map(({ name }) => name), proofType);
    const message = typedData.message;
    const wallet = proofAddress(message.wallet);
    const verifier = proofAddress(typedData.domain.verifyingContract, "domain verifier");
    if (typedData.domain.name !== "GavelGate" || typedData.domain.version !== "1"
        || typedData.domain.chainId !== selected.chainId
        || verifier !== selected.verifier
        || message.version !== "1" || message.dao !== dao.dao) {
      throw new AuthRequestError(`${proofType} binding mismatch`);
    }
    if (proofType === "GateEnrollment") {
      if (message.purpose !== GATE_ENROLLMENT_PURPOSE || message.daoChainId !== String(dao.chainId)
          || !new Set(["accepting_now", "paused", "closed"]).has(message.availability)
          || message.acceptPreVote !== false || typeof message.acceptVoting !== "boolean"
          || !isCanonicalUintString(message.attentionAmount) || BigInt(message.attentionAmount) < 1_000_000n) {
        throw new AuthRequestError("GateEnrollment binding mismatch");
      }
    } else if (message.purpose !== BASE_PAYOUT_CONTROL_PURPOSE) {
      throw new AuthRequestError("BasePayoutControl binding mismatch");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) throw new AuthRequestError("nonce must be bytes32");
    const { issuedAt, expiry } = message;
    if (!isCanonicalUintString(issuedAt) || !isCanonicalUintString(expiry)) throw new AuthRequestError("invalid proof lifetime");
    const now = BigInt(positiveSafeInteger(clock(), "clock"));
    if (BigInt(issuedAt) > now || now >= BigInt(expiry)
        || BigInt(expiry) - BigInt(issuedAt) > BigInt(challengeLifetimeSeconds)) {
      throw new AuthRequestError("authentication proof expired");
    }
    const domain = { name: "GavelGate", version: "1", chainId: selected.chainId, verifyingContract: selected.verifier };
    const types = { [proofType]: AUTH_TYPES[proofType] };
    const nonceHash = keccak256(message.nonce);
    const payloadHash = hashTypedDataPayload({ domain, primaryType: proofType, types, message });
    return {
      now: String(now), domain, types, selected, wallet, nonceHash, payloadHash,
      digest: TypedDataEncoder.hash(domain, types, message), message, signature: proof.signature,
      expectedRow: {
        proofType, purpose: message.purpose, role: null, wallet, audience: null,
        chainId: String(selected.chainId), verifier: selected.verifier,
        nonceHash, payloadHash, issuedAt, expiry,
      },
    };
  }

  async function verifyOperation(value, transaction) {
    const row = await transaction.getNonceByHash(value.nonceHash);
    if (!row || row.consumedAt !== null || !rowMatches(row, value.expectedRow)) {
      throw new AuthRequestError("authentication proof unavailable");
    }
    return verifyWalletAuthority(value, value.message, value.signature);
  }

  async function verifyProfileProofs({ session, gateEnrollmentProof, basePayoutControlProof, existingProfile, transaction } = {}) {
    if (!transaction || typeof transaction.getNonceByHash !== "function") throw new TypeError("profile transaction is required");
    if (!session || session.role !== "dao_profile" || session.audience !== audience
        || String(session.chainId) !== String(dao.chainId)) throw new AuthRequestError("dao_profile session binding mismatch");
    const sessionWallet = proofAddress(session.wallet);
    const enrollment = expectedOperationProof(gateEnrollmentProof, "GateEnrollment");
    if (enrollment.wallet !== sessionWallet) throw new AuthRequestError("profile session wallet mismatch");
    const enrollmentAuthority = await verifyOperation(enrollment, transaction);
    const walletKind = enrollmentAuthority.walletKind;
    const proofIds = [enrollment.nonceHash];
    const basePayoutProofRequired = walletKind === "contract"
      && (!existingProfile || (enrollment.message.availability === "accepting_now"
        && existingProfile.availability !== "accepting_now"));
    if (basePayoutProofRequired) {
      const payout = expectedOperationProof(basePayoutControlProof, "BasePayoutControl");
      if (payout.wallet !== sessionWallet) throw new AuthRequestError("Base payout wallet mismatch");
      const payoutAuthority = await verifyOperation(payout, transaction);
      if (payoutAuthority.walletKind !== "contract") throw new AuthRequestError("Base payout contract authority required");
      proofIds.push(payout.nonceHash);
      return {
        wallet: sessionWallet,
        walletKind,
        proofIds,
        basePayoutChainId: String(payout.selected.chainId),
        basePayoutCodeHash: payoutAuthority.codeHash,
      };
    } else if (basePayoutControlProof !== undefined) {
      throw new AuthRequestError("Base payout proof is not required for this profile update");
    }
    return { wallet: sessionWallet, walletKind, proofIds };
  }

  async function consumeProfileProofs({ proofIds, transaction } = {}) {
    if (!transaction || typeof transaction.consumeNonce !== "function") throw new TypeError("profile transaction is required");
    if (!Array.isArray(proofIds) || proofIds.length < 1 || new Set(proofIds).size !== proofIds.length
        || proofIds.some((id) => !/^0x[0-9a-f]{64}$/.test(id))) throw new TypeError("invalid profile proof ids");
    const consumedAt = String(positiveSafeInteger(clock(), "clock"));
    for (const proofId of proofIds) await transaction.consumeNonce(proofId, consumedAt);
  }

  async function authenticateSession(token, requirements = {}) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("session unavailable");
    const row = await repository.getSessionByTokenHash(keccak256(toUtf8Bytes(token)));
    const now = BigInt(positiveSafeInteger(clock(), "clock"));
    if (!row || row.revokedAt !== null || now >= BigInt(row.expiry)
        || (requirements.role !== undefined && row.role !== requirements.role)
        || (requirements.audience !== undefined && row.audience !== requirements.audience)
        || (requirements.wallet !== undefined && row.wallet !== getAddress(requirements.wallet).toLowerCase())
        || (requirements.chainId !== undefined && row.chainId !== String(requirements.chainId))) {
      throw new Error("session unavailable");
    }
    const { tokenHash: _tokenHash, revokedAt: _revokedAt, ...session } = row;
    return session;
  }

  return Object.freeze({
    issueChallenge, verifyProof, authenticateSession, verifyProfileProofs, consumeProfileProofs,
  });
}

module.exports = { AUTH_TYPES, AuthRequestError, MemoryAuthRepository, createAuthService };
