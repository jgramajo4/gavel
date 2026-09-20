const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const AVAILABILITY = new Set(["accepting_now", "paused", "closed"]);
const ENROLLMENT_FIELDS = Object.freeze([
  "wallet", "purpose", "availability", "dao", "daoChainId", "acceptPreVote", "acceptVoting",
  "attentionAmount", "nonce", "issuedAt", "expiry", "version",
]);
const BASE_FIELDS = Object.freeze(["wallet", "dao", "purpose", "nonce", "issuedAt", "expiry", "version"]);
const DIRECTORY_LIMIT = 50;
const DIRECTORY_CANDIDATE_LIMIT = 500;

class ProfileRequestError extends Error {
  constructor(message, statusCode = 400, code = "INVALID_PROFILE") {
    super(message);
    this.name = "ProfileRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function address(value, name) {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new ProfileRequestError(`${name} is invalid`);
  return value.toLowerCase();
}
function exactMessage(proof, primaryType, fields) {
  if (!proof || proof.typedData?.primaryType !== primaryType || typeof proof.signature !== "string" || !proof.signature) {
    throw new ProfileRequestError(`${primaryType} proof is required`);
  }
  const allowedProofFields = primaryType === "GateEnrollment"
    ? ["typedData", "signature", "publicDisplay", "publicTags"]
    : ["typedData", "signature"];
  if (Object.keys(proof).some((field) => !allowedProofFields.includes(field))) {
    throw new ProfileRequestError(`${primaryType} proof has an invalid shape`);
  }
  const typedData = proof.typedData;
  if (!typedData || typeof typedData !== "object" || Array.isArray(typedData)
      || Object.keys(typedData).length !== 3
      || ["primaryType", "domain", "message"].some((field) => !Object.hasOwn(typedData, field))) {
    throw new ProfileRequestError(`${primaryType} typed data has an invalid shape`);
  }
  const message = typedData.message;
  if (!message || typeof message !== "object" || Array.isArray(message)
      || Object.keys(message).length !== fields.length
      || fields.some((field) => !Object.hasOwn(message, field))) {
    throw new ProfileRequestError(`${primaryType} message fields are invalid`);
  }
  return message;
}
function publicDisplay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileRequestError("publicDisplay must be an object");
  }
  const result = {};
  for (const field of ["ens", "message"]) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== "string" && value[field] !== null) {
      throw new ProfileRequestError(`publicDisplay.${field} must be a string or null`);
    }
    result[field] = value[field];
  }
  return result;
}
function assertDecimal(value, name, minimum = 0n) {
  if (typeof value !== "string" || !UINT.test(value) || BigInt(value) < minimum) throw new ProfileRequestError(`${name} is invalid`);
}
function publicPolicy(policy) {
  if (!policy || policy.dao !== "nouns" || policy.enabled !== true) return null;
  return {
    dao: "nouns",
    supportedStages: ["PRE_VOTE", "VOTING"],
    acceptedStages: [
      ...(policy.acceptPreVote === true ? ["PRE_VOTE"] : []),
      ...(policy.acceptVoting === true ? ["VOTING"] : []),
    ],
    attentionAmount: String(policy.attentionAmount),
    gavelFeeAmount: "250000",
    tags: Array.isArray(policy.tags) ? policy.tags.filter((tag) => typeof tag === "string") : [],
  };
}
/**
 * The `ens` label this projection publishes for a wallet.
 *
 * A verified reverse resolution wins whenever one could be performed, including
 * a verified miss: `unnamed` publishes `null` rather than letting a wallet's
 * own self-declared `publicDisplay.ens` stand in as an identity it never
 * proved. The stored display value survives only where no resolution happened
 * at all — no resolver configured, or the RPC was unreachable — which keeps a
 * deployment without a mainnet endpoint behaving exactly as it did before.
 */
function displayEns(profile, resolvedEns) {
  if (resolvedEns?.status === "named") return { ens: resolvedEns.name };
  if (resolvedEns?.status === "unnamed") return { ens: null };
  return typeof profile.display?.ens === "string" || profile.display?.ens === null
    ? { ens: profile.display.ens }
    : {};
}

function publicProfile(profile, policy, power, resolvedEns) {
  const accepting = profile.availability === "accepting_now"
    && policy?.dao === "nouns" && policy.enabled === true
    && (policy.acceptPreVote === true || policy.acceptVoting === true)
    && profile.acceptingSubmissions === true;
  const result = {
    wallet: address(profile.wallet, "profile wallet"),
    ...displayEns(profile, resolvedEns),
    availability: profile.availability,
    acceptingSubmissions: accepting,
    ...(typeof profile.display?.message === "string" || profile.display?.message === null ? { message: profile.display.message } : {}),
  };
  if (!accepting) result.message = "Not currently accepting new submissions";
  const safePolicy = publicPolicy(policy);
  if (safePolicy) result.policies = [safePolicy];
  if (power) result.governancePower = { dao: "nouns", amount: power.amount, asOf: power.asOf };
  return result;
}

function createProfileService({ repository, authService, indexClient, baseChainId, encryptDestination,
  ensResolver = null, clock = () => new Date() } = {}) {
  if (!repository || typeof repository.withProfileTransaction !== "function") throw new TypeError("repository.withProfileTransaction is required");
  if (!authService || typeof authService.verifyProfileProofs !== "function" || typeof authService.consumeProfileProofs !== "function") {
    throw new TypeError("authService profile proof methods are required");
  }
  if (!indexClient || typeof indexClient.getVotingPower !== "function") throw new TypeError("indexClient.getVotingPower is required");
  if (ensResolver !== null && typeof ensResolver?.resolve !== "function") {
    throw new TypeError("ensResolver must expose resolve()");
  }
  const configuredBaseChainId = String(baseChainId ?? "");
  if (!UINT.test(configuredBaseChainId) || BigInt(configuredBaseChainId) < 1n) {
    throw new TypeError("baseChainId must be an explicit positive chain ID");
  }

  /**
   * ENS is decoration, so a resolver that misbehaves must not fail a read. The
   * resolver caches, which is what keeps a 50-row directory page to at most 50
   * lookups per TTL rather than one per request.
   */
  async function resolveEns(wallet) {
    if (!ensResolver) return null;
    try { return await ensResolver.resolve(wallet); }
    catch { return null; }
  }

  async function decorate(profile, suppliedPolicy) {
    const [policy, power, resolvedEns] = await Promise.all([
      suppliedPolicy || repository.getPolicy(profile.id, "nouns"),
      indexClient.getVotingPower(profile.wallet),
      resolveEns(profile.wallet),
    ]);
    const hasVotingPolicy = policy?.dao === "nouns" && policy.enabled === true
      && (policy.acceptPreVote === true || policy.acceptVoting === true);
    let acceptingSubmissions = false;
    if (profile.availability === "accepting_now" && hasVotingPolicy
        && typeof repository.isProfileAccepting === "function") {
      try { acceptingSubmissions = await repository.isProfileAccepting(profile.id, "nouns") === true; }
      catch { acceptingSubmissions = false; }
    }
    return publicProfile({ ...profile, acceptingSubmissions }, policy, power, resolvedEns);
  }

  return Object.freeze({
    withDestinationEncryption(boundEncryptDestination) {
      if (typeof boundEncryptDestination !== "function") throw new TypeError("destination encryption is required");
      return createProfileService({ repository, authService, indexClient, baseChainId: configuredBaseChainId,
        encryptDestination: boundEncryptDestination, ensResolver, clock });
    },

    async listPublicProfiles({ dao = "nouns", availability = "accepting_now", minVotingPower, sort = "recent" } = {}) {
      if (dao !== "nouns") throw new ProfileRequestError("only dao=nouns is supported");
      if (availability !== "accepting_now") return [];
      if (!["recent", "power"].includes(sort)) throw new ProfileRequestError("sort is invalid");
      if (minVotingPower !== undefined) assertDecimal(minVotingPower, "minVotingPower");
      if (typeof repository.listProfiles !== "function") throw new TypeError("repository.listProfiles is required");
      const rows = [];
      let scanned = 0;
      while (scanned < DIRECTORY_CANDIDATE_LIMIT) {
        const profiles = await repository.listProfiles({
          dao: "nouns", availability: "accepting_now", limit: DIRECTORY_LIMIT, offset: scanned,
        });
        if (!Array.isArray(profiles)) throw new TypeError("repository.listProfiles must return an array");
        if (profiles.length > DIRECTORY_LIMIT) throw new TypeError("repository.listProfiles exceeded its requested limit");
        const page = (await Promise.all(profiles.map(async (profile, index) => {
          if (profile.availability !== "accepting_now") return null;
          const [policy, power, acceptingSubmissions, resolvedEns] = await Promise.all([
            repository.getPolicy(profile.id, "nouns"),
            indexClient.getVotingPower(profile.wallet),
            typeof repository.isProfileAccepting === "function"
              ? repository.isProfileAccepting(profile.id, "nouns").catch(() => false)
              : false,
            resolveEns(profile.wallet),
          ]);
          assertDecimal(power.amount, "governance power");
          const hasVotingPolicy = policy?.dao === "nouns" && policy.enabled === true
      && (policy.acceptPreVote === true || policy.acceptVoting === true);
          if (!hasVotingPolicy || acceptingSubmissions !== true
              || (minVotingPower !== undefined && BigInt(power.amount) < BigInt(minVotingPower))) return null;
          return {
            profile,
            result: publicProfile({ ...profile, acceptingSubmissions: true }, policy, power, resolvedEns),
            power: BigInt(power.amount),
            sequence: scanned + index,
          };
        }))).filter(Boolean);
        rows.push(...page);
        scanned += profiles.length;
        if (profiles.length < DIRECTORY_LIMIT || (sort === "recent" && rows.length >= DIRECTORY_LIMIT)) break;
      }
      rows.sort((left, right) => sort === "power"
        ? (left.power === right.power ? left.sequence - right.sequence : left.power > right.power ? -1 : 1)
        : (new Date(right.profile.updatedAt).getTime() - new Date(left.profile.updatedAt).getTime()
          || left.sequence - right.sequence));
      return rows.slice(0, DIRECTORY_LIMIT).map((row) => row.result);
    },

    async getPublicProfile(wallet) {
      if (typeof repository.getProfileByWallet !== "function") throw new TypeError("repository.getProfileByWallet is required");
      const canonicalWallet = address(wallet, "wallet");
      const profile = await repository.getProfileByWallet(canonicalWallet);
      return profile ? decorate(profile) : null;
    },

    async updateProfile({ session, gateEnrollmentProof, basePayoutControlProof, deliveryDestination } = {}) {
      if (!session || session.role !== "dao_profile") throw new ProfileRequestError("dao_profile session is required", 403, "FORBIDDEN");
      const sessionWallet = address(session.wallet, "session wallet");
      const message = exactMessage(gateEnrollmentProof, "GateEnrollment", ENROLLMENT_FIELDS);
      const enrollmentWallet = address(message.wallet, "GateEnrollment.wallet");
      if (sessionWallet !== enrollmentWallet) throw new ProfileRequestError("profile wallet mismatch", 403, "FORBIDDEN");
      const baseMessage = basePayoutControlProof === undefined
        ? null
        : exactMessage(basePayoutControlProof, "BasePayoutControl", BASE_FIELDS);
      if (baseMessage && address(baseMessage.wallet, "BasePayoutControl.wallet") !== sessionWallet) {
        throw new ProfileRequestError("profile wallet mismatch", 403, "FORBIDDEN");
      }
      if (message.purpose !== "enrollment" || message.dao !== "nouns" || String(message.daoChainId) !== "1"
          || typeof message.acceptPreVote !== "boolean" || typeof message.acceptVoting !== "boolean"
          || (!message.acceptPreVote && !message.acceptVoting) || String(message.version) !== "1"
          || !AVAILABILITY.has(message.availability)) throw new ProfileRequestError("GateEnrollment policy is invalid");
      assertDecimal(message.attentionAmount, "attentionAmount", 1_000_000n);
      if (deliveryDestination !== undefined) {
        if (typeof deliveryDestination !== "string" || deliveryDestination.length < 3
            || deliveryDestination.length > 254 || !deliveryDestination.includes("@")) {
          throw new ProfileRequestError("deliveryDestination is invalid");
        }
        if (typeof encryptDestination !== "function") {
          throw new ProfileRequestError("delivery encryption unavailable", 503, "SERVICE_UNAVAILABLE");
        }
      }

      const committed = await repository.withProfileTransaction(sessionWallet, async (transaction) => {
        if (!transaction || typeof transaction.getProfileByWallet !== "function" || typeof transaction.mutateProfile !== "function") {
          throw new TypeError("profile transaction methods are required");
        }
        const existing = await transaction.getProfileByWallet(sessionWallet);
        let verified;
        try {
          verified = await authService.verifyProfileProofs({
            session, gateEnrollmentProof, basePayoutControlProof, existingProfile: existing, transaction,
          });
        } catch {
          throw new ProfileRequestError("profile proof verification failed", 403, "FORBIDDEN");
        }
        if (!verified || address(verified.wallet, "verified wallet") !== sessionWallet
            || !["eoa", "contract"].includes(verified.walletKind)) throw new ProfileRequestError("profile proof verification failed", 403, "FORBIDDEN");

        let basePayoutCodeHash;
        let basePayoutVerifiedAt;
        const basePayoutProofRequired = verified.walletKind === "contract"
          && (!existing || (message.availability === "accepting_now" && existing.availability !== "accepting_now"));
        if (basePayoutProofRequired) {
          if (!baseMessage) throw new ProfileRequestError("BasePayoutControl proof is required");
          if (address(baseMessage.wallet, "BasePayoutControl.wallet") !== sessionWallet || baseMessage.dao !== "nouns"
              || baseMessage.purpose !== "base_payout_control" || String(baseMessage.version) !== "1") {
            throw new ProfileRequestError("Base payout proof is invalid", 403, "FORBIDDEN");
          }
          if (verified.basePayoutChainId !== configuredBaseChainId
              || typeof verified.basePayoutCodeHash !== "string"
              || !/^0x[0-9a-f]{64}$/.test(verified.basePayoutCodeHash)) {
            throw new ProfileRequestError("Base payout verification unavailable", 503, "SERVICE_UNAVAILABLE");
          }
          basePayoutCodeHash = verified.basePayoutCodeHash;
          basePayoutVerifiedAt = new Date(clock()).toISOString();
        }
        const policy = {
          dao: "nouns", chainId: "1", enabled: true,
          acceptPreVote: message.acceptPreVote, acceptVoting: message.acceptVoting,
          attentionAmount: message.attentionAmount,
          tags: Array.isArray(gateEnrollmentProof.publicTags) ? structuredClone(gateEnrollmentProof.publicTags) : [],
        };
        const profileId = existing?.id || sessionWallet;
        let deliveryEnvelope;
        if (deliveryDestination !== undefined) {
          try { deliveryEnvelope = await encryptDestination(profileId, deliveryDestination); }
          catch { throw new ProfileRequestError("delivery encryption unavailable", 503, "SERVICE_UNAVAILABLE"); }
          if (typeof deliveryEnvelope !== "string" || deliveryEnvelope.length > 1024
              || !/^gg1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(deliveryEnvelope)) {
            throw new ProfileRequestError("delivery encryption unavailable", 503, "SERVICE_UNAVAILABLE");
          }
          if (typeof transaction.setDeliverySetting !== "function") {
            throw new TypeError("profile transaction setDeliverySetting is required");
          }
        }
        const profile = await transaction.mutateProfile({
          profile: {
            id: profileId, wallet: sessionWallet, walletKind: verified.walletKind,
            walletKindAuthoritative: true, availability: message.availability,
            ...(gateEnrollmentProof.publicDisplay !== undefined ? { display: publicDisplay(gateEnrollmentProof.publicDisplay) } : {}),
            ...(basePayoutCodeHash ? { basePayoutCodeHash, basePayoutVerifiedAt } : {}),
          },
          policy,
        });
        if (deliveryEnvelope !== undefined) await transaction.setDeliverySetting(profileId, deliveryEnvelope);
        await authService.consumeProfileProofs({ ...verified, transaction });
        return { profile, policy };
      });
      try { return await decorate(committed.profile, committed.policy); }
      catch { return publicProfile(committed.profile, committed.policy, null); }
    },
  });
}

module.exports = {
  BASE_FIELDS,
  ENROLLMENT_FIELDS,
  ProfileRequestError,
  createProfileService,
  publicProfile,
};
