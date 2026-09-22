/**
 * The DAO catalog: what Gavel can follow, and what each DAO can actually do.
 *
 * Two things were previously implicit and are now declared here:
 *
 *   1. The set of governance systems Gavel supports. The CLI kept a private
 *      `SUPPORTED_DAOS` array, the index client kept another, and the TUI kept
 *      none at all because it assumed one DAO. All three now read this.
 *
 *   2. What differs between them. A DAO's delegation model, the word it uses
 *      for voting power, whether a Safe can be a proposer -- these are facts
 *      about the DAO, so a client that wants to stay DAO-agnostic has to be
 *      able to ask rather than assume.
 *
 * A descriptor is *static* data: it needs no RPC, no provider and no network,
 * which is what lets the onboarding wizard list DAOs before anything is
 * configured. Live capability is a different question, answered by readiness.
 *
 * This module deliberately imports nothing. Core must not depend on a DAO
 * adapter (see test/architecture-boundaries.test.js), so the mapping from a
 * catalog id to a constructed adapter lives in `@gavel/daos`, outside core.
 * `assertDescriptorMatchesAdapter()` below is how the two are kept honest.
 */

/**
 * Capability keys.
 *
 * `analyze`/`predict`/`prepareVote`/`safeSupervised`/`waapAutonomous` mirror a
 * DAO adapter's own `capabilities` object one-for-one and are asserted equal in
 * tests. The rest describe things a *client* needs to know to render a DAO
 * without guessing.
 */
const DaoCapability = Object.freeze({
  PROPOSALS: "proposals",
  VOTING: "voting",
  DELEGATION: "delegation",
  CALENDAR: "calendar",
  VOTING_POWER_QUERIES: "votingPowerQueries",
  PROPOSAL_DECODING: "proposalDecoding",
  PRIVATE_VOTING: "privateVoting",
  ANALYZE: "analyze",
  PREDICT: "predict",
  PREPARE_VOTE: "prepareVote",
  EOA_SUPERVISED: "eoaSupervised",
  SAFE_SUPERVISED: "safeSupervised",
  WAAP_AUTONOMOUS: "waapAutonomous",
});

/** The subset an adapter declares for itself. Kept in sync by assertion. */
const ADAPTER_DECLARED_CAPABILITIES = Object.freeze([
  DaoCapability.ANALYZE,
  DaoCapability.PREDICT,
  DaoCapability.PREPARE_VOTE,
  DaoCapability.EOA_SUPERVISED,
  DaoCapability.SAFE_SUPERVISED,
  DaoCapability.WAAP_AUTONOMOUS,
]);

const CAPABILITY_KEYS = Object.freeze(Object.values(DaoCapability));

/**
 * Per-DAO wording.
 *
 * The generic UI says "Voting power". When one DAO is in view it says what that
 * DAO says, because "Votes" and "Voting power" and "Staked voting power" are
 * not the same quantity and a governance client that blurs them is lying.
 */
function terminology(overrides = {}) {
  return Object.freeze({
    votingPower: "Voting power",
    delegation: "Delegation",
    delegate: "Delegate",
    proposal: "Proposal",
    identity: "Governance identity",
    ...overrides,
  });
}

/**
 * No adapter exposes a governance-calendar feed today, so `calendar` is false
 * everywhere. It is declared rather than omitted so the capability exists the
 * day one adapter implements it, and so the UI already branches on it.
 */
const DAO_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: "nouns",
    displayName: "Nouns",
    network: "Ethereum",
    chainId: 1,
    status: "supported",
    summary: "Nouns DAO governance on Ethereum mainnet.",
    terminology: terminology({
      votingPower: "Votes",
      delegation: "Delegated votes",
      delegate: "Delegated to",
    }),
    capabilities: Object.freeze({
      proposals: true,
      voting: true,
      delegation: true,
      calendar: false,
      votingPowerQueries: true,
      proposalDecoding: true,
      privateVoting: false,
      analyze: true,
      predict: true,
      prepareVote: true,
      eoaSupervised: true,
      safeSupervised: true,
      waapAutonomous: true,
    }),
  }),
  Object.freeze({
    id: "ens",
    displayName: "ENS",
    network: "Ethereum",
    chainId: 1,
    status: "supported",
    summary: "ENS DAO governance (OpenZeppelin Governor) on Ethereum mainnet.",
    terminology: terminology({
      votingPower: "Voting power",
      delegation: "Delegation",
      delegate: "Delegate",
    }),
    capabilities: Object.freeze({
      proposals: true,
      voting: true,
      delegation: true,
      calendar: false,
      votingPowerQueries: true,
      proposalDecoding: true,
      privateVoting: false,
      analyze: true,
      predict: true,
      prepareVote: true,
      eoaSupervised: true,
      safeSupervised: true,
      waapAutonomous: false,
    }),
  }),
  Object.freeze({
    id: "railgun-eth",
    displayName: "Railgun",
    network: "Ethereum",
    chainId: 1,
    status: "supported",
    // Railgun votes by staked amount through a voting key, and successive
    // partial votes on one proposal are legitimate. Forcing it into a
    // one-vote/one-delegate model is exactly the Nouns assumption this
    // catalog exists to remove.
    summary: "Railgun governance on Ethereum mainnet; votes are cast by staked amount.",
    terminology: terminology({
      votingPower: "Staked voting power",
      delegation: "Voting key",
      delegate: "Voting key",
    }),
    capabilities: Object.freeze({
      proposals: true,
      voting: true,
      delegation: true,
      calendar: false,
      votingPowerQueries: true,
      proposalDecoding: true,
      privateVoting: false,
      analyze: true,
      predict: true,
      prepareVote: true,
      eoaSupervised: true,
      safeSupervised: false,
      waapAutonomous: false,
    }),
  }),
]);

const DESCRIPTORS_BY_ID = new Map(DAO_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

function listDaoDescriptors() {
  return DAO_DESCRIPTORS;
}

function listDaoIds() {
  return DAO_DESCRIPTORS.map((descriptor) => descriptor.id);
}

function isKnownDao(id) {
  return DESCRIPTORS_BY_ID.has(String(id || ""));
}

function findDaoDescriptor(id) {
  return DESCRIPTORS_BY_ID.get(String(id || "")) || null;
}

function getDaoDescriptor(id) {
  const descriptor = findDaoDescriptor(id);
  if (!descriptor) {
    throw new Error(`Unknown DAO: ${id}. Known DAOs: ${listDaoIds().join(", ")}`);
  }
  return descriptor;
}

function daoDisplayName(id) {
  return findDaoDescriptor(id)?.displayName || String(id || "");
}

/** The DAO's own word for a generic concept, falling back to the generic one. */
function daoTerm(id, key) {
  const descriptor = findDaoDescriptor(id);
  const fallback = terminology()[key];
  if (!descriptor) return fallback;
  return descriptor.terminology[key] ?? fallback;
}

function daoSupports(id, capability) {
  const descriptor = findDaoDescriptor(id);
  if (!descriptor) return false;
  return descriptor.capabilities[capability] === true;
}

/** Which of the known DAOs can do `capability`. Used to filter UI offers. */
function daosSupporting(capability) {
  return DAO_DESCRIPTORS.filter((descriptor) => descriptor.capabilities[capability] === true);
}

/**
 * The capability matrix, as rows a client can render without knowing any DAO.
 */
function daoCapabilityMatrix(ids = listDaoIds()) {
  return ids.map((id) => {
    const descriptor = getDaoDescriptor(id);
    return {
      id: descriptor.id,
      displayName: descriptor.displayName,
      capabilities: CAPABILITY_KEYS.map((capability) => ({
        capability,
        supported: descriptor.capabilities[capability] === true,
      })),
    };
  });
}

/**
 * Keep a descriptor and its adapter from drifting.
 *
 * Core cannot import an adapter, so this is the inverse: hand core an adapter
 * and it checks the catalog told the truth about it. `@gavel/daos` calls it
 * when it builds a registry, and a test calls it for every catalog entry.
 */
function assertDescriptorMatchesAdapter(adapter) {
  const descriptor = getDaoDescriptor(adapter?.id);
  if (Number(adapter.chainId) !== descriptor.chainId) {
    throw new Error(
      `DAO catalog says ${descriptor.id} is on chain ${descriptor.chainId}, adapter reports ${adapter.chainId}`,
    );
  }
  for (const capability of ADAPTER_DECLARED_CAPABILITIES) {
    const declared = adapter.capabilities?.[capability] === true;
    const catalogued = descriptor.capabilities[capability] === true;
    if (declared !== catalogued) {
      throw new Error(
        `DAO catalog and ${descriptor.id} adapter disagree about ${capability}: ` +
          `catalog=${catalogued} adapter=${declared}`,
      );
    }
  }
  return descriptor;
}

/**
 * Normalize a user-supplied list of DAO ids.
 *
 * Deduplicates, preserves catalog order so two users with the same DAOs get the
 * same config bytes, and reports unknown ids rather than dropping them
 * silently -- a typo that quietly stops following a DAO is a governance bug.
 */
function normalizeDaoSelection(ids = []) {
  if (!Array.isArray(ids)) throw new TypeError("DAO selection must be an array");
  const requested = ids.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean);
  const unknown = [...new Set(requested.filter((id) => !isKnownDao(id)))];
  const selected = listDaoIds().filter((id) => requested.includes(id));
  return { selected, unknown };
}

module.exports = {
  ADAPTER_DECLARED_CAPABILITIES,
  CAPABILITY_KEYS,
  DAO_DESCRIPTORS,
  DaoCapability,
  assertDescriptorMatchesAdapter,
  daoCapabilityMatrix,
  daoDisplayName,
  daoSupports,
  daoTerm,
  daosSupporting,
  findDaoDescriptor,
  getDaoDescriptor,
  isKnownDao,
  listDaoDescriptors,
  listDaoIds,
  normalizeDaoSelection,
};
