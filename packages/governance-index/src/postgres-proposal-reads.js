const { presentProposal } = require("../../core/src/governance/lifecycle");
const { decodeProposalCursor, encodeProposalCursor } = require("./memory-store");

function proposalCursor(value) {
  if (!value) return null;
  return typeof value === "string" && /^\d+$/.test(value) ? value : decodeProposalCursor(value);
}

function patchProposalReads(Store) {
  if (!Store || Store.prototype.__gavelLifecycleReads) return Store;
  Store.prototype.__gavelLifecycleReads = true;

  Store.prototype.getProposal = async function getProposal(daoId, id) {
    const row = (await this.pool.query(`
      SELECT normalized, proposal_status AS "proposalStatus", outcome,
        effective_status AS "effectiveStatus", tracking_state AS "trackingState",
        lifecycle_reason AS "lifecycleReason"
      FROM proposals WHERE dao_id=$1 AND proposal_id=$2
    `, [daoId, id])).rows[0];
    return row ? presentProposal(row.normalized, row) : null;
  };

  Store.prototype.listProposals = async function listProposals({ daoId, limit, cursor }) {
    const decoded = proposalCursor(cursor);
    const params = [daoId, limit + 1];
    let where = "dao_id=$1";
    if (decoded) {
      params.push(decoded);
      where += " AND proposal_id < $3";
    }
    const rows = (await this.pool.query(`
      SELECT proposal_id::text AS "proposalId",normalized,
        proposal_status AS "proposalStatus", outcome,
        effective_status AS "effectiveStatus", tracking_state AS "trackingState",
        lifecycle_reason AS "lifecycleReason"
      FROM proposals WHERE ${where} ORDER BY proposal_id DESC LIMIT $2
    `, params)).rows;
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => presentProposal(row.normalized, row));
    return { items, nextCursor: more ? encodeProposalCursor(rows[limit - 1].proposalId) : null };
  };

  return Store;
}

module.exports = { patchProposalReads };
