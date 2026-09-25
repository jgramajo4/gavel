const { keccak256, toUtf8Bytes } = require("ethers");
const { adaptNounsGateLifecycle, parseNounsCandidateTargetId } = require("@gavel/gate");
const { ProposalIdentityError, assertCanonicalProposalIdentity } = require("@gavel/proposal-identity");

const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const { canonicalGateActions } = require("../../../governance-index/src/gate-action");

class IndexUnavailableError extends Error {
  constructor(message = "Nouns governance index is unavailable") {
    super(message);
    this.name = "IndexUnavailableError";
    this.code = "INDEX_UNAVAILABLE";
    this.statusCode = 503;
  }
}

class IndexIdentityMismatchError extends Error {
  constructor(message = "Canonical proposal identity mismatch") {
    super(message);
    this.name = "IndexIdentityMismatchError";
    this.code = "PROPOSAL_IDENTITY_MISMATCH";
    this.statusCode = 409;
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IndexUnavailableError(`${name} is invalid`);
  return value;
}
function decimal(value, name) {
  if (typeof value !== "string" || !UINT.test(value)) throw new IndexUnavailableError(`${name} is invalid`);
  return value;
}
function hash(value, name) {
  if (typeof value !== "string" || !BYTES32.test(value)) throw new IndexUnavailableError(`${name} is invalid`);
  return value.toLowerCase();
}
function timestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new IndexUnavailableError(`${name} is invalid`);
  return new Date(value).toISOString();
}

function createNounsIndexClient({ source, clock = () => new Date(), freshnessMs = DEFAULT_FRESHNESS_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, observability } = {}) {
  if (!source || typeof source.getHealth !== "function"
      || (typeof source.getProposal !== "function" && typeof source.getTarget !== "function")) {
    throw new TypeError("source.getHealth and a target reader are required");
  }
  if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) throw new TypeError("freshnessMs must be positive");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10_000) {
    throw new TypeError("requestTimeoutMs must be an integer from 1 to 10000");
  }
  if (observability !== undefined && typeof observability?.gauge !== "function") {
    throw new TypeError("observability.gauge must be a function");
  }
  const reportFreshness = (age, health) => {
    try { if (Number.isFinite(age) && age >= 0) observability?.gauge("gate_dao_freshness_age_seconds", age / 1000, { health }); } catch {}
  };

  async function assertFresh(value, name) {
    const row = requireObject(value, name);
    const refreshedAt = timestamp(row.refreshedAt, `${name}.refreshedAt`);
    const age = new Date(clock()).getTime() - Date.parse(refreshedAt);
    if (row.healthy !== true || row.lastError) {
      reportFreshness(age, "unhealthy");
      throw new IndexUnavailableError();
    }
    if (!Number.isFinite(age) || age < 0 || age > freshnessMs) {
      reportFreshness(age, "stale");
      throw new IndexUnavailableError();
    }
    reportFreshness(age, "healthy");
    return refreshedAt;
  }
  async function readSource(read) {
    let timer;
    const controller = new AbortController();
    try {
      return await Promise.race([
        Promise.resolve().then(() => read(controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new IndexUnavailableError();
            controller.abort(error);
            reject(error);
          }, requestTimeoutMs);
        }),
      ]);
    }
    catch (error) {
      if (error instanceof IndexUnavailableError || error instanceof IndexIdentityMismatchError) throw error;
      throw new IndexUnavailableError();
    }
    finally { clearTimeout(timer); }
  }

  async function readTarget(targetId, { eligibleOnly }) {
    let identity;
    try { identity = parseNounsCandidateTargetId(targetId); }
    catch { throw new IndexUnavailableError("candidate target identity is invalid"); }
    if (typeof source.getTarget !== "function") throw new IndexUnavailableError("candidate target source is unavailable");
    await assertFresh(await readSource((signal) => source.getHealth("nouns", { signal })), "index health");
    const target = requireObject(await readSource((signal) => source.getTarget("nouns", targetId, { signal })), "candidate target");
    if (typeof target.slug !== "string"
        || target.dao !== "nouns" || target.targetId !== targetId || target.kind !== "candidate"
        || String(target.proposer).toLowerCase() !== identity.proposer
        || keccak256(toUtf8Bytes(target.slug)).toLowerCase() !== identity.slugHash
        || target.slugHash !== undefined && target.slugHash !== identity.slugHash) {
      throw new IndexIdentityMismatchError("candidate target identity mismatch");
    }
    const refreshedAt = await assertFresh({ healthy: true, refreshedAt: target.refreshedAt }, "candidate target");
    if (target.mappingVersion !== "nouns-candidate-lifecycle/1"
        || !(["ACTIVE", "CANCELED"].includes(target.nativeState))
        || !(["PRE_VOTE", "CLOSED"].includes(target.eligibility))
        || (target.nativeState === "CANCELED" && target.eligibility !== "CLOSED")
        || (eligibleOnly && (target.nativeState !== "ACTIVE" || target.eligibility !== "PRE_VOTE"))) {
      throw new IndexUnavailableError("candidate target is not PRE_VOTE eligible");
    }
    if (!Array.isArray(target.actions)) throw new IndexUnavailableError("candidate actions are invalid");
    return {
      dao: "nouns", targetId, kind: "candidate", proposer: identity.proposer, slug: target.slug,
      nativeState: target.nativeState, eligibility: target.eligibility, mappingVersion: target.mappingVersion,
      refreshedAt, sourceBlock: decimal(target.sourceBlock, "candidate.sourceBlock"),
      sourceBlockHash: hash(target.sourceBlockHash, "candidate.sourceBlockHash"),
      contentHash: hash(target.contentHash, "candidate.contentHash"),
      canonicalActions: (() => {
        try { return canonicalGateActions(target.actions, { exact: true }); }
        catch { throw new IndexUnavailableError("candidate action is invalid"); }
      })(),
    };
  }

  return Object.freeze({
    getTargetSnapshot: (targetId) => readTarget(targetId, { eligibleOnly: true }),
    getTargetLifecycle: async (targetId) => (await readTarget(targetId, { eligibleOnly: false })).eligibility,
    async getVotingPower(wallet) {
      if (typeof source.getVotingPower !== "function") throw new IndexUnavailableError("voting power source is unavailable");
      if (typeof wallet !== "string" || !ADDRESS.test(wallet)) throw new TypeError("wallet must be an Ethereum address");
      const canonicalWallet = wallet.toLowerCase();
      await assertFresh(await readSource((signal) => source.getHealth("nouns", { signal })), "index health");
      const power = requireObject(await readSource((signal) => source.getVotingPower("nouns", canonicalWallet, { signal })), "voting power");
      if (power.dao !== "nouns" || String(power.wallet).toLowerCase() !== canonicalWallet) {
        throw new IndexUnavailableError("voting power identity mismatch");
      }
      const asOf = timestamp(power.asOf, "votingPower.asOf");
      const age = new Date(clock()).getTime() - Date.parse(asOf);
      if (!Number.isFinite(age) || age < 0 || age > freshnessMs) {
        reportFreshness(age, "stale");
        throw new IndexUnavailableError();
      }
      reportFreshness(age, "healthy");
      return {
        dao: "nouns",
        amount: decimal(power.amount, "votingPower.amount"),
        asOf,
        sourceBlock: decimal(power.sourceBlock, "votingPower.sourceBlock"),
        sourceBlockHash: hash(power.sourceBlockHash, "votingPower.sourceBlockHash"),
      };
    },
    async getProposalSnapshot(proposalId) {
      const id = decimal(String(proposalId), "proposalId");
      await assertFresh(await readSource((signal) => source.getHealth("nouns", { signal })), "index health");
      const proposal = requireObject(await readSource((signal) => source.getProposal("nouns", id, { signal })), "proposal");
      try {
        assertCanonicalProposalIdentity(
          { dao: proposal.dao, chainId: proposal.chainId, governorAddress: proposal.governorAddress, proposalId: proposal.proposalId },
          { dao: "nouns", chainId: 1, governorAddress: "0x6f3E6272A167e8AcCb32072d08E0957F9c79223d", proposalId: id },
        );
      } catch (error) {
        if (error instanceof ProposalIdentityError) throw new IndexIdentityMismatchError();
        throw error;
      }
      const refreshedAt = await assertFresh({ healthy: true, refreshedAt: proposal.refreshedAt }, "proposal");
      if (!Array.isArray(proposal.actions)) throw new IndexUnavailableError("proposal actions are invalid");
      const nativeState = proposal.effectiveStatus;
      const lifecycle = adaptNounsGateLifecycle(nativeState);
      return {
        dao: "nouns",
        chainId: proposal.chainId,
        governorAddress: proposal.governorAddress,
        proposalId: id,
        nativeState,
        ...lifecycle,
        refreshedAt,
        sourceBlock: decimal(proposal.sourceBlock, "proposal.sourceBlock"),
        sourceBlockHash: hash(proposal.sourceBlockHash, "proposal.sourceBlockHash"),
        contentHash: hash(proposal.contentHash, "proposal.contentHash"),
        canonicalActions: (() => {
          try { return canonicalGateActions(proposal.actions, { exact: true }); }
          catch { throw new IndexUnavailableError("proposal action is invalid"); }
        })(),
      };
    },
  });
}

module.exports = {
  DEFAULT_FRESHNESS_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  IndexIdentityMismatchError,
  IndexUnavailableError,
  createNounsIndexClient,
};
