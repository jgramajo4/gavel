const { sanitizeConfig, sanitizeProvenance } = require("./provenance");
const { redactErrorMessage } = require("./redaction");

function chainEventKey(row) {
  return `${row.chainId}:${String(row.contractAddress).toLowerCase()}:${String(row.transactionHash).toLowerCase()}:${row.logIndex}`;
}
function eventKey(row) {
  return row.sourceRecordKey ? `${row.daoId}:${row.sourceId}:${row.sourceRecordKey}` : chainEventKey(row);
}
function compareCursor(a, b) {
  const ab = BigInt(a.blockNumber || 0); const bb = BigInt(b.blockNumber || 0);
  if (ab !== bb) return ab < bb ? -1 : 1;
  const transaction = String(a.transactionHash || "").toLowerCase().localeCompare(String(b.transactionHash || "").toLowerCase());
  return transaction || Number(a.logIndex || 0) - Number(b.logIndex || 0);
}
function encodeCursor(row) {
  return Buffer.from(JSON.stringify([String(row.blockNumber), String(row.transactionHash).toLowerCase(), Number(row.logIndex || 0)])).toString("base64url");
}
function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!Array.isArray(parsed) || parsed.length !== 3 || !/^\d+$/.test(parsed[0]) || !/^0x[0-9a-f]{64}$/.test(parsed[1]) || !Number.isSafeInteger(parsed[2]) || parsed[2] < 0) throw new Error();
    return { blockNumber: parsed[0], transactionHash: parsed[1], logIndex: parsed[2] };
  } catch { throw new TypeError("invalid cursor"); }
}
function encodeProposalCursor(id) { return Buffer.from(JSON.stringify(["proposal", String(id)])).toString("base64url"); }
function decodeProposalCursor(value) {
  if (!value) return null;
  try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString()); if (parsed[0] !== "proposal" || !/^\d+$/.test(parsed[1])) throw new Error(); return parsed[1]; }
  catch { throw new TypeError("invalid cursor"); }
}
const TERMINAL_PROPOSAL_STATES = new Set(["EXECUTED", "CANCELLED", "CANCELED", "VETOED", "EXPIRED", "DEFEATED", "SPONSORSHIP_EXPIRED"]);
function canonicalMaterial(row) { return JSON.stringify({ blockNumber: String(row.blockNumber), blockHash: row.blockHash || null, recordType: row.recordType, proposalId: row.proposalId || null, contentHash: row.contentHash || null, payload: row.payload }); }
function immutableEventMaterial(row) { return JSON.stringify({ recordType: row.recordType, proposalId: row.proposalId || null, contentHash: row.contentHash || null, payload: row.payload }); }

class MemoryGovernanceStore {
  constructor() { this.daos = new Map(); this.sources = new Map(); this.rawRecords = []; this.proposals = []; this.proposalActions = []; this.voteEvents = []; this.delegationEvents = []; this.checkpoints = new Map(); this._keys = new Set(); this._locks = new Map(); }
  async transaction(callback) {
    const snapshot = structuredClone({ daos: this.daos, sources: this.sources, rawRecords: this.rawRecords, proposals: this.proposals, proposalActions: this.proposalActions, voteEvents: this.voteEvents, delegationEvents: this.delegationEvents, checkpoints: this.checkpoints, keys: this._keys });
    try { return await callback(this); } catch (error) { Object.assign(this, { ...snapshot, _keys: snapshot.keys }); throw error; }
  }
  async withSourceLock(daoId, sourceId, callback) {
    const key = `${daoId}:${sourceId}`; const previous = this._locks.get(key) || Promise.resolve();
    let release; const current = new Promise((resolve) => { release = resolve; }); this._locks.set(key, current);
    await previous;
    try { return await callback(); } finally { release(); if (this._locks.get(key) === current) this._locks.delete(key); }
  }
  upsertDao(row) { this.daos.set(row.id, sanitizeConfig({ ...this.daos.get(row.id), ...row })); }
  upsertSource(row) { this.sources.set(`${row.daoId}:${row.id}`, sanitizeProvenance({ ...this.sources.get(`${row.daoId}:${row.id}`), ...row })); }
  getCheckpoint(daoId, sourceId) { return this.checkpoints.get(`${daoId}:${sourceId}`) || null; }
  setCheckpoint(row) {
    row = { ...row, lastError: row.lastError == null ? null : redactErrorMessage(row.lastError) };
    const key = `${row.daoId}:${row.sourceId}`; const existing = this.checkpoints.get(key);
    if (existing && BigInt(row.nextBlock) < BigInt(existing.nextBlock)) {
      this.checkpoints.set(key, { ...existing, updatedAt: row.updatedAt, lastError: row.lastError, lastFullScanAt: row.lastFullScanAt || existing.lastFullScanAt || null });
      return;
    }
    this.checkpoints.set(key, { ...existing, ...row, lastFullScanAt: row.lastFullScanAt || existing?.lastFullScanAt || null });
  }
  upsertProposal(row) {
    const index = this.proposals.findIndex((x) => x.daoId === row.daoId && x.proposalId === row.proposalId);
    if (index < 0) this.proposals.push({ ...row }); else this.proposals[index] = { ...this.proposals[index], ...row };
    if (row.actions) {
      this.proposalActions = this.proposalActions.filter((x) => !(x.daoId === row.daoId && x.proposalId === row.proposalId));
      this.proposalActions.push(...row.actions.map((action) => ({ daoId: row.daoId, proposalId: row.proposalId, ...action })));
    }
  }
  insertVote(row) { const safe = sanitizeProvenance(row); const key = eventKey({ ...safe, contractAddress: safe.contractAddress || "" }); if (this._keys.has(`v:${key}`)) return false; this._keys.add(`v:${key}`); this.voteEvents.push(safe); return true; }
  insertDelegation(row) { const safe = sanitizeProvenance(row); const key = eventKey(safe); if (this._keys.has(`d:${key}`)) return false; this._keys.add(`d:${key}`); this.delegationEvents.push(safe); return true; }
  ingest(record) {
    const raw = sanitizeProvenance({ ...record.raw, proposalId: record.raw.proposalId || record.proposal?.proposalId || record.vote?.proposalId || null, contentHash: record.raw.contentHash || record.proposal?.contentHash || null }); const key = eventKey(raw);
    const existing = this.rawRecords.find((x) => eventKey(x) === key);
    if (existing) {
      if (canonicalMaterial(existing) !== canonicalMaterial(raw)) throw new Error(`canonical event drift for ${key}`);
      if (record.proposal) this.upsertProposal(record.proposal);
      // Repair normalized rows that an earlier partial write dropped.
      if (record.vote) this.insertVote(record.vote);
      if (record.delegation) this.insertDelegation(record.delegation);
      return false;
    }
    this._keys.add(`r:${key}`); this.rawRecords.push(raw);
    if (record.proposal) this.upsertProposal(record.proposal);
    if (record.vote) this.insertVote(record.vote);
    if (record.delegation) this.insertDelegation(record.delegation);
    return true;
  }
  reconcileRange({ daoId, sourceId, fromBlock, toBlock, records }) {
    const incoming = new Map(records.map((record) => { const row = sanitizeProvenance({ ...record.raw, proposalId: record.raw.proposalId || record.proposal?.proposalId || record.vote?.proposalId || null, contentHash: record.raw.contentHash || record.proposal?.contentHash || null }); return [eventKey(row), row]; }));
    for (const existing of this.rawRecords) { const next = incoming.get(eventKey(existing)); if (next && immutableEventMaterial(existing) !== immutableEventMaterial(next)) throw new Error(`canonical event drift for ${eventKey(existing)}`); }
    const movedKeys = new Set(this.rawRecords.filter((row) => { const next = incoming.get(eventKey(row)); return next && (String(row.blockNumber) !== String(next.blockNumber) || (row.blockHash || null) !== (next.blockHash || null)); }).map(eventKey));
    const inRange = (row) => row.daoId === daoId && row.sourceId === sourceId && !(row.recordType === "proposal" && row.sourceRecordKey) && ((BigInt(row.blockNumber) >= BigInt(fromBlock) && BigInt(row.blockNumber) <= BigInt(toBlock)) || movedKeys.has(eventKey(row)));
    const removed = this.rawRecords.filter(inRange); const removedKeys = new Set(removed.map(eventKey));
    const removedChainKeys = new Set(removed.filter((row) => row.transactionHash != null && row.logIndex != null).map(chainEventKey));
    const removedSourceKeys = new Set(removed.filter((row) => row.sourceRecordKey).map(eventKey));
    this.rawRecords = this.rawRecords.filter((row) => !inRange(row));
    this.voteEvents = this.voteEvents.filter((row) => !removedSourceKeys.has(eventKey(row)) && !removedChainKeys.has(chainEventKey(row)));
    this.delegationEvents = this.delegationEvents.filter((row) => !removedChainKeys.has(chainEventKey(row)));
    const proposalIds = new Set(removed.filter((row) => row.recordType === "proposal" && row.proposalId).map((row) => row.proposalId));
    for (const id of proposalIds) if (!this.rawRecords.some((row) => row.daoId === daoId && row.recordType === "proposal" && row.proposalId === id)) {
      this.proposals = this.proposals.filter((row) => !(row.daoId === daoId && row.proposalId === id));
      this.proposalActions = this.proposalActions.filter((row) => !(row.daoId === daoId && row.proposalId === id));
    }
    for (const key of removedKeys) this._keys.delete(`r:${key}`);
    for (const key of removedSourceKeys) this._keys.delete(`v:${key}`);
    for (const prefix of ["v", "d"]) for (const key of removedChainKeys) this._keys.delete(`${prefix}:${key}`);
  }
  reconcileProposals({ daoId, sourceId, records }) {
    const incoming = new Map(records.map((record) => [eventKey(record.raw), sanitizeProvenance({ ...record.raw, proposalId: record.raw.proposalId || record.proposal?.proposalId || null, contentHash: record.raw.contentHash || record.proposal?.contentHash || null })]));
    const existing = this.rawRecords.filter((row) => row.daoId === daoId && row.sourceId === sourceId && row.recordType === "proposal" && row.sourceRecordKey);
    for (const row of existing) { const next = incoming.get(eventKey(row)); if (next && canonicalMaterial(row) !== canonicalMaterial(next)) throw new Error(`canonical event drift for ${eventKey(row)}`); }
    const orphans = existing.filter((row) => !incoming.has(eventKey(row)));
    const orphanKeys = new Set(orphans.map(eventKey));
    this.rawRecords = this.rawRecords.filter((row) => !orphanKeys.has(eventKey(row)));
    for (const row of orphans) {
      this._keys.delete(`r:${eventKey(row)}`);
      if (!this.rawRecords.some((candidate) => candidate.daoId === daoId && candidate.recordType === "proposal" && candidate.proposalId === row.proposalId)) {
        this.proposals = this.proposals.filter((proposal) => !(proposal.daoId === daoId && proposal.proposalId === row.proposalId));
        this.proposalActions = this.proposalActions.filter((action) => !(action.daoId === daoId && action.proposalId === row.proposalId));
      }
    }
  }
  getProposalSyncContext(daoId) {
    const rows = this.proposals.filter((row) => row.daoId === daoId);
    const maxProposalId = rows.reduce((max, row) => (max == null || BigInt(row.proposalId) > BigInt(max) ? row.proposalId : max), null);
    const refreshProposals = rows
      .filter((row) => !TERMINAL_PROPOSAL_STATES.has(String(row.normalized?.state || "").toUpperCase()))
      .map((row) => ({ proposalId: row.proposalId, contentHash: row.contentHash, normalized: row.normalized }));
    return { maxProposalId, refreshProposals };
  }

  async listDaos() { return [...this.daos.values()].sort((a,b) => a.id.localeCompare(b.id)); }
  async getDao(id) { return this.daos.get(id) || null; }
  async getProposal(daoId, proposalId) { return this.proposals.find((x) => x.daoId === daoId && x.proposalId === proposalId)?.normalized || null; }
  async listProposals({ daoId, limit, cursor }) {
    const decoded = typeof cursor === "string" && !/^\d+$/.test(cursor) ? decodeProposalCursor(cursor) : cursor;
    let rows = this.proposals.filter((x) => x.daoId === daoId).sort((a,b) => BigInt(a.proposalId) < BigInt(b.proposalId) ? 1 : -1);
    if (decoded) rows = rows.filter((x) => BigInt(x.proposalId) < BigInt(decoded));
    const selected = rows.slice(0, limit); return { items: selected.map((row) => row.normalized), nextCursor: rows.length > limit ? encodeProposalCursor(selected.at(-1).proposalId) : null };
  }
  async listVotes({ daoId, voter, limit, cursor }) {
    const decoded = typeof cursor === "string" ? decodeCursor(cursor) : cursor;
    let rows = this.voteEvents.filter((x) => x.daoId === daoId && (!voter || x.voter.toLowerCase() === voter.toLowerCase())).sort(compareCursor);
    if (decoded) rows = rows.filter((x) => compareCursor(x, decoded) > 0);
    const items = rows.slice(0, limit); return { items, nextCursor: rows.length > limit ? encodeCursor(items.at(-1)) : null };
  }
  async status() { return { daos: this.daos.size, proposals: this.proposals.length, votes: this.voteEvents.length, delegations: this.delegationEvents.length, checkpoints: [...this.checkpoints.values()] }; }
  async syncStatus(daoId) { return [...this.checkpoints.values()].filter((x) => x.daoId === daoId); }
}
module.exports = { MemoryGovernanceStore, eventKey, encodeCursor, decodeCursor, encodeProposalCursor, decodeProposalCursor };
