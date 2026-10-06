import { Link } from 'react-router-dom';
import type { IndexedProposal } from '../index-api';
import type { DaoDefinition } from '../daos';
import { paths } from '../routes';
import { formatDateTime, shortenAddress } from '../format';

/**
 * One governance activity row. Cards, not table rows, so it reads on a phone.
 *
 * The status chip shows only the index's derived `effectiveStatus`. A raw
 * source state is never promoted into it; when the index has no verdict the
 * chip says "Status pending" rather than guessing.
 *
 * The provenance line marks the row as an onchain fact from the index. A
 * future provenance model (block, tx, indexed-at) extends this one line; a
 * Gavel analysis or external signal gets its own marker, never this one.
 */
export function StatusChip({ status }: { status: string | null }) {
  const tone = !status
    ? 'unknown'
    : ['ACTIVE', 'PENDING', 'SPONSORING', 'QUEUED', 'OBJECTION_PERIOD', 'UPDATABLE'].includes(status)
      ? 'live'
      : ['EXECUTED', 'SUCCEEDED'].includes(status)
        ? 'good'
        : 'closed';
  return (
    <span className={`status-chip status-${tone}`} data-status={status ?? 'unknown'}>
      {status ? status.replace(/_/g, ' ').toLowerCase() : 'status pending'}
    </span>
  );
}

export function ProposalCard({ proposal, dao, showDao = false }: { proposal: IndexedProposal; dao: DaoDefinition; showDao?: boolean }) {
  return (
    <li className="activity-card">
      <div className="activity-meta">
        {showDao ? (
          <Link className="activity-dao" to={paths.dao(dao.id)}>
            {dao.name}
          </Link>
        ) : null}
        <span className="activity-id">#{proposal.id.length > 12 ? `${proposal.id.slice(0, 6)}…${proposal.id.slice(-4)}` : proposal.id}</span>
        <StatusChip status={proposal.effectiveStatus} />
      </div>
      <h3 className="activity-title">
        <Link to={paths.proposal(dao.id, proposal.id)}>{proposal.title}</Link>
      </h3>
      <p className="activity-foot">
        {proposal.createdAt ? <span>Created {formatDateTime(proposal.createdAt)}</span> : null}
        {proposal.proposer ? <span>by {shortenAddress(proposal.proposer)}</span> : null}
        <span className="provenance" data-origin={proposal.provenance.origin} title="Onchain fact, read from the Gavel Governance Indexer">
          onchain · index
        </span>
      </p>
    </li>
  );
}
