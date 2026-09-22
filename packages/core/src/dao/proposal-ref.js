/**
 * Proposal identity across DAOs.
 *
 * Proposal ids are per-DAO counters. Nouns #12 and ENS #12 are different
 * proposals that would collide in any structure keyed by id alone -- a React
 * list key, a "seen" set, a recommendation cache. A single-DAO client could
 * ignore that. A multi-DAO one cannot, so the composite `(dao, proposalId)` is
 * the only identity Gavel uses internally.
 *
 * The reference is also the only place the id's *type* is settled: ENS and
 * Railgun proposal ids are 256-bit and do not survive `Number()`, so ids are
 * decimal strings everywhere.
 */

const { findDaoDescriptor, getDaoDescriptor } = require("./catalog");

const DAO_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const PROPOSAL_ID_PATTERN = /^\d+$/;

function normalizeProposalId(value) {
  // Accepts a bigint, a number, or a decimal string, and always yields a
  // decimal string. An ENS proposal id is a uint256 hash; `Number()` on it
  // silently loses precision, which is why nothing here goes through Number.
  if (typeof value === "bigint") {
    if (value < 0n) throw new TypeError("A proposal id must not be negative");
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("A numeric proposal id must be a safe non-negative integer");
    }
    return String(value);
  }
  const text = String(value ?? "").trim();
  if (!PROPOSAL_ID_PATTERN.test(text)) throw new TypeError(`Invalid proposal id: ${value}`);
  // Strip leading zeros so "007" and "7" are one proposal, not two.
  return text.replace(/^0+(?=\d)/, "");
}

/**
 * A composite proposal reference.
 *
 * `chainId` is carried because the same DAO id on a different chain is a
 * different governance system, and a client that shows a vote target without a
 * chain is one config mistake away from acting on the wrong one.
 */
function daoProposalRef(dao, proposalId) {
  const daoId = String(dao || "").trim().toLowerCase();
  if (!DAO_ID_PATTERN.test(daoId)) throw new TypeError(`Invalid DAO id: ${dao}`);
  const descriptor = findDaoDescriptor(daoId);
  return Object.freeze({
    dao: daoId,
    proposalId: normalizeProposalId(proposalId),
    chainId: descriptor ? descriptor.chainId : null,
    displayName: descriptor ? descriptor.displayName : daoId,
  });
}

/** The stable key: `dao:proposalId`. Safe as a map key, a filename, a React key. */
function daoProposalKey(refOrDao, maybeProposalId) {
  const ref =
    maybeProposalId === undefined ? refOrDao : daoProposalRef(refOrDao, maybeProposalId);
  if (!ref?.dao || ref.proposalId === undefined) throw new TypeError("A proposal reference is required");
  return `${ref.dao}:${normalizeProposalId(ref.proposalId)}`;
}

function parseDaoProposalKey(key) {
  const text = String(key || "");
  const separator = text.indexOf(":");
  if (separator <= 0) throw new TypeError(`Invalid proposal key: ${key}`);
  return daoProposalRef(text.slice(0, separator), text.slice(separator + 1));
}

function sameDaoProposal(left, right) {
  try {
    return daoProposalKey(left) === daoProposalKey(right);
  } catch {
    return false;
  }
}

/**
 * What a user reads: `Nouns #812`, `ENS #3`.
 *
 * Always carries the DAO name. Keeping the DAO visible on every proposal line
 * is a safety property, not decoration: a user must never be one glance away
 * from voting in the wrong governance system.
 */
function formatDaoProposal(refOrDao, maybeProposalId) {
  const ref =
    maybeProposalId === undefined ? refOrDao : daoProposalRef(refOrDao, maybeProposalId);
  const name = findDaoDescriptor(ref.dao)?.displayName || ref.dao;
  return `${name} #${normalizeProposalId(ref.proposalId)}`;
}

/** Throws unless the DAO is one the catalog knows -- the BYOH runtime check. */
function assertKnownDaoProposal(refOrDao, maybeProposalId) {
  const ref = maybeProposalId === undefined ? refOrDao : daoProposalRef(refOrDao, maybeProposalId);
  getDaoDescriptor(ref.dao);
  return ref;
}

module.exports = {
  assertKnownDaoProposal,
  daoProposalKey,
  daoProposalRef,
  formatDaoProposal,
  normalizeProposalId,
  parseDaoProposalKey,
  sameDaoProposal,
};
